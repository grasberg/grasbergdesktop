/**
 * ToolExecutor — runs a single model-issued tool call and ALWAYS returns a
 * string result (the model needs feedback on every path; this method never
 * throws). Denials, validation failures, IO errors and timeouts all come back
 * as readable strings, redacted of anything secret-looking.
 *
 * SAFETY INVARIANTS (non-negotiable, mirrored in tests):
 * - 'propose_shell_command' NEVER executes anything (suggestion only).
 * - 'run_shell_command' DOES execute, but only when the user opted into shell
 *   execution (shellEnabled) AND approved the specific call; it runs in the
 *   granted project folder with a timeout and output caps. It is the sole
 *   execution path and is filtered out of the tool list when disabled.
 * - This module never writes to any user file directly (read-only fs access).
 * - File access is confined to the conversation's granted project root;
 *   path traversal and symlinked escapes are rejected.
 * - Sensitive tools require the user's explicit approval per call unless the
 *   user chose 'always_allow'; 'deny' short-circuits without running.
 *
 * Intended wiring (integration agent): when the chat stream yields a
 * tool_call, call executor.execute(toolCall, { conversation, streamId,
 * approval }) where `approval` broadcasts CHANNELS.toolApprovalRequest with a
 * fresh requestId and resolves with the renderer's toolsApprovalRespond
 * answer. Persist the returned string as the ToolCallRecord result and feed
 * it back to the provider as a role-'tool' message.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  Attachment,
  Conversation,
  GitStatus,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRecurrence,
  ToolApprovalAnswer,
  ToolApprovalRequest,
  ToolCallRecord,
  ToolDefinition,
} from '@shared/types'
import type { CodeReadFileResult } from '@shared/ipc'
import { encodeTaskList, type TaskListItem } from '@shared/tasklist'
import { redactKnownSecrets, redactSecrets } from '../providers/redact'
import { looksBinary } from '../utils/binary'
import { capToolResult } from './definitions'
import { customToolHeaders } from './custom-tools'
import { isMcpToolId } from './mcp/naming'
import { runShell } from './shell'
import { commandMatchesAllowlist } from './shell-allowlist'
import { runGitQuery } from './git'
import { formatLocalRunTime, resolveFirstRun } from '../scheduled-tasks/resolve'
import type { ToolRegistry } from './registry'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Structural subset of the code-mode service the executor relies on.
 * src/main/code/code-service.ts CodeService satisfies this directly
 * (sync or async implementations both work; results are awaited).
 */
export interface ToolCodeService {
  readFile(projectId: string, relPath: string): CodeReadFileResult | Promise<CodeReadFileResult>
}

/** Structural subset of the repo-map service used by the executor. */
export interface ToolRepoMap {
  search(
    projectId: string,
    root: string,
    query: string,
    maxResults: number
  ): Promise<Array<{ relPath: string; score: number; symbols: string[] }>>
}

/** Structural subset of the embedded browser used by the browser/computer tools. */
export interface ToolBrowser {
  navigate(url: string): Promise<string>
  readPage(): Promise<string>
  back(): Promise<string>
  clickSelector(selector: string, byText: boolean): Promise<string>
  typeText(selector: string, text: string): Promise<string>
  computer(action: string, coordinate?: [number, number], text?: string): Promise<string>
}

export interface ToolExecutorDeps {
  registry: ToolRegistry
  /** Optional: when present, read_file goes through it (shared size limits). */
  codeService?: ToolCodeService | null
  /** Optional: when present, repo_map ranks project files for a query. */
  repoMap?: ToolRepoMap | null
  /** Optional: routes 'mcp__…' tool calls to the connected MCP server. */
  mcpClient?: { callTool(toolId: string, args: Record<string, unknown>): Promise<string> } | null
  /** Whether run_shell_command may actually execute (user opt-in). */
  shellEnabled?: () => boolean
  /**
   * Command prefixes that skip the per-call approval dialog (still requires
   * shellEnabled; a 'deny' permission still wins). See shell-allowlist.ts.
   */
  shellAllowlist?: () => string[]
  /**
   * Long-running shell jobs (run_shell_command background=true): start()
   * returns a model-readable note with the task id, pollable via task_output
   * and stoppable via task_stop. Absent => background runs are refused.
   */
  shellBackground?: { start(command: string, cwd: string): string } | null
  /** Whether the browser/computer tools may run (user opt-in). */
  browserEnabled?: () => boolean
  /** Embedded browser for the browser/computer tools. */
  browser?: ToolBrowser | null
  /** Knowledge-base retrieval for the 'knowledge_search' tool. */
  knowledgeSearch?: (
    knowledgeBaseId: string,
    query: string
  ) => Promise<Array<{ source: string; content: string; score: number }>>
  /** Runs a sub-agent for the 'delegate' tool (wired to ChatService.runDelegate). */
  delegate?: (task: string, ctx: ToolExecuteContext, agentName?: string) => Promise<string>
  /**
   * Text-to-image for the 'generate_image' tool (wired to
   * ChatService.generateImage). Returns the stored image attachments.
   */
  imageGeneration?: {
    generate(req: {
      prompt: string
      count?: number
      size?: 'auto' | 'square' | 'landscape' | 'portrait'
    }): Promise<Attachment[]>
  } | null
  /**
   * Local git writes for the 'git_write' tool (wired to GitService — the only
   * module that spawns mutating git). Every call is user-approved first.
   */
  gitWrite?: {
    status(root: string): Promise<GitStatus>
    stage(root: string, paths: string[]): Promise<string>
    commit(root: string, message: string): Promise<{ sha: string; branch: string | null }>
    createBranch(root: string, name: string): Promise<string>
  } | null
  /** Background sub-agent tasks (delegate background=true + task_output/task_stop). */
  delegateBackground?: {
    start(task: string, ctx: ToolExecuteContext, agentName?: string): string
    output(taskId: string): string
    stop(taskId: string): string
  } | null
  /**
   * Approval-gated project writes for edit_file/write_file. propose() records
   * a CodeChange row (diff + staleness baseline); apply() is the app's single
   * audited write path into a project. Absent => the tools report unavailable.
   */
  codeChanges?: {
    propose(
      conversationId: string,
      relPath: string,
      changeType: 'create' | 'edit',
      newContent: string
    ): { id: string } | Promise<{ id: string }>
    apply(changeId: string): unknown
  } | null
  /** Persists the conversation task list (update_task_list). */
  taskList?: { update(conversationId: string, markdown: string): string } | null
  /**
   * Standalone scheduled tasks for the 'schedule_task' tool (wired to
   * db.scheduledTasks; the repository satisfies this directly). Absent =>
   * the tool reports itself unavailable.
   */
  scheduledTasks?: {
    create(input: ScheduledTaskInput): ScheduledTask
    list(): ScheduledTask[]
    getById(id: string): ScheduledTask | null
    remove(id: string): void
    /** Fresh conversation → linked projectId (tasks inherit the folder). */
    conversationProjectId(conversationId: string): string | null
    /** projectId → absolute path, for result/approval texts. */
    projectPath(projectId: string): string | null
  } | null
  /**
   * Lazily creates + links a Work task's own workspace folder (registered as
   * a code_projects row) so edit_file/write_file work without a user-granted
   * folder. Absent => the tools require an explicitly granted folder.
   */
  ensureWorkspaceRoot?: ((conversationId: string) => { projectId: string; root: string }) | null
  /** Skill lookup for the 'use_skill' tool (wired to db.skills). */
  skills?: {
    getEnabledByName(name: string): { name: string; content: string } | null
    listEnabledNames(): string[]
  } | null
  /** Absolute path of the project folder granted to this conversation, or null. */
  getProjectRoot: (conversation: Conversation) => string | null
  /**
   * Resolves a custom tool's SECRET headers (name -> decrypted value). Wired in
   * main to decrypt from the secrets store; omit in tests to inject fakes. The
   * returned values are merged over the tool's non-secret headers and are also
   * added to the redaction set so they never leak into results.
   */
  resolveSecretHeaders?: (toolId: string) => Record<string, string>
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export interface ToolExecuteContext {
  conversation: Conversation
  /** Stream this call belongs to (forwarded into the approval request). */
  streamId?: string
  /**
   * Asks the user. The answer carries approved plus a scope: 'conversation'
   * also auto-approves the tool's future calls in this conversation.
   * The integration layer generates the requestId and routes the answer.
   */
  approval: (req: Omit<ToolApprovalRequest, 'requestId'>) => Promise<ToolApprovalAnswer>
  /** Shows an ask_user_question dialog; null = dismissed/unanswered. */
  askUser?: (question: string, options: string[]) => Promise<string | null>
  /**
   * The active stream's abort signal (Stop / app quit). Long-running tools
   * honour it: run_shell_command kill-trees its child instead of blocking the
   * stream loop until the command's own timeout.
   */
  signal?: AbortSignal
  /** Plan mode (code conversations): mutating tools are refused. */
  planMode?: boolean
  /** Auto-accept edits: edit_file/write_file skip the approval dialog. */
  autoAcceptEdits?: boolean
  /** Receives live output chunks from long-running tools (shell commands). */
  onToolOutput?: (toolCallId: string, chunk: string) => void
  /**
   * Receives each image the generate_image tool stored, so the caller can
   * attach it to the assistant message and stream it to the renderer.
   * Absent (delegate/workflow loops) => the tool reports itself unavailable.
   */
  onAttachment?: (attachment: Attachment) => void
}

export const USER_DECLINED_RESULT = 'User declined this tool call.'

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 15_000
const FETCH_MAX_BYTES = 512 * 1024
const SEARCH_CONTENT_MAX_BYTES = 256 * 1024
const READ_FILE_MAX_BYTES = 512 * 1024
const SEARCH_DEFAULT_RESULTS = 20
const SEARCH_MAX_RESULTS = 50
const SEARCH_LINE_MAX_CHARS = 240
const WALK_MAX_ENTRIES = 20_000
const WALK_MAX_DEPTH = 24
const SHELL_TIMEOUT_MS = 60_000
/** run_shell_command timeoutSeconds is clamped to [1, this]. */
const SHELL_MAX_TIMEOUT_SEC = 600
const GREP_DEFAULT_RESULTS = 40
const GREP_MAX_RESULTS = 100
/** Wall-clock budget for one grep scan (the match runs on the main thread). */
const GREP_TIME_BUDGET_MS = 5_000
const GLOB_DEFAULT_RESULTS = 50
const GLOB_MAX_RESULTS = 200
const WEB_SEARCH_DEFAULT_RESULTS = 5
const WEB_SEARCH_MAX_RESULTS = 10
/** edit_file needs the FULL file; larger files must go through uld-change. */
const EDIT_FILE_MAX_BYTES = 512 * 1024

/** Directory names skipped while walking (dependency/build/VCS noise). */
const IGNORED_DIR_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.idea',
  '.vscode',
  '.DS_Store',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') return 'Request timed out.'
    return e.message
  }
  return String(e)
}

