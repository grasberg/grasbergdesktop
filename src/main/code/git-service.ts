/**
 * Git operations for Code mode — the ONLY module in the app that spawns
 * MUTATING git commands.
 *
 * SAFETY INVARIANTS (non-negotiable, mirrored in tests):
 * - Every spawn is execFile('git'|'gh', argv) — no shell, ever. Model- or
 *   user-supplied text (paths, messages, branch names) always travels as a
 *   single argv element behind a '--' separator where git accepts one, so it
 *   can never be parsed as a flag or a subcommand.
 * - Paths are re-validated (relative, no '..', no leading '-') before use.
 * - Reached from exactly two consenting paths: the code:git:* IPC handlers
 *   (an explicit user click IS the consent) and the git_write tool (whose
 *   every call the user approves — it carries noStandingApproval).
 * - Remote writes never force-push; pulls are fast-forward-only and require a
 *   clean worktree. Default-branch pushes require an explicit confirmation.
 */

import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type {
  GitFileChange,
  GitHubPrInput,
  GitHubPrResult,
  GitStatus,
  WorktreeInfo,
} from '@shared/types'
import { ProviderError } from '../providers/errors'
import { redactSecrets } from '../providers/redact'

const GIT_TIMEOUT_MS = 20_000
const GITHUB_TIMEOUT_MS = 30_000
const GIT_MAX_OUTPUT = 512 * 1024
/** Diff fed to the commit-message model, capped. */
const COMMIT_MESSAGE_DIFF_MAX_CHARS = 48_000

/** Branch names we accept before handing to check-ref-format semantics. */
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/

function invalid(message: string): ProviderError {
  return new ProviderError('invalid_request', message)
}

interface GitRunResult {
  ok: boolean
  stdout: string
  stderr: string
}

function safeCommandError(text: string): string {
  return redactSecrets(text).replace(/([a-z][\w+.-]*:\/\/)[^@\s/]+@/gi, '$1[redacted]@')
}

function runCommand(
  command: 'git' | 'gh',
  argv: string[],
  root: string,
  timeout: number
): Promise<GitRunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      argv,
      {
        cwd: root,
        timeout,
        maxBuffer: GIT_MAX_OUTPUT,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          ...(command === 'gh' ? { GH_PROMPT_DISABLED: '1' } : {}),
        },
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolvePromise({
            ok: false,
            stdout: '',
            stderr: `${command} is not installed or not on PATH.`,
          })
          return
        }
        if (error && error.killed) {
          resolvePromise({ ok: false, stdout: '', stderr: `${command} timed out.` })
          return
        }
        resolvePromise({
          ok: !error,
          stdout: stdout ?? '',
          stderr: safeCommandError((stderr ?? '').trim()),
        })
      }
    )
  })
}

/** Runs `git <argv>` in `root` (no shell, hidden window, capped output). */
function runGit(argv: string[], root: string): Promise<GitRunResult> {
  const finalArgv = process.platform === 'win32' ? ['-c', 'core.longpaths=true', ...argv] : argv
  return runCommand('git', finalArgv, root, GIT_TIMEOUT_MS)
}

function runGithub(argv: string[], root: string): Promise<GitRunResult> {
  return runCommand('gh', argv, root, GITHUB_TIMEOUT_MS)
}

/**
 * SECURITY: a path handed to a mutating git command must be relative, inside
 * the repo (no '..'), and must not start with '-' (argv-option smuggling —
 * even behind '--' we refuse it for defense in depth).
 */
function validateRelPath(relPath: string): string {
  const rel = relPath.trim()
  if (rel.length === 0) throw invalid('File path is required.')
  if (rel.startsWith('-')) throw invalid('File paths must not start with "-".')
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\')) {
    throw invalid('File paths must be relative to the project root.')
  }
  if (rel.split(/[\\/]+/).includes('..')) throw invalid('File paths must not contain "..".')
  return rel
}

