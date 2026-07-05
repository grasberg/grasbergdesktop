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
import type { Conversation, ToolApprovalRequest, ToolCallRecord, ToolDefinition } from '@shared/types'
import type { CodeReadFileResult } from '@shared/ipc'
import { encodeTaskList, type TaskListItem } from '@shared/tasklist'
import { redactKnownSecrets, redactSecrets } from '../providers/redact'
import { looksBinary } from '../utils/binary'
import { capToolResult } from './definitions'
import { customToolHeaders } from './custom-tools'
import { isMcpToolId } from './mcp/naming'
import { runShell } from './shell'
import { runGitQuery } from './git'
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
  /** Whether the browser/computer tools may run (user opt-in). */
  browserEnabled?: () => boolean
  /** Embedded browser for the browser/computer tools. */
  browser?: ToolBrowser | null
  /** Runs a sub-agent for the 'delegate' tool (wired to ChatService.runDelegate). */
  delegate?: (task: string, ctx: ToolExecuteContext) => Promise<string>
  /** Background sub-agent tasks (delegate background=true + task_output/task_stop). */
  delegateBackground?: {
    start(task: string, ctx: ToolExecuteContext): string
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
   * Asks the user. Resolve true to run the tool, false to decline.
   * The integration layer generates the requestId and routes the answer.
   */
  approval: (req: Omit<ToolApprovalRequest, 'requestId'>) => Promise<boolean>
  /** Shows an ask_user_question dialog; null = dismissed/unanswered. */
  askUser?: (question: string, options: string[]) => Promise<string | null>
  /** Plan mode (code conversations): mutating tools are refused. */
  planMode?: boolean
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
const GREP_DEFAULT_RESULTS = 40
const GREP_MAX_RESULTS = 100
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

/**
 * Conservative catastrophic-backtracking guard for model-supplied regexes.
 *
 * A regex runs synchronously on the main thread over every line of every
 * scanned file; a pattern like `(\w+\s?)*;$` takes exponential time on a long
 * non-matching line and freezes the whole app (Stop can't even be delivered).
 * This build has no worker/RE2 to run the match with a timeout, so instead we
 * refuse the classic ReDoS shape: an unbounded quantifier ('*' or '+') applied
 * to a group whose body itself contains an unbounded quantifier (directly or
 * nested). Rejecting a few exotic-but-safe patterns is an acceptable price for
 * never freezing; the model is told to simplify.
 */
export function hasCatastrophicBacktracking(source: string): boolean {
  // One entry per open group: does its body contain an unbounded quantifier?
  const stack: boolean[] = []
  let escaped = false
  let inClass = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (inClass) {
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') {
      inClass = true
      continue
    }
    if (ch === '(') {
      stack.push(false)
      continue
    }
    if (ch === '*' || ch === '+') {
      if (stack.length > 0) stack[stack.length - 1] = true
      continue
    }
    if (ch === ')') {
      const bodyQuantified = stack.pop() ?? false
      const next = source[i + 1]
      const groupIsQuantified = next === '*' || next === '+' || next === '{'
      if (bodyQuantified && groupIsQuantified) return true
      // Propagate "contains an unbounded quantifier" to the parent group so a
      // quantifier nested any number of levels deep is still caught.
      if (bodyQuantified && stack.length > 0) stack[stack.length - 1] = true
      continue
    }
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
    if (decision === 'ask') {
      const approved = await ctx.approval({
        streamId: ctx.streamId ?? '',
        conversationId: ctx.conversation.id,
        toolCall,
        risk: definition.risk,
      })
      if (!approved) return USER_DECLINED_RESULT
    }

    return this.runTool(definition, args, ctx)
  }

  private async runTool(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    ctx: ToolExecuteContext
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
        return this.runShellCommand(args, ctx)
      case 'use_skill':
        return this.runUseSkill(args)
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
    'Error: no project folder has been granted for this conversation. ' +
    'Ask the user to open a project folder (Code mode) before using file tools.'

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
      return "Error: that pattern risks catastrophic backtracking (a repeated group that itself repeats, e.g. '(\\w+\\s?)*'). Simplify it — avoid nesting one unbounded quantifier inside another."
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

    const lines: string[] = []
    for (const file of await walkProjectFiles(root)) {
      if (lines.length >= maxResults) break
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
        if (!pattern.test(contentLines[i])) continue
        const text = contentLines[i].trim().slice(0, SEARCH_LINE_MAX_CHARS)
        lines.push(file.relPath + ':' + (i + 1) + ': ' + text)
      }
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
    const root = this.requireProjectRoot(ctx)
    if (!root) return ToolExecutor.NO_PROJECT
    if (!this.deps.codeChanges || !this.deps.codeService || !ctx.conversation.projectId) {
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
    consume: (res: Response) => Promise<T>
  ): Promise<T> {
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      return await consume(await fetchImpl(url, { ...init, signal: controller.signal }))
    } finally {
      clearTimeout(timer)
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

    try {
      // GET only; no credentials, cookies or custom auth are ever attached.
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
        }
      )
    } catch (e) {
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

  // -- sub-agent delegation ----------------------------------------------------

  private async runDelegate(
    args: Record<string, unknown>,
    ctx: ToolExecuteContext
  ): Promise<string> {
    if (!this.deps.delegate) return 'Error: sub-agent delegation is unavailable in this build.'
    const [task, taskError] = requireStringArg(args, 'task')
    if (taskError) return taskError
    const context = (getString(args, 'context') ?? '').trim()
    const prompt = context ? `${task}\n\nContext:\n${context}` : task
    if (args.background === true) {
      if (!this.deps.delegateBackground) {
        return 'Error: background tasks are unavailable in this build.'
      }
      return this.deps.delegateBackground.start(prompt, ctx)
    }
    return this.deps.delegate(prompt, ctx)
  }

  // -- shell execution (opt-in, approval-gated) --------------------------------

  private async runShellCommand(
    args: Record<string, unknown>,
    ctx: ToolExecuteContext
  ): Promise<string> {
    if (!this.deps.shellEnabled?.()) {
      return 'Error: shell command execution is disabled. The user can enable it in Settings → Tools.'
    }
    const root = this.requireProjectRoot(ctx)
    if (!root) return ToolExecutor.NO_PROJECT
    const [command, commandError] = requireStringArg(args, 'command')
    if (commandError) return commandError

    const result = await runShell(command, root, SHELL_TIMEOUT_MS)
    const parts: string[] = []
    if (result.timedOut) {
      parts.push(`Command timed out after ${SHELL_TIMEOUT_MS / 1000}s and was killed.`)
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
      return await this.fetchWithTimeout(url.toString(), init, async (res) => {
        const contentType = res.headers.get('content-type') ?? ''
        if (!isTextualContentType(contentType)) {
          return `Error: custom tool '${definition.name}' returned a non-textual response (content-type '${contentType || 'unknown'}').`
        }
        const { text, truncated } = await readBodyCapped(res, FETCH_MAX_BYTES)
        // SUCCESS path: strip only the known header/secret values so legitimate
        // hashes/ids in the response body survive intact (generic patterns would
        // corrupt them). Error paths below still use full redactSecrets.
        return redactKnownSecrets(formatHttpResponse(res, text, truncated), secrets)
      })
    } catch (e) {
      return redactSecrets(
        `Error calling custom tool '${definition.name}': ${errorMessage(e)}`,
        secrets
      )
    }
  }
}