/**
 * Resolves `relPath` against `root` and returns the absolute path only when
 * it stays inside the root. Absolute and drive-relative inputs are rejected.
 */
function resolveWithinRoot(root: string, relPath: string): string | null {
  if (relPath.includes('\0')) return null
  if (path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) return null
  const normalizedRoot = path.resolve(root)
  const target = path.resolve(normalizedRoot, relPath)
  const rel = path.relative(normalizedRoot, target)
  if (rel === '') return normalizedRoot
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return target
}

/**
 * resolveWithinRoot + the standard refusal message: [absPath, null] when the
 * path stays inside the root, ['', refusal] when it escapes (callers must
 * return the refusal before using the path).
 */
function resolveWithinRootOrRefuse(
  root: string,
  relPath: string
): [absPath: string, refusal: string | null] {
  const absPath = resolveWithinRoot(root, relPath)
  if (absPath === null) {
    return ['', `Error: '${relPath}' is outside the granted project folder; access refused.`]
  }
  return [absPath, null]
}

/**
 * Symlink-safe containment check. `resolveWithinRoot` only does string math, so
 * an in-project symlink (e.g. `link -> /`) whose textual path stays under the
 * root would still let `fs.readdir`/`fs.readFile` follow it OUT of the root.
 * This re-asserts containment after canonicalising both the root and the target
 * with `fs.realpath`, mirroring CodeService.realInsideRoot. Returns a refusal
 * string when the resolved target escapes, or null when it is contained (or
 * does not exist yet — the caller's fs op then surfaces the natural error; a
 * non-existent path cannot be a traversal symlink).
 */
async function assertRealContained(
  root: string,
  absPath: string,
  relPath: string
): Promise<string | null> {
  let real: string
  try {
    real = await fs.realpath(absPath)
  } catch {
    return null
  }
  let realRoot: string
  try {
    realRoot = await fs.realpath(path.resolve(root))
  } catch {
    realRoot = path.resolve(root)
  }
  const rel = path.relative(realRoot, real)
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
    return `Error: '${relPath}' resolves (via a symlink) outside the granted project folder; access refused.`
  }
  return null
}

const MAX_FETCH_REDIRECTS = 5

type Ipv4 = [number, number, number, number]

/** One IPv4 part: decimal, 0-prefixed octal or 0x-prefixed hex (as URL parsers read them). */
function parseIpv4Part(part: string): number | null {
  let digits = part
  let radix = 10
  if (/^0[xX]/.test(part)) {
    radix = 16
    digits = part.slice(2) || '0'
  } else if (part.length > 1 && part[0] === '0') {
    radix = 8
    digits = part.slice(1)
  }
  const allowed = radix === 16 ? /^[0-9a-fA-F]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/
  if (!allowed.test(digits)) return null
  const value = parseInt(digits, radix)
  return Number.isSafeInteger(value) ? value : null
}

/**
 * Parses an IPv4 literal in any form a URL parser accepts — dotted quad plus
 * the shorthand/octal/hex/decimal spellings ('127.1', '0177.0.0.1',
 * '2130706433', '0x7f000001') — or null if `host` is not one.
 */
function parseIpv4(host: string): Ipv4 | null {
  const parts = host.split('.')
  if (parts.length === 0 || parts.length > 4) return null
  const numbers: number[] = []
  for (const part of parts) {
    const value = parseIpv4Part(part)
    if (value === null) return null
    numbers.push(value)
  }
  // With fewer than 4 parts the LAST one spans the remaining octets.
  const last = numbers.pop() as number
  if (numbers.some((n) => n > 255)) return null
  if (last >= 256 ** (4 - numbers.length)) return null
  const octets: Ipv4 = [0, 0, 0, 0]
  numbers.forEach((n, i) => {
    octets[i] = n
  })
  let rest = last
  for (let i = 3; i >= numbers.length; i--) {
    octets[i] = rest % 256
    rest = Math.floor(rest / 256)
  }
  return octets
}