function validateRemoteUrl(value: string): string {
  const remote = value.trim()
  if (remote.length === 0 || remote.length > 2_000 || /[\r\n\0]/.test(remote)) {
    throw invalid('Remote URL is invalid.')
  }
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(remote)) return remote
  let parsed: URL
  try {
    parsed = new URL(remote)
  } catch {
    throw invalid('Remote must be an HTTPS or SSH git URL.')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') {
    throw invalid('Remote must use HTTPS or SSH.')
  }
  if (!parsed.hostname || parsed.password || (parsed.protocol === 'https:' && parsed.username)) {
    throw invalid('Remote URL must not contain embedded credentials.')
  }
  return remote
}

/** Parses `git status --porcelain=v1 -z` output into staged/unstaged/untracked. */
export function parsePorcelainStatus(raw: string): {
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: string[]
} {
  const staged: GitFileChange[] = []
  const unstaged: GitFileChange[] = []
  const untracked: string[] = []
  // -z: NUL-separated records; a rename carries a second NUL-separated path.
  const records = raw.split('\0').filter((r) => r.length > 0)
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (record.length < 4) continue
    const x = record[0]
    const y = record[1]
    const path = record.slice(3)
    if (x === '?' && y === '?') {
      untracked.push(path)
      continue
    }
    // A rename/copy in EITHER column carries the source path as the next
    // record; leaving it in the stream would parse it as a status record.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i += 1
    if (x !== ' ' && x !== '?') staged.push({ path, status: x })
    if (y !== ' ' && y !== '?') unstaged.push({ path, status: y })
  }
  return { staged, unstaged, untracked }
}

/**
 * How an editor is launched. Windows ships VS Code/Cursor as .cmd shims, which
 * execFile cannot spawn at all (ENOENT) — they need cmd.exe.
 *
 * SECURITY: the command name is one of three allowlisted literals and every
 * argument is quoted, with the command line handed to cmd.exe verbatim — so a
 * folder path holding cmd metacharacters ('&', '|', …) stays one literal
 * argument. shell:true would splice the arguments in unquoted; never use it.
 * (The command name itself must stay UNQUOTED: a quoted one makes the .cmd
 * shim resolve its own directory against the cwd and fail.)
 */
export function editorSpawn(
  command: string,
  root: string,
  platform: NodeJS.Platform = process.platform
): { file: string; argv: string[]; verbatim: boolean } {
  const args = command === 'zed' ? [root] : ['-n', root]
  if (platform !== 'win32') return { file: command, argv: args, verbatim: false }
  if (root.includes('"')) throw invalid('This folder path cannot be opened in an editor.')
  const line = [command, ...args.map((arg) => `"${arg}"`)].join(' ')
  return { file: 'cmd.exe', argv: ['/d', '/s', '/c', line], verbatim: true }
}

export interface GitServiceOptions {
  /**
   * One-shot text generation for commit-message suggestions (wired to
   * ChatService.generateForWorkflow — headless, default model, no tools).
   * Absent => generateCommitMessage reports unavailable.
   */
  generateText?: (prompt: string) => Promise<string>
  beforeCommit?: (root: string) => Promise<void>
  /** Test seam for GitHub CLI; production uses execFile('gh', argv). */
  githubCommand?: (argv: string[], root: string) => Promise<GitRunResult>
}

export class GitService {
  constructor(private readonly options: GitServiceOptions = {}) {}

  /** Creates an isolated worktree beneath the app-owned data directory. */
  async createWorktree(
    root: string,
    worktreesDir: string,
    projectId: string,
    requestedName?: string
  ): Promise<WorktreeInfo> {
    const suffix = Date.now().toString(36)
    const base = (requestedName?.trim() || `agent-${suffix}`)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || `agent-${suffix}`
    const branch = `grasberg/${base}-${suffix}`
    if (!BRANCH_NAME_RE.test(branch)) throw invalid('Invalid worktree branch name.')
    mkdirSync(worktreesDir, { recursive: true })
    const target = join(worktreesDir, `${projectId}-${base}-${suffix}`)
    const result = await runGit(['worktree', 'add', '-b', branch, target, 'HEAD'], root)
    if (!result.ok) throw invalid(`git worktree add failed: ${result.stderr || 'unknown error'}`)
    return { path: target, branch, projectId }
  }

