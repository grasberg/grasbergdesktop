/**
 * Git operations for Code mode — the ONLY module in the app that spawns
 * MUTATING git commands.
 *
 * SAFETY INVARIANTS (non-negotiable, mirrored in tests):
 * - Every spawn is execFile('git', argv) — no shell, ever. Model- or
 *   user-supplied text (paths, messages, branch names) always travels as a
 *   single argv element behind a '--' separator where git accepts one, so it
 *   can never be parsed as a flag or a subcommand.
 * - Paths are re-validated (relative, no '..', no leading '-') before use.
 * - Reached from exactly two consenting paths: the code:git:* IPC handlers
 *   (an explicit user click IS the consent) and the git_write tool (whose
 *   every call the user approves — it carries noStandingApproval).
 * - No remote operations in Stage 1: this module cannot push or pull.
 */

import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import type { GitFileChange, GitStatus } from '@shared/types'
import { ProviderError } from '../providers/errors'

const GIT_TIMEOUT_MS = 20_000
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

/** Runs `git <argv>` in `root` (no shell, hidden window, capped output). */
function runGit(argv: string[], root: string): Promise<GitRunResult> {
  const finalArgv = process.platform === 'win32' ? ['-c', 'core.longpaths=true', ...argv] : argv
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      finalArgv,
      {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolvePromise({ ok: false, stdout: '', stderr: 'git is not installed or not on PATH.' })
          return
        }
        if (error && error.killed) {
          resolvePromise({ ok: false, stdout: '', stderr: 'git timed out.' })
          return
        }
        resolvePromise({ ok: !error, stdout: stdout ?? '', stderr: (stderr ?? '').trim() })
      }
    )
  })
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
    if (x === 'R' || x === 'C') i += 1 // consume the rename/copy source record
    if (x !== ' ' && x !== '?') staged.push({ path, status: x })
    if (y !== ' ' && y !== '?') unstaged.push({ path, status: y })
  }
  return { staged, unstaged, untracked }
}

export interface GitServiceOptions {
  /**
   * One-shot text generation for commit-message suggestions (wired to
   * ChatService.generateForWorkflow — headless, default model, no tools).
   * Absent => generateCommitMessage reports unavailable.
   */
  generateText?: (prompt: string) => Promise<string>
}

export class GitService {
  constructor(private readonly options: GitServiceOptions = {}) {}

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

    return { isRepo: true, branch, defaultBranch, detached, ahead, behind, ...files }
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