/** True for RFC1918 / loopback / link-local / CGNAT / unspecified IPv4. */
function isPrivateIpv4([a, b]: Ipv4): boolean {
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/**
 * Expands an IPv6 literal to its 8 groups, or null if `host` is not one. The
 * WHATWG URL parser canonicalises IPv6 hosts to compressed HEX groups (e.g.
 * '[::ffff:127.0.0.1]' becomes '[::ffff:7f00:1]'), so the guard must classify
 * the numeric address, not any single spelling of it.
 */
function parseIpv6(host: string): number[] | null {
  if (!host.includes(':')) return null
  let text = host
  // A trailing dotted quad ('::ffff:127.0.0.1') folds into two hex groups.
  const dotted = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(text)
  if (dotted) {
    const v4 = parseIpv4(dotted[2])
    if (!v4) return null
    const high = ((v4[0] << 8) | v4[1]).toString(16)
    const low = ((v4[2] << 8) | v4[3]).toString(16)
    text = `${dotted[1]}${high}:${low}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] === '' ? [] : halves[0].split(':')
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : []
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null
  const groups: number[] = []
  for (const group of [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
    groups.push(parseInt(group, 16))
  }
  return groups.length === 8 ? groups : null
}

/** True for loopback / unspecified / link-local / unique-local / IPv4-mapped-private IPv6. */
function isPrivateIpv6(groups: number[]): boolean {
  if (groups.every((g) => g === 0)) return true // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true // ::1
  // ::ffff:a.b.c.d (IPv4-mapped) and the deprecated ::a.b.c.d (IPv4-compatible).
  const embedsIpv4 =
    groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)
  if (embedsIpv4) {
    return isPrivateIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff])
  }
  if ((groups[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((groups[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  return false
}

/**
 * True when `hostname` names an internal/loopback/link-local target that must
 * not be fetched by model-driven network tools (SSRF guard). Covers literal
 * IPv4/IPv6 (incl. IPv4-mapped IPv6) plus the common internal hostnames. This
 * is a literal-host guard; DNS rebinding (a public name resolving to a private
 * IP) is a documented residual accepted for this local-first, approval-gated,
 * GET-only surface.
 */
function isBlockedHostname(hostnameRaw: string): boolean {
  // Drop the IPv6 brackets and a single trailing FQDN dot ('localhost.' and
  // '127.0.0.1.' resolve exactly like their bare forms) before classifying.
  const host = hostnameRaw
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .toLowerCase()
    .replace(/\.$/, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa'))
    return true
  if (host.includes(':')) {
    const v6 = parseIpv6(host)
    // An IPv6 literal we cannot parse is refused rather than trusted.
    return v6 === null ? true : isPrivateIpv6(v6)
  }
  const v4 = parseIpv4(host)
  if (v4) return isPrivateIpv4(v4)
  return false
}

function ssrfRefusal(parsed: URL): string | null {
  if (isBlockedHostname(parsed.hostname)) {
    return `Error: refusing to fetch internal/loopback/link-local address '${parsed.hostname}'.`
  }
  return null
}

/** Thrown inside guarded fetches; message is surfaced to the model verbatim. */
class FetchGuardError extends Error {}

/**
 * Converts a glob pattern to an anchored RegExp over forward-slash relative
 * paths. Supports '**' (any depth), '*' (within a segment) and '?'. A pattern
 * without '/' matches the basename at any depth.
 */
export function globToRegExp(pattern: string): RegExp {
  let normalized = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized.includes('/')) normalized = '**/' + normalized
  let out = ''
  let i = 0
  while (i < normalized.length) {
    const ch = normalized[i]
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        // '**/' matches zero or more whole segments; bare '**' matches anything.
        if (normalized[i + 2] === '/') {
          out += '(?:[^/]+/)*'
          i += 3
        } else {
          out += '.*'
          i += 2
        }
      } else {
        out += '[^/]*'
        i += 1
      }
    } else if (ch === '?') {
      out += '[^/]'
      i += 1
    } else {
      out += /[.+^${}()|[\]\\]/.test(ch) ? '\\' + ch : ch
      i += 1
    }
  }
  return new RegExp('^' + out + '$')
}

/** A '{m,}' (no upper bound) quantifier starting at `source[open]` ('{'). */
function isOpenEndedBrace(source: string, open: number): boolean {
  const close = source.indexOf('}', open + 1)
  if (close === -1) return false
  return /^\d+,$/.test(source.slice(open + 1, close))
}

/** True when the token at `i` is made optional by the quantifier that follows it. */
function isOptionalToken(source: string, i: number): boolean {
  const next = source[i + 1]
  if (next === '?' || next === '*') return true
  if (next === '{') {
    const close = source.indexOf('}', i + 2)
    return close !== -1 && /^0(,\d*)?$/.test(source.slice(i + 2, close))
  }
  return false
}

/** Chars to skip after a '(' so a group prefix ('?:', '?=', '?<name>') isn't read as content. */
function groupPrefixLength(source: string, open: number): number {
  if (source[open + 1] !== '?') return 0
  const third = source[open + 2]
  if (third === ':' || third === '=' || third === '!') return 2
  if (third === '<') {
    if (source[open + 3] === '=' || source[open + 3] === '!') return 3
    const close = source.indexOf('>', open + 3)
    return close === -1 ? 2 : close - open
  }
  return 1
}

/** Per open group: what its body contains, and the first token of each branch. */
interface RegexGroupScan {
  /** '*', '+' or '{m,}' anywhere in the body (directly or in a nested group). */
  unbounded: boolean
  /** A nested group whose branches can overlap. */
  ambiguous: boolean
  /**
   * First token of each top-level branch: the literal character it must start
   * with, or null when that cannot be determined (a class, an escape, a nested
   * group, an anchor, a dot, or an optional first token).
   */
  branchFirsts: Array<string | null>
  awaitingFirst: boolean
  /**
   * True while every consuming token seen in the CURRENT branch is optional, so
   * the branch can still match the empty string. Reset at each '|' and at the
   * group close.
   */
  branchNullable: boolean
  /** True once any completed branch of this group can match the empty string. */
  nullable: boolean
}

/**
 * Conservative catastrophic-backtracking guard for model-supplied regexes.
 *
 * A regex runs synchronously on the main thread over every line of every
 * scanned file; a pattern like `(\w+\s?)*;$` takes exponential time on a long
 * non-matching line and freezes the whole app (Stop can't even be delivered).
 * This build has no worker/RE2 to run the match with a timeout, so instead we
 * refuse the three exponential shapes, all of which need a QUANTIFIED group:
 * - its body contains an unbounded quantifier ('*', '+' or the '{m,}' spelling
 *   of the same thing), directly or nested — the classic '(\w+\s?)*';
 * - its branches can match the same input, so a repetition has many parses —
 *   '(a|a)+', '(\w|\d)+'. Branches starting with DISTINCT literal characters
 *   ('(a|b)*') are unambiguous and stay allowed;
 * - its body can match the EMPTY string (every consuming token is optional, e.g.
 *   '(\w?\w?)+', '(a?a?)+'), so a repetition can split the same run of input in
 *   exponentially many ways even without an inner unbounded quantifier.
 * Rejecting a few exotic-but-safe patterns is an acceptable price for never
 * freezing; the model is told to simplify.
 */
export function hasCatastrophicBacktracking(source: string): boolean {
  const stack: RegexGroupScan[] = []
  const top = (): RegexGroupScan | null => (stack.length > 0 ? stack[stack.length - 1] : null)
  const noteFirst = (literal: string | null): void => {
    const group = top()
    if (!group || !group.awaitingFirst) return
    group.branchFirsts.push(literal)
    group.awaitingFirst = false
  }
  const endBranch = (group: RegexGroupScan): void => {
    // An empty branch ('(a|)+') matches everywhere — treat it as unknown.
    if (group.awaitingFirst) group.branchFirsts.push(null)
    group.awaitingFirst = false
    // A branch with no required consuming token can match the empty string.
    if (group.branchNullable) group.nullable = true
    group.branchNullable = true
  }
  const markUnbounded = (): void => {
    const group = top()
    if (group) group.unbounded = true
  }
  // A consuming token the following quantifier does NOT make optional means the
  // current branch must match at least one character (it is not nullable).
  const markConsumingRequired = (): void => {
    const group = top()
    if (group) group.branchNullable = false
  }

  let inClass = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (inClass) {
      if (ch === '\\') i += 1
      else if (ch === ']') {
        inClass = false
        // A char class matches one char; required unless a quantifier follows.
        if (!isOptionalToken(source, i)) markConsumingRequired()
      }
      continue
    }
    if (ch === '\\') {
      noteFirst(null)
      // The escaped char is the token; its quantifier (if any) follows it.
      if (!isOptionalToken(source, i + 1)) markConsumingRequired()
      i += 1 // the escaped char is part of this token
      continue
    }
    if (ch === '[') {
      noteFirst(null)
      inClass = true
      continue
    }
    if (ch === '(') {
      noteFirst(null)
      i += groupPrefixLength(source, i)
      stack.push({
        unbounded: false,
        ambiguous: false,
        branchFirsts: [],
        awaitingFirst: true,
        branchNullable: true,
        nullable: false,
      })
      continue
    }
    if (ch === '*' || ch === '+') {
      markUnbounded()
      continue
    }
    if (ch === '{') {
      if (isOpenEndedBrace(source, i)) markUnbounded()
      continue
    }
    if (ch === '?' || ch === '}') continue
    if (ch === '|') {
      const group = top()
      if (group) {
        endBranch(group)
        group.awaitingFirst = true
      }
      continue
    }
    if (ch === ')') {
      const group = stack.pop()
      if (!group) continue
      endBranch(group)
      const overlapping = group.branchFirsts.length > 1 && branchesCanOverlap(group.branchFirsts)
      const next = source[i + 1]
      const groupIsQuantified = next === '*' || next === '+' || next === '{'
      if (
        (group.unbounded || group.ambiguous || overlapping || group.nullable) &&
        groupIsQuantified
      ) {
        return true
      }
      // Propagate to the parent so a risk nested any number of levels deep is
      // still caught by the parent's own quantifier.
      const parent = top()
      if (parent) {
        if (group.unbounded) parent.unbounded = true
        if (group.ambiguous || overlapping) parent.ambiguous = true
        // The group is a consuming token in the parent branch only if it can't
        // be skipped (not optional) and must match at least one char (not
        // nullable); otherwise the parent branch stays nullable.
        if (!isOptionalToken(source, i) && !group.nullable) parent.branchNullable = false
      }
      continue
    }
    // An anchor or '.' can start anywhere/anything — never a distinct literal.
    noteFirst(ch === '.' || ch === '^' || ch === '$' || isOptionalToken(source, i) ? null : ch)
    // A literal or '.' consumes a char; anchors ('^','$') are zero-width and
    // leave the branch nullable. A required consuming token makes it non-empty.
    if (ch !== '^' && ch !== '$' && !isOptionalToken(source, i)) markConsumingRequired()
  }
  return false
}

/** True unless every branch must start with a different literal character. */
function branchesCanOverlap(firsts: Array<string | null>): boolean {
  const seen = new Set<string>()
  for (const first of firsts) {
    if (first === null) return true
    const key = first.toLowerCase() // grep may run case-insensitively
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

/** Loose JSON-Schema check: object args + required keys present. */
function findMissingRequired(
  parameters: Record<string, unknown>,
  args: Record<string, unknown>
): string[] {
  const required = Array.isArray(parameters.required) ? parameters.required : []
  return required.filter((key): key is string => typeof key === 'string' && !(key in args))
}

function getString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' ? value : null
}

/**
 * Required string argument: [trimmedValue, null] when present and non-empty,
 * ['', standard refusal] otherwise (callers must return the refusal before
 * using the value).
 */
function requireStringArg(
  args: Record<string, unknown>,
  key: string
): [value: string, error: string | null] {
  const value = (getString(args, key) ?? '').trim()
  if (value.length === 0) return ['', `Error: '${key}' must be a non-empty string.`]
  return [value, null]
}

/** Integer argument floored and clamped to [1, max]; `def` when absent/not a number. */
/** schedule_task limits — mirror the Scheduled tasks IPC schema. */
const SCHEDULE_TITLE_MAX_CHARS = 120
const SCHEDULE_PROMPT_MAX_CHARS = 20_000

const SCHEDULE_RECURRENCES: readonly string[] = ['once', 'hourly', 'daily', 'weekly']

function isRecurrence(value: string): value is ScheduledTaskRecurrence {
  return SCHEDULE_RECURRENCES.includes(value)
}

/** The 'tools' arg as given (unvalidated) — for the approval note. */
function parseScheduleGrantArgs(args: Record<string, unknown>): string[] {
  return Array.isArray(args.tools)
    ? args.tools.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : []
}

function clampIntArg(args: Record<string, unknown>, key: string, def: number, max: number): number {
  const value = args[key]
  const raw = typeof value === 'number' ? Math.floor(value) : NaN
  return Number.isFinite(raw) ? Math.min(Math.max(raw, 1), max) : def
}

function isTextualContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase()
  return ct.startsWith('text/') || ct.includes('json') || ct.includes('xml')
}

/** Reads a response body up to `maxBytes`, cancelling the rest. */
async function readBodyCapped(
  res: Response,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  const decode = (bytes: Uint8Array, truncated: boolean): { text: string; truncated: boolean } => ({
    text: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
    truncated,
  })

  const body = res.body
  if (!body) {
    const buf = new Uint8Array(await res.arrayBuffer())
    return decode(buf.subarray(0, maxBytes), buf.byteLength > maxBytes)
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.byteLength
      // Only declare truncation once we've actually seen more than the cap.
      // Breaking at `>= maxBytes` mis-reported a body that ends exactly on the
      // boundary as complete when there was still more to read; keep reading
      // until we strictly exceed it (the join below still caps the output).
      if (total > maxBytes) {
        truncated = true
        await reader.cancel().catch(() => undefined)
        break
      }
    }
  }
  const joined = new Uint8Array(Math.min(total, maxBytes))
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= joined.byteLength) break
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, joined.byteLength - offset))
    joined.set(slice, offset)
    offset += slice.byteLength
  }
  return decode(joined, truncated)
}

/** Shared success shape for fetched textual responses (fetch_url + custom tools). */
function formatHttpResponse(res: Response, text: string, truncated: boolean): string {
  const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`
  return `${status}\n\n${text}${truncated ? '\n…[truncated at 512KB]' : ''}`
}

interface WalkEntry {
  relPath: string
  absPath: string
  sizeBytes: number
  mtimeMs: number
}

/**
 * Depth-first walk of the project root yielding files only. Skips ignored
 * directory names and all symlinks (a symlink could escape the root).
 */
async function walkProjectFiles(root: string): Promise<WalkEntry[]> {
  const results: WalkEntry[] = []
  let visited = 0

  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > WALK_MAX_DEPTH || visited >= WALK_MAX_ENTRIES) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory — skip silently
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (visited >= WALK_MAX_ENTRIES) return
      visited += 1
      if (entry.isSymbolicLink()) continue
      const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      const entryAbs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name)) continue
        await walk(entryAbs, entryRel, depth + 1)
      } else if (entry.isFile()) {
        let sizeBytes = 0
        let mtimeMs = 0
        try {
          const stat = await fs.stat(entryAbs)
          sizeBytes = stat.size
          mtimeMs = stat.mtimeMs
        } catch {
          continue
        }
        results.push({ relPath: entryRel, absPath: entryAbs, sizeBytes, mtimeMs })
      }
    }
  }

  await walk(path.resolve(root), '', 0)
  return results
}