  /** Opens a project/worktree in a supported editor without invoking a shell. */
  async openInEditor(
    root: string,
    preferred: 'auto' | 'code' | 'cursor' | 'zed'
  ): Promise<{ command: string }> {
    const commands = preferred === 'auto' ? ['code', 'cursor', 'zed'] : [preferred]
    for (const command of commands) {
      const { file, argv, verbatim } = editorSpawn(command, root)
      const ok = await new Promise<boolean>((resolvePromise) => {
        execFile(
          file,
          argv,
          { windowsHide: true, windowsVerbatimArguments: verbatim },
          (error) => resolvePromise(!error)
        )
      })
      if (ok) return { command }
    }
    throw invalid('No supported editor command was found (tried VS Code, Cursor and Zed).')
  }

  /** Full working-tree status for the commit bar. Cheap, read-only. */
  async status(root: string): Promise<GitStatus> {
    const inside = await runGit(['rev-parse', '--is-inside-work-tree'], root)
    if (!inside.ok || inside.stdout.trim() !== 'true') {
      return {
        isRepo: false,
        branch: null,
        defaultBranch: null,
        detached: false,
        ahead: 0,
        behind: 0,
        hasOrigin: false,
        upstream: null,
        staged: [],
        unstaged: [],
        untracked: [],
      }
    }
    const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root)
    // 'HEAD' means detached; an error usually means an unborn branch.
    const branchRaw = branchRes.ok ? branchRes.stdout.trim() : null
    const detached = branchRaw === 'HEAD'
    const branch = branchRaw && !detached ? branchRaw : null

    const defaultBranch = await this.defaultBranch(root)

    const origin = await runGit(['remote', 'get-url', 'origin'], root)
    const hasOrigin = origin.ok
    const upstreamRes = await runGit(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      root
    )
    const upstream = upstreamRes.ok ? upstreamRes.stdout.trim() || null : null

    let ahead = 0
    let behind = 0
    const counts = await runGit(
      ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
      root
    )
    if (counts.ok) {
      const match = /^(\d+)\s+(\d+)/.exec(counts.stdout.trim())
      if (match) {
        behind = Number(match[1])
        ahead = Number(match[2])
      }
    }

    const statusRes = await runGit(['status', '--porcelain=v1', '-z'], root)
    const files = statusRes.ok
      ? parsePorcelainStatus(statusRes.stdout)
      : { staged: [], unstaged: [], untracked: [] }

    return {
      isRepo: true,
      branch,
      defaultBranch,
      detached,
      ahead,
      behind,
      hasOrigin,
      upstream,
      ...files,
    }
  }

  /** Updates origin's remote refs without modifying the worktree. */
  async fetch(root: string): Promise<GitStatus> {
    const status = await this.status(root)
    if (!status.isRepo) throw invalid('The selected folder is not a git repository.')
    if (!status.hasOrigin) throw invalid("This repository has no 'origin' remote.")
    const result = await runGit(['fetch', '--prune', 'origin'], root)
    if (!result.ok) throw invalid(`git fetch failed: ${result.stderr || 'unknown error'}`)
    return this.status(root)
  }

  /** Adds origin, or replaces its URL, without contacting the remote. */
  async setOrigin(root: string, url: string): Promise<GitStatus> {
    const remote = validateRemoteUrl(url)
    const status = await this.status(root)
    if (!status.isRepo) throw invalid('The selected folder is not a git repository.')
    const argv = status.hasOrigin
      ? ['remote', 'set-url', 'origin', remote]
      : ['remote', 'add', 'origin', remote]
    const result = await runGit(argv, root)
    if (!result.ok) throw invalid(`Setting origin failed: ${result.stderr || 'unknown error'}`)
    return this.status(root)
  }

  /** Fast-forward-only pull; dirty worktrees are refused before contacting git. */
  async pull(root: string): Promise<GitStatus> {
    const status = await this.status(root)
    if (!status.isRepo) throw invalid('The selected folder is not a git repository.')
    if (!status.upstream) throw invalid('The current branch has no upstream. Push it first.')
    if (status.staged.length || status.unstaged.length || status.untracked.length) {
      throw invalid('Pull requires a clean working tree. Commit, stash or discard local changes first.')
    }
    const result = await runGit(['pull', '--ff-only'], root)
    if (!result.ok) throw invalid(`git pull --ff-only failed: ${result.stderr || 'unknown error'}`)
    return this.status(root)
  }

  /** Pushes the current branch, setting origin as upstream on its first push. */
  async push(root: string, confirmDefaultBranch = false): Promise<GitStatus> {
    const status = await this.status(root)
    if (!status.isRepo) throw invalid('The selected folder is not a git repository.')
    if (!status.hasOrigin) throw invalid("This repository has no 'origin' remote.")
    if (!status.branch || status.detached) throw invalid('Cannot push a detached or unborn HEAD.')
    if (status.branch === status.defaultBranch && !confirmDefaultBranch) {
      throw invalid(`Pushing the default branch '${status.branch}' requires explicit confirmation.`)
    }
    const argv = status.upstream
      ? ['push']
      : ['push', '--set-upstream', 'origin', status.branch]
    const result = await runGit(argv, root)
    if (!result.ok) throw invalid(`git push failed: ${result.stderr || 'unknown error'}`)
    return this.status(root)
  }

  /** Creates a GitHub pull request for the already-pushed current branch. */
  async createPullRequest(root: string, input: GitHubPrInput): Promise<GitHubPrResult> {
    const status = await this.status(root)
    if (!status.isRepo || !status.hasOrigin) {
      throw invalid("A git repository with an 'origin' remote is required.")
    }
    if (!status.branch || status.detached) throw invalid('A named branch is required for a pull request.')
    if (!status.upstream || status.ahead > 0) {
      throw invalid('Push the current branch before creating the pull request.')
    }
    const title = input.title.trim()
    if (!title) throw invalid('Pull-request title must not be empty.')
    if (title.length > 200) throw invalid('Pull-request title is too long (max 200 characters).')
    if ((input.body?.length ?? 0) > 20_000) {
      throw invalid('Pull-request body is too long (max 20000 characters).')
    }
    if (input.base && !BRANCH_NAME_RE.test(input.base)) {
      throw invalid('The pull-request base branch name is invalid.')
    }
    const argv = ['pr', 'create', '--title', title, '--body', input.body?.trim() ?? '']
    if (input.base) argv.push('--base', input.base)
    if (input.draft) argv.push('--draft')
    const result = await (this.options.githubCommand ?? runGithub)(argv, root)
    if (!result.ok) {
      throw invalid(`GitHub pull request failed: ${result.stderr || 'unknown error'}`)
    }
    const url = result.stdout.trim().split(/\r?\n/).findLast((line) => /^https:\/\//i.test(line))
    if (!url) throw invalid('GitHub CLI completed without returning a pull-request URL.')
    return { url }
  }

  /** Stages the given relative paths (`git add -- <paths>`). */
  async stage(root: string, paths: string[]): Promise<string> {
    const validated = this.validatePaths(paths)
    const result = await runGit(['add', '--', ...validated], root)
    if (!result.ok) throw invalid(`git add failed: ${result.stderr || 'unknown error'}`)
    return `Staged ${validated.length} ${validated.length === 1 ? 'file' : 'files'}.`
  }

  /** Unstages the given relative paths (`git restore --staged -- <paths>`). */
  async unstage(root: string, paths: string[]): Promise<string> {
    const validated = this.validatePaths(paths)
    let result = await runGit(['restore', '--staged', '--', ...validated], root)
    if (!result.ok && /could not resolve/i.test(result.stderr)) {
      // Unborn HEAD (no commits yet): restore has nothing to restore from;
      // removing from the index is the correct unstage there.
      result = await runGit(['rm', '--cached', '-r', '--quiet', '--', ...validated], root)
    }
    if (!result.ok) throw invalid(`git restore failed: ${result.stderr || 'unknown error'}`)
    return `Unstaged ${validated.length} ${validated.length === 1 ? 'file' : 'files'}.`
  }

  /**
   * Commits what is staged. The message is ONE argv element — never shell-
   * parsed. Refuses an empty message and an empty index (clear errors beat
   * git's own).
   */
  async commit(root: string, message: string): Promise<{ sha: string; branch: string | null }> {
    const trimmed = message.trim()
    if (trimmed.length === 0) throw invalid('Commit message must not be empty.')
    if (trimmed.length > 5000) throw invalid('Commit message is too long (max 5000 characters).')
    await this.options.beforeCommit?.(root)

    const stagedCheck = await runGit(['diff', '--cached', '--name-only'], root)
    if (stagedCheck.ok && stagedCheck.stdout.trim().length === 0) {
      throw invalid('Nothing is staged — stage files first.')
    }

    const result = await runGit(['commit', '-m', trimmed], root)
    if (!result.ok) throw invalid(`git commit failed: ${result.stderr || 'unknown error'}`)
    const sha = await runGit(['rev-parse', '--short', 'HEAD'], root)
    const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root)
    return {
      sha: sha.ok ? sha.stdout.trim() : 'unknown',
      branch: branch.ok && branch.stdout.trim() !== 'HEAD' ? branch.stdout.trim() : null,
    }
  }

  /** Creates and switches to a new branch (`git switch -c <name>`). */
  async createBranch(root: string, name: string): Promise<string> {
    const trimmed = name.trim()
    if (!BRANCH_NAME_RE.test(trimmed)) {
      throw invalid(
        'Branch names may contain letters, digits, ".", "_", "/" and "-", and must start with a letter or digit.'
      )
    }
    const checked = await runGit(['check-ref-format', '--branch', trimmed], root)
    if (!checked.ok) throw invalid(`'${trimmed}' is not a valid branch name.`)
    const result = await runGit(['switch', '-c', trimmed], root)
    if (!result.ok) throw invalid(`git switch failed: ${result.stderr || 'unknown error'}`)
    return `Created and switched to branch '${trimmed}'.`
  }

  /**
   * Suggests a conventional-commit-style message from the staged diff via the
   * default model (headless one-shot). Pure suggestion — the user edits it in
   * the commit bar before committing.
   */
  async generateCommitMessage(root: string): Promise<{ message: string }> {
    const generate = this.options.generateText
    if (!generate) {
      throw new ProviderError('not_supported', 'Commit-message generation is unavailable here.')
    }
    const diff = await runGit(['diff', '--cached'], root)
    if (!diff.ok || diff.stdout.trim().length === 0) {
      throw invalid('Nothing is staged — stage files first.')
    }
    const capped =
      diff.stdout.length > COMMIT_MESSAGE_DIFF_MAX_CHARS
        ? `${diff.stdout.slice(0, COMMIT_MESSAGE_DIFF_MAX_CHARS)}\n…[diff truncated]`
        : diff.stdout
    const text = await generate(
      'Write ONE git commit message for the staged diff below: a conventional-commit style ' +
        'subject line under 72 characters (e.g. "fix: …", "feat: …"), optionally followed by a ' +
        'blank line and a short body. Output ONLY the commit message, no quotes, no fences.\n\n' +
        capped
    )
    const message = text.trim().replace(/^```[a-z]*\n?|```$/g, '').trim()
    if (message.length === 0) throw invalid('The model produced no message — write one manually.')
    return { message: message.slice(0, 5000) }
  }

  // -- internals --------------------------------------------------------------

  private validatePaths(paths: string[]): string[] {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw invalid('Provide at least one file path.')
    }
    if (paths.length > 200) throw invalid('Too many paths (max 200 per call).')
    return paths.map(validateRelPath)
  }

  /**
   * The repo's default branch: origin/HEAD when a remote exists, else the
   * first of main/master that exists locally, else null. Heuristic — the
   * approval note always states the ACTUAL branch, so the human is the
   * backstop.
   */
  private async defaultBranch(root: string): Promise<string | null> {
    const originHead = await runGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root)
    if (originHead.ok) {
      const name = originHead.stdout.trim().replace(/^origin\//, '')
      if (name.length > 0) return name
    }
    for (const candidate of ['main', 'master']) {
      const exists = await runGit(
        ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`],
        root
      )
      if (exists.ok) return candidate
    }
    return null
  }
}