interface WebSearchHit {
  title: string
  url: string
  snippet: string
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

/**
 * Extracts results from DuckDuckGo's HTML endpoint. Best-effort scraping of a
 * stable-for-years markup shape; an empty array simply means "no results".
 */
export function parseDuckDuckGoHtml(html: string, maxResults: number): WebSearchHit[] {
  const results: WebSearchHit[] = []
  const anchorRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  const snippets: string[] = []
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) {
    snippets.push(stripTags(m[1]))
  }
  let index = 0
  for (let m = anchorRe.exec(html); m && results.length < maxResults; m = anchorRe.exec(html)) {
    let url = decodeHtmlEntities(m[1])
    // Result links are redirects like //duckduckgo.com/l/?uddg=<encoded>&rut=…
    const uddg = /[?&]uddg=([^&]+)/.exec(url)
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1])
      } catch {
        // keep the redirect URL
      }
    }
    const title = stripTags(m[2])
    if (title.length === 0 || !url.startsWith('http')) {
      index += 1
      continue
    }
    results.push({ title, url, snippet: snippets[index] ?? '' })
    index += 1
  }
  return results
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class ToolExecutor {
  /**
   * Tools the user approved with scope 'conversation':
   * conversationId -> tool ids that skip the approval dialog there.
   * In-memory only — grants die with the app session, never persisted.
   */
  private readonly conversationApprovals = new Map<string, Set<string>>()

  constructor(private readonly deps: ToolExecutorDeps) {}

  /**
   * Executes one tool call. NEVER throws — every failure path resolves to a
   * human/model-readable string (capped at TOOL_RESULT_MAX_CHARS).
   */
  async execute(toolCall: ToolCallRecord, ctx: ToolExecuteContext): Promise<string> {
    try {
      return capToolResult(await this.executeInner(toolCall, ctx))
    } catch (e) {
      return capToolResult(redactSecrets(`Tool execution failed: ${errorMessage(e)}`))
    }
  }

  private async executeInner(toolCall: ToolCallRecord, ctx: ToolExecuteContext): Promise<string> {
    const definition = this.deps.registry.resolveForCall(toolCall.name)
    if (!definition) {
      return `Error: unknown tool '${toolCall.name}'. Available tools: ${this.deps.registry
        .listEnabledDefinitions()
        .map((tool) => tool.name)
        .join(', ')}.`
    }

    if (!definition.enabled) {
      return `Error: the tool '${definition.name}' is disabled in this app's settings.`
    }

    let args: Record<string, unknown>
    try {
      const raw: unknown = toolCall.arguments.trim() === '' ? {} : JSON.parse(toolCall.arguments)
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return `Error: arguments for '${definition.name}' must be a JSON object.`
      }
      args = raw as Record<string, unknown>
    } catch {
      return `Error: arguments for '${definition.name}' are not valid JSON.`
    }

    const missing = findMissingRequired(definition.parameters, args)
    if (missing.length > 0) {
      return `Error: missing required argument(s) for '${definition.name}': ${missing.join(', ')}.`
    }

    // `mutating` is declared where each tool is defined (see ToolDefinition).
    if (ctx.planMode && definition.mutating === true) {
      return (
        'Plan mode is active: only read-only investigation is allowed. Present your plan to ' +
        "the user instead of calling '" + definition.name + "'; they can turn plan mode off to proceed."
      )
    }

    const decision = this.deps.registry.getPermission(definition)
    if (decision === 'deny') {
      return `The user has denied the tool '${definition.name}' in this app's settings; it was not run.`
    }
    if (decision === 'ask' && !this.approvalPreGranted(definition, args, ctx)) {
      const note = await this.approvalNoteFor(definition, args, ctx)
      const answer = await ctx.approval({
        streamId: ctx.streamId ?? '',
        conversationId: ctx.conversation.id,
        toolCall,
        risk: definition.risk,
        ...(note ? { note } : {}),
      })
      if (!answer.approved) return USER_DECLINED_RESULT
      // A conversation-wide grant can never cover a noStandingApproval tool:
      // each of its calls is individually consequential (e.g. a git commit).
      if (answer.scope === 'conversation' && definition.noStandingApproval !== true) {
        let allowed = this.conversationApprovals.get(ctx.conversation.id)
        if (!allowed) {
          allowed = new Set()
          this.conversationApprovals.set(ctx.conversation.id, allowed)
        }
        allowed.add(definition.id)
      }
    }

    return this.runTool(definition, args, ctx, toolCall)
  }

  /**
   * Main-computed context line shown prominently in the approval dialog —
   * the git_write "what exactly will this do, on which branch" summary and
   * the schedule_task "what standing job would this create" summary.
   * Best-effort; never blocks the approval on a failure.
   */
  private async approvalNoteFor(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    ctx: ToolExecuteContext
  ): Promise<string | undefined> {
    if (definition.id === 'schedule_task') return this.scheduleTaskNote(args, ctx)
    if (definition.id !== 'git_write' || !this.deps.gitWrite) return undefined
    const root = this.deps.getProjectRoot(ctx.conversation)
    if (!root) return undefined
    try {
      const action = getString(args, 'action') ?? ''
      if (action === 'commit') {
        const status = await this.deps.gitWrite.status(root)
        const count = status.staged.length
        const branch = status.branch ?? (status.detached ? 'a detached HEAD' : 'an unborn branch')
        const isDefault = status.branch !== null && status.branch === status.defaultBranch
        return (
          `Commits ${count} staged ${count === 1 ? 'file' : 'files'} on ${status.branch ? `branch '${branch}'` : branch}` +
          (isDefault ? ' — the DEFAULT branch' : '')
        )
      }
      if (action === 'stage') {
        const paths = Array.isArray(args.paths)
          ? args.paths.filter((p): p is string => typeof p === 'string')
          : []
        const shown = paths.slice(0, 5).join(', ')
        return `Stages ${paths.length} ${paths.length === 1 ? 'file' : 'files'}: ${shown}${paths.length > 5 ? ', …' : ''}`
      }
      if (action === 'create_branch') {
        const branch = getString(args, 'branch') ?? ''
        return `Creates and switches to branch '${branch}'`
      }
    } catch {
      // The dialog still shows the raw arguments.
    }
    return undefined
  }

  /**
   * Standing grants that let an 'ask' tool run without the dialog:
   * - an earlier "allow for this conversation" answer for the same tool,
   * - auto-accept-edits mode for the file-editing tools,
   * - a shell command covered by the user's prefix allowlist.
   * Tools marked noStandingApproval get NO standing grant of any kind.
   */
  private approvalPreGranted(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    ctx: ToolExecuteContext
  ): boolean {
    if (definition.noStandingApproval === true) return false
    if (this.conversationApprovals.get(ctx.conversation.id)?.has(definition.id)) return true
    if (
      ctx.autoAcceptEdits === true &&
      (definition.id === 'edit_file' || definition.id === 'write_file')
    ) {
      return true
    }
    if (definition.id === 'run_shell_command') {
      const command = getString(args, 'command') ?? ''
      const allowlist = this.deps.shellAllowlist?.() ?? []
      if (allowlist.length > 0 && commandMatchesAllowlist(command, allowlist)) return true
    }
    return false
  }

  private async runTool(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    ctx: ToolExecuteContext,
    toolCall: ToolCallRecord
  ): Promise<string> {
    switch (definition.id) {
      case 'file_search':
        return this.runFileSearch(args, ctx)
      case 'grep':
        return this.runGrep(args, ctx)
      case 'glob':
        return this.runGlob(args, ctx)
      case 'git':
        return this.runGit(args, ctx)
      case 'web_search':
        return this.runWebSearch(args)
      case 'generate_image':
        return this.runGenerateImage(args, ctx)
      case 'git_write':
        return this.runGitWrite(args, ctx)
      case 'edit_file':
        return this.runEditFile(args, ctx)
      case 'write_file':
        return this.runWriteFile(args, ctx)
      case 'task_output':
        return this.runTaskOutput(args)
      case 'task_stop':
        return this.runTaskStop(args)
      case 'update_task_list':
        return this.runUpdateTaskList(args, ctx)
      case 'schedule_task':
        return this.runScheduleTask(args, ctx)
      case 'ask_user_question':
        return this.runAskUserQuestion(args, ctx)
      case 'repo_map':
        return this.runRepoMap(args, ctx)
      case 'read_file':
        return this.runReadFile(args, ctx)
      case 'list_directory':
        return this.runListDirectory(args, ctx)
      case 'fetch_url':
        return this.runFetchUrl(args)
      case 'propose_shell_command':
        return this.runProposeShellCommand(args)
      case 'run_shell_command':
        return this.runShellCommand(args, ctx, toolCall)
      case 'use_skill':
        return this.runUseSkill(args)
      case 'knowledge_search':
        return this.runKnowledgeSearch(args, ctx)
      case 'delegate':
        return this.runDelegate(args, ctx)
      case 'browser':
        return this.runBrowser(args)
      case 'computer':
        return this.runComputer(args)
      default:
        if (isMcpToolId(definition.id) && this.deps.mcpClient) {
          return this.deps.mcpClient.callTool(definition.id, args)
        }
        return this.runCustomTool(definition, args)
    }
  }

  // -- project-file tools -------------------------------------------------------

  private requireProjectRoot(ctx: ToolExecuteContext): string | null {
    const root = this.deps.getProjectRoot(ctx.conversation)
    return root && root.trim().length > 0 ? root : null
  }

  private static readonly NO_PROJECT =
    'Error: no working folder is attached to this conversation yet. ' +
    'In a Work task, write a file first (write_file) to start its workspace, ' +
    'or ask the user to connect a folder.'

  private async runFileSearch(
    args: Record<string, unknown>,
    ctx: ToolExecuteContext
  ): Promise<string> {
    const root = this.requireProjectRoot(ctx)
    if (!root) return ToolExecutor.NO_PROJECT

    const [query, queryError] = requireStringArg(args, 'query')
    if (queryError) return queryError
    const maxResults = clampIntArg(args, 'maxResults', SEARCH_DEFAULT_RESULTS, SEARCH_MAX_RESULTS)

    const needle = query.toLowerCase()
    const lines: string[] = []
    const files = await walkProjectFiles(root)

    for (const file of files) {
      if (lines.length >= maxResults) break
      if (file.relPath.toLowerCase().includes(needle)) {
        lines.push(file.relPath)
        if (lines.length >= maxResults) break
      }
      if (file.sizeBytes >= SEARCH_CONTENT_MAX_BYTES) continue
      let buffer: Buffer
      try {
        buffer = await fs.readFile(file.absPath)
      } catch {
        continue
      }
      if (looksBinary(buffer)) continue
      const content = buffer.toString('utf8')
      if (!content.toLowerCase().includes(needle)) continue
      const contentLines = content.split(/\r?\n/)
      for (let i = 0; i < contentLines.length && lines.length < maxResults; i++) {
        if (!contentLines[i].toLowerCase().includes(needle)) continue
        const text = contentLines[i].trim().slice(0, SEARCH_LINE_MAX_CHARS)
        lines.push(`${file.relPath}:${i + 1}: ${text}`)
      }
    }

    if (lines.length === 0) return `No matches found for "${query}".`
    return lines.join('\n')
  }

  private async runRepoMap(
    args: Record<string, unknown>,
    ctx: ToolExecuteContext
  ): Promise<string> {
    const root = this.requireProjectRoot(ctx)
    if (!root) return ToolExecutor.NO_PROJECT
    if (!this.deps.repoMap || !ctx.conversation.projectId) {
      return 'Error: the repo map is unavailable in this build.'
    }
    const [query, queryError] = requireStringArg(args, 'query')
    if (queryError) return queryError
    const maxResults = clampIntArg(args, 'maxResults', 12, 30)

    let hits
    try {
      hits = await this.deps.repoMap.search(ctx.conversation.projectId, root, query, maxResults)
    } catch (e) {
      return redactSecrets(`Error building repo map: ${errorMessage(e)}`)
    }
    if (hits.length === 0) return `No files matched "${query}".`

    const lines: string[] = [`repo_map results for "${query}" (${hits.length} files):`]
    hits.forEach((hit, i) => {
      lines.push(`${i + 1}. ${hit.relPath}`)
      if (hit.symbols.length > 0) {
        lines.push(`   ${hit.symbols.slice(0, 8).join(', ')}`)
      }
    })
    return lines.join('\n')
  }

  private async runReadFile(
    args: Record<string, unknown>,
    ctx: ToolExecuteContext
  ): Promise<string> {
    const root = this.requireProjectRoot(ctx)
    if (!root) return ToolExecutor.NO_PROJECT

    const [relPath, relPathError] = requireStringArg(args, 'path')
    if (relPathError) return relPathError
    const [absPath, refusal] = resolveWithinRootOrRefuse(root, relPath)
    if (refusal) return refusal

    // Prefer the code service (shared limits/formatting) when it is wired in.
    if (this.deps.codeService && ctx.conversation.projectId) {
      try {
        const result = await this.deps.codeService.readFile(ctx.conversation.projectId, relPath)
        return result.truncated ? `${result.content}\n…[truncated]` : result.content
      } catch (e) {
        return redactSecrets(`Error reading '${relPath}': ${errorMessage(e)}`)
      }
    }

    const escaped = await assertRealContained(root, absPath, relPath)
    if (escaped) return escaped

    try {
      const stat = await fs.lstat(absPath)
      if (stat.isSymbolicLink()) {
        return `Error: '${relPath}' is a symbolic link; access refused.`
      }
      if (!stat.isFile()) return `Error: '${relPath}' is not a file.`
      const buffer = await fs.readFile(absPath)
      if (looksBinary(buffer)) {
        return `Error: '${relPath}' appears to be a binary file (${stat.size} bytes).`
      }
      const truncated = buffer.byteLength > READ_FILE_MAX_BYTES
      const text = buffer.subarray(0, READ_FILE_MAX_BYTES).toString('utf8')
      return truncated ? `${text}\n…[truncated]` : text
    } catch (e) {
      return redactSecrets(`Error reading '${relPath}': ${errorMessage(e)}`)
    }
  }

  private async runListDirectory(
    args: Record<string, unknown>,
    ctx: ToolExecuteContext
  ): Promise<string> {
    const root = this.requireProjectRoot(ctx)
    if (!root) return ToolExecutor.NO_PROJECT

    const relPath = (getString(args, 'path') ?? '.').trim() || '.'
    const [absPath, refusal] = resolveWithinRootOrRefuse(root, relPath)
    if (refusal) return refusal
    const escaped = await assertRealContained(root, absPath, relPath)
    if (escaped) return escaped

    try {
      const entries = await fs.readdir(absPath, { withFileTypes: true })
      if (entries.length === 0) return '(empty directory)'
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      const lines: string[] = []
      for (const entry of entries) {
        if (entry.isDirectory()) {
          lines.push(`${entry.name}/`)
        } else if (entry.isFile()) {
          let size = ''
          try {
            size = ` (${(await fs.stat(path.join(absPath, entry.name))).size} bytes)`
          } catch {
            // size is cosmetic
          }
          lines.push(`${entry.name}${size}`)
        } else {
          lines.push(entry.name)
        }
      }
      return lines.join('\n')
    } catch (e) {
      return redactSecrets(`Error listing '${relPath}': ${errorMessage(e)}`)
    }
  }


  private async runGrep(args: Record<string, unknown>, ctx: ToolExecuteContext): Promise<string> {
    const root = this.requireProjectRoot(ctx)
    if (!root) return ToolExecutor.NO_PROJECT

    const [patternSource, patternError] = requireStringArg(args, 'pattern')
    if (patternError) return patternError
    if (hasCatastrophicBacktracking(patternSource)) {
      return "Error: that pattern risks catastrophic backtracking (a repeated group that itself repeats, alternates, or can match empty, e.g. '(\\w+\\s?)*', '(a|a)+' or '(\\w?\\w?)+'). Simplify it — avoid a quantifier, an alternation, or all-optional tokens inside a repeated group."
    }
    let pattern: RegExp
    try {
      pattern = new RegExp(patternSource, args.ignoreCase === true ? 'i' : undefined)
    } catch (e) {
      return 'Error: invalid regular expression: ' + errorMessage(e)
    }
    let globFilter: RegExp | null = null
    const globSource = (getString(args, 'glob') ?? '').trim()
    if (globSource.length > 0) {
      try {
        globFilter = globToRegExp(globSource)
      } catch (e) {
        return 'Error: invalid glob pattern: ' + errorMessage(e)
      }
    }
    const maxResults = clampIntArg(args, 'maxResults', GREP_DEFAULT_RESULTS, GREP_MAX_RESULTS)

    // Belt for whatever hasCatastrophicBacktracking misses: the scan is
    // abandoned once it has spent this long matching (checked between lines).
    const deadline = Date.now() + GREP_TIME_BUDGET_MS
    let ranOut = false
    const lines: string[] = []
    for (const file of await walkProjectFiles(root)) {
      if (lines.length >= maxResults || ranOut) break
      if (globFilter && !globFilter.test(file.relPath)) continue
      if (file.sizeBytes >= SEARCH_CONTENT_MAX_BYTES) continue
      let buffer: Buffer
      try {
        buffer = await fs.readFile(file.absPath)
      } catch {
        continue
      }
      if (looksBinary(buffer)) continue
      const contentLines = buffer.toString('utf8').split(/\r?\n/)
      for (let i = 0; i < contentLines.length && lines.length < maxResults; i++) {
        if (Date.now() > deadline) {
          ranOut = true
          break
        }
        if (!pattern.test(contentLines[i])) continue
        const text = contentLines[i].trim().slice(0, SEARCH_LINE_MAX_CHARS)
        lines.push(file.relPath + ':' + (i + 1) + ': ' + text)
      }
    }
    if (ranOut) {
      const found = lines.length > 0 ? lines.join('\n') + '\n' : ''
      return (
        found +
        'Error: the search took too long and was stopped after ' +
        GREP_TIME_BUDGET_MS / 1000 +
        's. Use a simpler pattern (and a glob filter) — some results may be missing.'
      )
    }
    if (lines.length === 0) return 'No matches found for /' + patternSource + '/.'
    return lines.join('\n')
  }

  private async runGlob(args: Record<string, unknown>, ctx: ToolExecuteContext): Promise<string> {
    const root = this.requireProjectRoot(ctx)
    if (!root) return ToolExecutor.NO_PROJECT

    const [patternSource, patternError] = requireStringArg(args, 'pattern')
    if (patternError) return patternError
    let pattern: RegExp
    try {
      pattern = globToRegExp(patternSource)
    } catch (e) {
      return 'Error: invalid glob pattern: ' + errorMessage(e)
    }
    const maxResults = clampIntArg(args, 'maxResults', GLOB_DEFAULT_RESULTS, GLOB_MAX_RESULTS)

    const matches = (await walkProjectFiles(root))
      .filter((file) => pattern.test(file.relPath))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, maxResults)
      .map((file) => file.relPath)
    if (matches.length === 0) return 'No files match "' + patternSource + '".'
    return matches.join('\n')
  }

  private async runGit(args: Record<string, unknown>, ctx: ToolExecuteContext): Promise<string> {
    const root = this.requireProjectRoot(ctx)
    if (!root) return ToolExecutor.NO_PROJECT

    const action = (getString(args, 'action') ?? '').trim()
    const relPath = (getString(args, 'path') ?? '').trim()
    if (relPath) {
      const [, refusal] = resolveWithinRootOrRefuse(root, relPath)
      if (refusal) return refusal
    }

    // SAFETY: argv is built exclusively from this fixed allowlist — the model
    // can never add flags or subcommands, so no mutation is reachable.
    let argv: string[]
    switch (action) {
      case 'status':
        argv = ['status', '--porcelain=v1', '--branch']
        break
      case 'diff': {
        argv = args.staged === true ? ['diff', '--staged'] : ['diff']
        if (relPath) argv.push('--', relPath)
        break
      }
      case 'log': {
        const maxCount = clampIntArg(args, 'maxCount', 20, 100)
        argv = ['log', '--oneline', '--no-decorate', '-n', String(maxCount)]
        if (relPath) argv.push('--', relPath)
        break
      }
      default:
        return "Error: unknown git action '" + action + "' (use 'status', 'diff' or 'log')."
    }

    const result = await runGitQuery(argv, root)
    if (!result.ok) return redactSecrets('git ' + action + ' failed: ' + result.output)
    const trimmed = result.output.trimEnd()
    return trimmed.length > 0 ? trimmed : '(no output — nothing to show)'
  }

  private async runWebSearch(args: Record<string, unknown>): Promise<string> {
    const [query, queryError] = requireStringArg(args, 'query')
    if (queryError) return queryError
    const maxResults = clampIntArg(
      args,
      'maxResults',
      WEB_SEARCH_DEFAULT_RESULTS,
      WEB_SEARCH_MAX_RESULTS
    )

    try {
      return await this.fetchWithTimeout(
        'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query),
        { method: 'GET', headers: { accept: 'text/html' } },
        async (res) => {
          if (!res.ok) return 'Error: the search engine returned HTTP ' + res.status + '.'
          const { text } = await readBodyCapped(res, FETCH_MAX_BYTES)
          const results = parseDuckDuckGoHtml(text, maxResults)
          if (results.length === 0) return 'No results found for "' + query + '".'
          return results
            .map((r, i) => i + 1 + '. ' + r.title + ' — ' + r.url + (r.snippet ? '\n   ' + r.snippet : ''))
            .join('\n')
        }
      )
    } catch (e) {
      return redactSecrets('Error searching the web: ' + errorMessage(e))
    }
  }

  // -- approval-gated project writes ---------------------------------------------

  private requireCodeChanges(
    ctx: ToolExecuteContext
  ): { conversationId: string; projectId: string; root: string } | string {
    if (!this.deps.codeChanges || !this.deps.codeService) {
      return 'Error: file editing is unavailable in this build.'
    }
    // Work tasks get their own workspace folder on first write (idempotent:
    // an already-linked folder — granted or auto — is simply returned).
    if (ctx.conversation.mode === 'work' && this.deps.ensureWorkspaceRoot) {
      try {
        const workspace = this.deps.ensureWorkspaceRoot(ctx.conversation.id)
        return {
          conversationId: ctx.conversation.id,
          projectId: workspace.projectId,
          root: workspace.root,
        }
      } catch (e) {
        return redactSecrets('Error preparing the task workspace: ' + errorMessage(e))
      }
    }
    const root = this.requireProjectRoot(ctx)
    if (!root) return ToolExecutor.NO_PROJECT
    if (!ctx.conversation.projectId) {
      return 'Error: file editing is unavailable in this build.'
    }
    return { conversationId: ctx.conversation.id, projectId: ctx.conversation.projectId, root }
  }

  private async runEditFile(args: Record<string, unknown>, ctx: ToolExecuteContext): Promise<string> {
    const gate = this.requireCodeChanges(ctx)
    if (typeof gate === 'string') return gate

    const [relPath, relPathError] = requireStringArg(args, 'path')
    const oldString = getString(args, 'old_string')
    const newString = getString(args, 'new_string')
    if (relPathError) return relPathError
    if (oldString === null || oldString.length === 0) {
      return "Error: 'old_string' must be a non-empty string."
    }
    if (newString === null) return "Error: 'new_string' must be a string."
    if (oldString === newString) return "Error: 'new_string' must differ from 'old_string'."

    let current: { content: string; truncated: boolean; sizeBytes: number }
    try {
      const read = await this.deps.codeService!.readFile(gate.projectId, relPath)
      current = { content: read.content, truncated: read.truncated, sizeBytes: read.sizeBytes }
    } catch (e) {
      return redactSecrets("Error reading '" + relPath + "': " + errorMessage(e))
    }
    if (current.truncated || current.sizeBytes > EDIT_FILE_MAX_BYTES) {
      return (
        "Error: '" + relPath + "' is too large to edit with edit_file; propose a uld-change block instead."
      )
    }

    const occurrences = current.content.split(oldString).length - 1
    if (occurrences === 0) {
      return "Error: old_string was not found in '" + relPath + "'. Re-read the file — it must match exactly, including whitespace."
    }
    const replaceAll = args.replace_all === true
    if (occurrences > 1 && !replaceAll) {
      return 'Error: old_string occurs ' + occurrences + " times in '" + relPath + "'. Provide a longer, unique old_string or set replace_all."
    }
    // split/join for BOTH paths: it treats new_string as a literal. String
    // .replace() would interpret '$$', '$&', '$`' and "$'" in new_string as
    // replacement patterns and silently corrupt the written file. (When
    // !replaceAll, occurrences is exactly 1 here, so split/join replaces the
    // single match.)
    const newContent = current.content.split(oldString).join(newString)

    try {
      const change = await this.deps.codeChanges!.propose(gate.conversationId, relPath, 'edit', newContent)
      await this.deps.codeChanges!.apply(change.id)
    } catch (e) {
      return redactSecrets("Error applying the edit to '" + relPath + "': " + errorMessage(e))
    }
    const what = replaceAll ? occurrences + ' occurrences' : '1 occurrence'
    return 'Edited ' + relPath + ' (replaced ' + what + '). The change was applied and recorded in the Changes list.'
  }

  private async runWriteFile(args: Record<string, unknown>, ctx: ToolExecuteContext): Promise<string> {
    const gate = this.requireCodeChanges(ctx)
    if (typeof gate === 'string') return gate

    const [relPath, relPathError] = requireStringArg(args, 'path')
    const content = getString(args, 'content')
    if (relPathError) return relPathError
    if (content === null) return "Error: 'content' must be a string."
    const [absPath, refusal] = resolveWithinRootOrRefuse(gate.root, relPath)
    if (refusal) return refusal

    let exists = false
    try {
      exists = (await fs.lstat(absPath)).isFile()
    } catch {
      exists = false
    }
    try {
      const change = await this.deps.codeChanges!.propose(
        gate.conversationId,
        relPath,
        exists ? 'edit' : 'create',
        content
      )
      await this.deps.codeChanges!.apply(change.id)
    } catch (e) {
      return redactSecrets("Error writing '" + relPath + "': " + errorMessage(e))
    }
    return (
      (exists ? 'Replaced ' : 'Created ') + relPath + ' (' + content.length +
      ' chars). The change was applied and recorded in the Changes list.'
    )
  }

  // -- background tasks + task list + questions -----------------------------------

  private runTaskOutput(args: Record<string, unknown>): string {
    if (!this.deps.delegateBackground) return 'Error: background tasks are unavailable in this build.'
    const [taskId, taskIdError] = requireStringArg(args, 'taskId')
    if (taskIdError) return taskIdError
    return this.deps.delegateBackground.output(taskId)
  }

  private runTaskStop(args: Record<string, unknown>): string {
    if (!this.deps.delegateBackground) return 'Error: background tasks are unavailable in this build.'
    const [taskId, taskIdError] = requireStringArg(args, 'taskId')
    if (taskIdError) return taskIdError
    return this.deps.delegateBackground.stop(taskId)
  }

  private runUpdateTaskList(args: Record<string, unknown>, ctx: ToolExecuteContext): string {
    if (!this.deps.taskList) return 'Error: the task list is unavailable in this build.'
    const raw = args.tasks
    if (!Array.isArray(raw) || raw.length === 0) {
      return "Error: 'tasks' must be a non-empty array of { content, status }."
    }
    const tasks: TaskListItem[] = []
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) {
        return "Error: every task must be an object with 'content' and 'status'."
      }
      const item = entry as Record<string, unknown>
      const content = typeof item.content === 'string' ? item.content.trim() : ''
      const status = typeof item.status === 'string' ? item.status : ''
      if (content.length === 0) return "Error: every task needs a non-empty 'content'."
      if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
        return "Error: task status must be 'pending', 'in_progress' or 'completed'."
      }
      tasks.push({ content, status })
    }
    return this.deps.taskList.update(ctx.conversation.id, encodeTaskList(tasks))
  }

  // -- scheduled tasks ------------------------------------------------------------

  /** Approval-dialog context line for schedule_task (best-effort). */
  private scheduleTaskNote(
    args: Record<string, unknown>,
    ctx: ToolExecuteContext
  ): string | undefined {
    try {
      const action = getString(args, 'action')
      if (action === 'create') {
        const title = getString(args, 'title') ?? ''
        const recurrence = getString(args, 'recurrence') ?? ''
        const cadence = recurrence === 'once' ? 'one-time' : recurrence
        const grants = parseScheduleGrantArgs(args)
        let note = `Creates a ${cadence} scheduled task "${title}" that runs its prompt automatically`
        if (grants.length > 0) {
          note += ` — pre-approves for its runs: ${grants.join(', ')}`
          const projectId = this.deps.scheduledTasks?.conversationProjectId(ctx.conversation.id)
          const root = projectId ? this.deps.scheduledTasks?.projectPath(projectId) : null
          if (root) note += ` (working folder: ${root})`
        }
        return note
      }
      if (action === 'cancel') {
        const task = this.deps.scheduledTasks?.getById(getString(args, 'id') ?? '')
        if (task) return `Removes the scheduled task "${task.title}"`
      }
    } catch {
      // The dialog still shows the raw arguments.
    }
    return undefined
  }

  private runScheduleTask(args: Record<string, unknown>, ctx: ToolExecuteContext): string {
    const tasks = this.deps.scheduledTasks
    if (!tasks) return 'Error: scheduled tasks are unavailable in this context.'
    const [action, actionError] = requireStringArg(args, 'action')
    if (actionError) return actionError

    if (action === 'list') {
      const all = tasks.list()
      if (all.length === 0) return 'No scheduled tasks exist.'
      const lines = all.map((task) => {
        const next = task.nextRunAt === null ? 'none' : formatLocalRunTime(task.nextRunAt)
        return `- "${task.title}" — ${task.recurrence}, next run: ${next}${task.enabled ? '' : ' (paused)'}, last status: ${task.lastStatus} (id: ${task.id})`
      })
      return `Scheduled tasks:\n${lines.join('\n')}`
    }

    if (action === 'cancel') {
      const [id, idError] = requireStringArg(args, 'id')
      if (idError) return idError
      const task = tasks.getById(id)
      if (!task) return `Error: no scheduled task with id '${id}'. Use action "list" to see ids.`
      tasks.remove(id)
      return `Cancelled scheduled task "${task.title}".`
    }

    if (action !== 'create') {
      return `Error: unknown action '${action}'. Use "create", "list" or "cancel".`
    }

    const [title, titleError] = requireStringArg(args, 'title')
    if (titleError) return titleError
    const [prompt, promptError] = requireStringArg(args, 'prompt')
    if (promptError) return promptError
    if (title.length > SCHEDULE_TITLE_MAX_CHARS) {
      return `Error: 'title' must be at most ${SCHEDULE_TITLE_MAX_CHARS} characters.`
    }
    if (prompt.length > SCHEDULE_PROMPT_MAX_CHARS) {
      return `Error: 'prompt' must be at most ${SCHEDULE_PROMPT_MAX_CHARS} characters.`
    }
    const recurrence = getString(args, 'recurrence')
    if (!recurrence || !isRecurrence(recurrence)) {
      return 'Error: recurrence must be one of "once", "hourly", "daily", "weekly".'
    }

    // Pre-approved tools: standing grants for this task's headless runs. Only
    // known, enabled tools qualify; noStandingApproval tools never do (their
    // contract is a fresh approval per call), nor schedule_task itself (a task
    // must not mint further standing grants).
    if (args.tools !== undefined && !Array.isArray(args.tools)) {
      return "Error: 'tools' must be an array of tool ids."
    }
    const grantIds: string[] = []
    for (const entry of Array.isArray(args.tools) ? args.tools : []) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        return "Error: 'tools' must be an array of tool ids."
      }
      const tool = this.deps.registry.resolveForCall(entry.trim())
      if (!tool || !tool.enabled) {
        return `Error: unknown or disabled tool '${entry}' in 'tools'.`
      }
      if (tool.noStandingApproval === true || tool.id === 'schedule_task') {
        return `Error: '${tool.id}' requires a fresh approval for every call and cannot be pre-approved for a scheduled task.`
      }
      if (!grantIds.includes(tool.id)) grantIds.push(tool.id)
    }

    // The task inherits this conversation's working folder so pre-approved
    // file/shell tools have a root; a folderless Work task gets its own
    // workspace (same lazy path the file tools use).
    let projectId = grantIds.length > 0 ? tasks.conversationProjectId(ctx.conversation.id) : null
    if (
      grantIds.length > 0 &&
      !projectId &&
      ctx.conversation.mode === 'work' &&
      this.deps.ensureWorkspaceRoot
    ) {
      try {
        projectId = this.deps.ensureWorkspaceRoot(ctx.conversation.id).projectId
      } catch {
        projectId = null
      }
    }

    const resolved = resolveFirstRun(
      {
        recurrence,
        time: getString(args, 'time'),
        date: getString(args, 'date'),
        inMinutes: typeof args.in_minutes === 'number' ? args.in_minutes : null,
      },
      Date.now()
    )
    if ('error' in resolved) return resolved.error
    const task = tasks.create({
      title,
      prompt,
      recurrence,
      runAt: resolved.runAt,
      approvedToolIds: grantIds,
      projectId,
    })
    const cadence = recurrence === 'once' ? 'It runs once' : `It repeats ${recurrence}`
    let grantNote = ''
    if (grantIds.length > 0) {
      const root = projectId ? tasks.projectPath(projectId) : null
      grantNote = ` Pre-approved tools: ${grantIds.join(', ')}${
        root
          ? ` (working folder: ${root}).`
          : '. WARNING: no working folder is attached — file and shell tools will fail at run time; create the task from a conversation with a connected folder if it needs one.'
      }`
    }
    return (
      `Scheduled task "${task.title}" created (id: ${task.id}). ` +
      `First run: ${formatLocalRunTime(resolved.runAt)}. ${cadence}; the user can pause or ` +
      `remove it from the Scheduled tasks panel.${grantNote}`
    )
  }

  private async runAskUserQuestion(
    args: Record<string, unknown>,
    ctx: ToolExecuteContext
  ): Promise<string> {
    if (!ctx.askUser) return 'Error: asking the user a question is unavailable here.'
    const [question, questionError] = requireStringArg(args, 'question')
    if (questionError) return questionError
    const options = Array.isArray(args.options)
      ? args.options
          .filter((option): option is string => typeof option === 'string')
          .map((option) => option.trim())
          .filter((option) => option.length > 0)
          .slice(0, 4)
      : []
    const answer = await ctx.askUser(question, options)
    if (answer === null || answer.trim().length === 0) {
      return 'The user dismissed the question without answering. Proceed with your best judgment.'
    }
    return 'The user answered: ' + answer.trim()
  }

  // -- network tools --------------------------------------------------------------

  /**
   * Fetches `url` and runs `consume` on the response, aborting after
   * FETCH_TIMEOUT_MS. The timer stays armed until `consume` finishes so a slow
   * body read times out just like slow headers; callers keep their own
   * catch/refusal messages around this call.
   */
  private async fetchWithTimeout<T>(
    url: string,
    init: RequestInit,
    consume: (res: Response) => Promise<T>,
    guard?: { blockInternal?: boolean; sameOriginRedirectsOnly?: boolean }
  ): Promise<T> {
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      if (!guard) {
        return await consume(await fetchImpl(url, { ...init, signal: controller.signal }))
      }
      // Guarded mode: follow redirects manually so every hop can be
      // re-validated. `redirect: 'follow'` would let a public URL 302 to an
      // internal host, or bounce custom-tool secret headers to another origin
      // (undici keeps custom headers across cross-origin redirects).
      const origin = new URL(url).origin
      let currentUrl = url
      for (let hop = 0; hop <= MAX_FETCH_REDIRECTS; hop++) {
        if (guard.blockInternal) {
          const blocked = ssrfRefusal(new URL(currentUrl))
          if (blocked) throw new FetchGuardError(blocked)
        }
        const res = await fetchImpl(currentUrl, {
          ...init,
          redirect: 'manual',
          signal: controller.signal,
        })
        if (res.status < 300 || res.status >= 400) return await consume(res)
        const location = res.headers.get('location')
        if (!location) return await consume(res)
        const next = new URL(location, currentUrl)
        if (next.protocol !== 'https:') {
          throw new FetchGuardError(
            `Error: refusing to follow a redirect to a non-https URL ('${next.protocol}//…').`
          )
        }
        if (guard.sameOriginRedirectsOnly && next.origin !== origin) {
          throw new FetchGuardError(
            `Error: refusing to follow a cross-origin redirect (${origin} → ${next.origin}); ` +
              `secret headers are not forwarded off-origin.`
          )
        }
        currentUrl = next.toString()
      }
      throw new FetchGuardError('Error: too many redirects.')
    } finally {
      clearTimeout(timer)
    }
  }

  private async runGitWrite(
    args: Record<string, unknown>,
    ctx: ToolExecuteContext
  ): Promise<string> {
    const gitWrite = this.deps.gitWrite
    if (!gitWrite) return 'Error: git write operations are unavailable in this context.'
    const root = this.deps.getProjectRoot(ctx.conversation)
    if (!root) {
      return 'Error: no project folder is granted to this conversation — git_write needs one.'
    }
    const action = getString(args, 'action') ?? ''
    try {
      switch (action) {
        case 'stage': {
          const paths = Array.isArray(args.paths)
            ? args.paths.filter((p): p is string => typeof p === 'string')
            : []
          if (paths.length === 0) {
            return "Error: 'paths' must be a non-empty array of relative file paths."
          }
          return await gitWrite.stage(root, paths)
        }
        case 'commit': {
          const [message, messageError] = requireStringArg(args, 'message')
          if (messageError) return messageError
          // Belt: refuse a default-branch commit unless the model explicitly
          // confirmed (which the approval dialog shows in the arguments) —
          // the note tells the user which branch this lands on either way.
          const status = await gitWrite.status(root)
          const onDefault = status.branch !== null && status.branch === status.defaultBranch
          if (onDefault && args.confirm_default_branch !== true) {
            return (
              `Refused: HEAD is on the default branch ('${status.branch}'). Create a branch ` +
              `first (action "create_branch"), or — only if the user explicitly asked to ` +
              `commit here — retry with confirm_default_branch: true and tell the user why.`
            )
          }
          const result = await gitWrite.commit(root, message)
          return `Committed ${result.sha}${result.branch ? ` on branch '${result.branch}'` : ''}.`
        }
        case 'create_branch': {
          const [branch, branchError] = requireStringArg(args, 'branch')
          if (branchError) return branchError
          return await gitWrite.createBranch(root, branch)
        }
        default:
          return "Error: 'action' must be one of stage | commit | create_branch."
      }
    } catch (e) {
      return redactSecrets(`git_write failed: ${errorMessage(e)}`)
    }
  }

  private async runGenerateImage(
    args: Record<string, unknown>,
    ctx: ToolExecuteContext
  ): Promise<string> {
    const [prompt, promptError] = requireStringArg(args, 'prompt')
    if (promptError) return promptError
    if (prompt.length > 4000) return "Error: 'prompt' is too long (max 4000 characters)."
    const generator = this.deps.imageGeneration
    if (!generator || !ctx.onAttachment) {
      return 'Error: image generation is unavailable in this context.'
    }
    const count = clampIntArg(args, 'count', 1, 4)
    const sizeRaw = getString(args, 'size') ?? 'auto'
    const size =
      sizeRaw === 'square' || sizeRaw === 'landscape' || sizeRaw === 'portrait' ? sizeRaw : 'auto'
    try {
      const attachments = await generator.generate({ prompt, count, size })
      for (const attachment of attachments) ctx.onAttachment(attachment)
      const modelId = attachments[0]?.generatedBy?.modelId ?? 'the configured image model'
      return (
        `Generated ${attachments.length} image${attachments.length === 1 ? '' : 's'} with ` +
        `${modelId}${size !== 'auto' ? ` (${size})` : ''}. ` +
        `They are shown to the user inside this message — do not invent a link.`
      )
    } catch (e) {
      return redactSecrets(`Image generation failed: ${errorMessage(e)}`)
    }
  }

  private async runFetchUrl(args: Record<string, unknown>): Promise<string> {
    const url = (getString(args, 'url') ?? '').trim()
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return `Error: '${url}' is not a valid absolute URL.`
    }
    if (parsed.protocol !== 'https:') {
      return `Error: fetch_url only allows https:// URLs (got '${parsed.protocol}//').`
    }
    if (parsed.username || parsed.password) {
      return 'Error: URLs with embedded credentials are not allowed.'
    }
    const blocked = ssrfRefusal(parsed)
    if (blocked) return blocked

    try {
      // GET only; no credentials, cookies or custom auth are ever attached.
      // Guarded: internal/loopback targets are refused on every redirect hop.
      return await this.fetchWithTimeout(
        parsed.toString(),
        {
          method: 'GET',
          headers: { accept: 'text/*, application/json, application/xml;q=0.9, */*;q=0.1' },
        },
        async (res) => {
          const contentType = res.headers.get('content-type') ?? ''
          if (!isTextualContentType(contentType)) {
            return `Error: refused non-textual response (content-type '${contentType || 'unknown'}'). Only text/*, JSON and XML responses are returned.`
          }
          const { text, truncated } = await readBodyCapped(res, FETCH_MAX_BYTES)
          return formatHttpResponse(res, text, truncated)
        },
        { blockInternal: true }
      )
    } catch (e) {
      if (e instanceof FetchGuardError) return e.message
      return redactSecrets(`Error fetching URL: ${errorMessage(e)}`)
    }
  }

  // -- shell suggestion (NEVER executes) --------------------------------------------

  private runProposeShellCommand(args: Record<string, unknown>): string {
    const [command, commandError] = requireStringArg(args, 'command')
    if (commandError) return commandError
    // There is intentionally NO execution path here: no child_process, no
    // shell, nothing. The renderer shows the suggestion; the user decides.
    return `Command suggested to the user (not executed): ${command}`
  }

  // -- browser + computer use --------------------------------------------------

  private requireBrowser(): ToolBrowser | string {
    if (!this.deps.browserEnabled?.()) {
      return 'Error: browser tools are disabled. The user can enable them in Settings → Tools.'
    }
    if (!this.deps.browser) return 'Error: the browser is unavailable in this build.'
    return this.deps.browser
  }

  private async runBrowser(args: Record<string, unknown>): Promise<string> {
    const browser = this.requireBrowser()
    if (typeof browser === 'string') return browser
    const action = (getString(args, 'action') ?? '').trim()
    switch (action) {
      case 'navigate':
        return browser.navigate((getString(args, 'url') ?? '').trim())
      case 'read':
        return browser.readPage()
      case 'back':
        return browser.back()
      case 'click': {
        const text = getString(args, 'text')
        if (text && text.trim()) return browser.clickSelector(text.trim(), true)
        const selector = (getString(args, 'selector') ?? '').trim()
        if (!selector) return "Error: 'click' needs a 'selector' or 'text'."
        return browser.clickSelector(selector, false)
      }
      case 'type': {
        const selector = (getString(args, 'selector') ?? '').trim()
        const text = getString(args, 'text') ?? ''
        if (!selector) return "Error: 'type' needs a 'selector'."
        return browser.typeText(selector, text)
      }
      default:
        return `Error: unknown browser action '${action}'.`
    }
  }

  private async runComputer(args: Record<string, unknown>): Promise<string> {
    const browser = this.requireBrowser()
    if (typeof browser === 'string') return browser
    const action = (getString(args, 'action') ?? '').trim()
    if (action.length === 0) return "Error: 'action' is required."
    let coordinate: [number, number] | undefined
    const raw = args.coordinate
    if (Array.isArray(raw) && raw.length === 2 && raw.every((n) => typeof n === 'number')) {
      coordinate = [raw[0] as number, raw[1] as number]
    }
    const text = getString(args, 'text') ?? undefined
    return browser.computer(action, coordinate, text)
  }

  // -- skills --------------------------------------------------------------------

  private runUseSkill(args: Record<string, unknown>): string {
    if (!this.deps.skills) return 'Error: skills are unavailable in this build.'
    const [name, nameError] = requireStringArg(args, 'name')
    if (nameError) return nameError
    const skill = this.deps.skills.getEnabledByName(name)
    if (!skill) {
      const available = this.deps.skills.listEnabledNames()
      return available.length > 0
        ? `Error: no enabled skill named '${name}'. Available skills: ${available.join(', ')}.`
        : `Error: no skills are installed and enabled.`
    }
    return `Skill '${skill.name}' instructions:\n\n${skill.content}`
  }

  // -- knowledge-base retrieval -------------------------------------------------

  private async runKnowledgeSearch(
    args: Record<string, unknown>,
    ctx: ToolExecuteContext
  ): Promise<string> {
    if (!this.deps.knowledgeSearch) {
      return 'Error: knowledge search is unavailable in this build.'
    }
    const kbId = ctx.conversation.knowledgeBaseId
    if (!kbId) {
      return 'Error: no knowledge base is attached to this conversation. The user can attach one in the conversation settings.'
    }
    const [query, queryError] = requireStringArg(args, 'query')
    if (queryError) return queryError
    const hits = await this.deps.knowledgeSearch(kbId, query)
    if (hits.length === 0) return 'No relevant passages found in the knowledge base.'
    return hits
      .map(
        (hit, i) =>
          `[${i + 1}] ${hit.source} (relevance ${hit.score.toFixed(2)})\n${hit.content}`
      )
      .join('\n\n---\n\n')
  }

  // -- sub-agent delegation ----------------------------------------------------

  private async runDelegate(
    args: Record<string, unknown>,
    ctx: ToolExecuteContext
  ): Promise<string> {
    if (!this.deps.delegate) return 'Error: sub-agent delegation is unavailable in this build.'
    const [task, taskError] = requireStringArg(args, 'task')
    if (taskError) return taskError
    const context = (getString(args, 'context') ?? '').trim()
    const agentName = (getString(args, 'agent') ?? '').trim() || undefined
    const prompt = context ? `${task}\n\nContext:\n${context}` : task
    if (args.background === true) {
      if (!this.deps.delegateBackground) {
        return 'Error: background tasks are unavailable in this build.'
      }
      return this.deps.delegateBackground.start(prompt, ctx, agentName)
    }
    return this.deps.delegate(prompt, ctx, agentName)
  }

  // -- shell execution (opt-in, approval-gated) --------------------------------

  private async runShellCommand(
    args: Record<string, unknown>,
    ctx: ToolExecuteContext,
    toolCall: ToolCallRecord
  ): Promise<string> {
    if (!this.deps.shellEnabled?.()) {
      return 'Error: shell command execution is disabled. The user can enable it in Settings → Tools.'
    }
    const root = this.requireProjectRoot(ctx)
    if (!root) return ToolExecutor.NO_PROJECT
    const [command, commandError] = requireStringArg(args, 'command')
    if (commandError) return commandError

    // Long-running work (dev servers, watch modes): detach as a background
    // job pollable via task_output / stoppable via task_stop.
    if (args.background === true) {
      if (!this.deps.shellBackground) {
        return 'Error: background shell jobs are unavailable in this build.'
      }
      return this.deps.shellBackground.start(command, root)
    }

    const timeoutMs =
      clampIntArg(args, 'timeoutSeconds', SHELL_TIMEOUT_MS / 1000, SHELL_MAX_TIMEOUT_SEC) * 1000
    const onToolOutput = ctx.onToolOutput
    const onChunk = onToolOutput ? (chunk: string) => onToolOutput(toolCall.id, chunk) : undefined
    const result = await runShell(command, root, timeoutMs, ctx.signal, onChunk)
    const parts: string[] = []
    if (result.timedOut) {
      parts.push(`Command timed out after ${timeoutMs / 1000}s and was killed.`)
    } else if (result.aborted) {
      parts.push('Command was aborted.')
    } else {
      parts.push(`Exit code: ${result.code ?? 'unknown'}`)
    }
    if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trimEnd()}`)
    if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trimEnd()}`)
    return redactSecrets(parts.join('\n\n')) || '(no output)'
  }

  // -- custom HTTP tools --------------------------------------------------------------

  private async runCustomTool(
    definition: ToolDefinition,
    args: Record<string, unknown>
  ): Promise<string> {
    const record = this.deps.registry.getCustomToolRecord(definition.id)
    if (!record) return `Error: custom tool '${definition.name}' no longer exists.`

    const publicHeaders = customToolHeaders(record)
    const secretHeaders = this.deps.resolveSecretHeaders?.(definition.id) ?? {}
    const headers = { ...publicHeaders, ...secretHeaders }
    // Redact every header value from results; secret values especially must
    // never surface, but stripping known values in general is harmless here.
    const secrets = Object.values(headers)
    let url: URL
    try {
      url = new URL(record.baseUrl)
    } catch {
      return `Error: custom tool '${definition.name}' has an invalid base URL.`
    }

    const method = record.method.toUpperCase()
    const init: RequestInit = { method, headers: { ...headers } }
    if (method === 'GET' || method === 'DELETE') {
      for (const [key, value] of Object.entries(args)) {
        url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value))
      }
    } else {
      init.body = JSON.stringify(args)
      init.headers = { 'content-type': 'application/json', ...headers }
    }

    try {
      // Guarded: secret headers are configured for this origin only, so a
      // cross-origin redirect must not carry them to another host.
      return await this.fetchWithTimeout(
        url.toString(),
        init,
        async (res) => {
          const contentType = res.headers.get('content-type') ?? ''
          if (!isTextualContentType(contentType)) {
            return `Error: custom tool '${definition.name}' returned a non-textual response (content-type '${contentType || 'unknown'}').`
          }
          const { text, truncated } = await readBodyCapped(res, FETCH_MAX_BYTES)
          // SUCCESS path: strip only the known header/secret values so legitimate
          // hashes/ids in the response body survive intact (generic patterns would
          // corrupt them). Error paths below still use full redactSecrets.
          return redactKnownSecrets(formatHttpResponse(res, text, truncated), secrets)
        },
        { sameOriginRedirectsOnly: true }
      )
    } catch (e) {
      if (e instanceof FetchGuardError) return redactSecrets(e.message, secrets)
      return redactSecrets(
        `Error calling custom tool '${definition.name}': ${errorMessage(e)}`,
        secrets
      )
    }
  }
}
