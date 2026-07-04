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
import { redactKnownSecrets, redactSecrets } from '../providers/redact'
import { TOOL_RESULT_MAX_CHARS } from './definitions'
import { customToolHeaders } from './custom-tools'
import { isMcpToolId } from './mcp/naming'
import { runShell } from './shell'
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
  fileTree(projectId: string): unknown
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

function capResult(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n…[truncated]`
}

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

function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, 8192)
  return probe.includes(0)
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
      if (total >= maxBytes) {
        truncated = total > maxBytes
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

interface WalkEntry {
  relPath: string
  absPath: string
  sizeBytes: number
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
        try {
          sizeBytes = (await fs.stat(entryAbs)).size
        } catch {
          continue
        }
        results.push({ relPath: entryRel, absPath: entryAbs, sizeBytes })
      }
    }
  }

  await walk(path.resolve(root), '', 0)
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
      return capResult(await this.executeInner(toolCall, ctx))
    } catch (e) {
      return capResult(redactSecrets(`Tool execution failed: ${errorMessage(e)}`))
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

    const query = (getString(args, 'query') ?? '').trim()
    if (query.length === 0) return "Error: 'query' must be a non-empty string."
    const rawMax = typeof args.maxResults === 'number' ? Math.floor(args.maxResults) : NaN
    const maxResults = Number.isFinite(rawMax)
      ? Math.min(Math.max(rawMax, 1), SEARCH_MAX_RESULTS)
      : SEARCH_DEFAULT_RESULTS

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
    const query = (getString(args, 'query') ?? '').trim()
    if (query.length === 0) return "Error: 'query' must be a non-empty string."
    const rawMax = typeof args.maxResults === 'number' ? Math.floor(args.maxResults) : NaN
    const maxResults = Number.isFinite(rawMax) ? Math.min(Math.max(rawMax, 1), 30) : 12

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

    const relPath = (getString(args, 'path') ?? '').trim()
    if (relPath.length === 0) return "Error: 'path' must be a non-empty string."
    const absPath = resolveWithinRoot(root, relPath)
    if (!absPath) {
      return `Error: '${relPath}' is outside the granted project folder; access refused.`
    }

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
    const absPath = resolveWithinRoot(root, relPath)
    if (!absPath) {
      return `Error: '${relPath}' is outside the granted project folder; access refused.`
    }

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

  // -- network tools --------------------------------------------------------------

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

    const fetchImpl = this.deps.fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      // GET only; no credentials, cookies or custom auth are ever attached.
      const res = await fetchImpl(parsed.toString(), {
        method: 'GET',
        signal: controller.signal,
        headers: { accept: 'text/*, application/json, application/xml;q=0.9, */*;q=0.1' },
      })
      const contentType = res.headers.get('content-type') ?? ''
      if (!isTextualContentType(contentType)) {
        return `Error: refused non-textual response (content-type '${contentType || 'unknown'}'). Only text/*, JSON and XML responses are returned.`
      }
      const { text, truncated } = await readBodyCapped(res, FETCH_MAX_BYTES)
      const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`
      return `${status}\n\n${text}${truncated ? '\n…[truncated at 512KB]' : ''}`
    } catch (e) {
      return redactSecrets(`Error fetching URL: ${errorMessage(e)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  // -- shell suggestion (NEVER executes) --------------------------------------------

  private runProposeShellCommand(args: Record<string, unknown>): string {
    const command = (getString(args, 'command') ?? '').trim()
    if (command.length === 0) return "Error: 'command' must be a non-empty string."
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

  // -- sub-agent delegation ----------------------------------------------------

  private async runDelegate(
    args: Record<string, unknown>,
    ctx: ToolExecuteContext
  ): Promise<string> {
    if (!this.deps.delegate) return 'Error: sub-agent delegation is unavailable in this build.'
    const task = (getString(args, 'task') ?? '').trim()
    if (task.length === 0) return "Error: 'task' must be a non-empty string."
    const context = (getString(args, 'context') ?? '').trim()
    const prompt = context ? `${task}\n\nContext:\n${context}` : task
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
    const command = (getString(args, 'command') ?? '').trim()
    if (command.length === 0) return "Error: 'command' must be a non-empty string."

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
    const init: RequestInit = { method, signal: undefined, headers: { ...headers } }
    if (method === 'GET' || method === 'DELETE') {
      for (const [key, value] of Object.entries(args)) {
        url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value))
      }
    } else {
      init.body = JSON.stringify(args)
      init.headers = { 'content-type': 'application/json', ...headers }
    }

    const fetchImpl = this.deps.fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    init.signal = controller.signal
    try {
      const res = await fetchImpl(url.toString(), init)
      const contentType = res.headers.get('content-type') ?? ''
      if (!isTextualContentType(contentType)) {
        return `Error: custom tool '${definition.name}' returned a non-textual response (content-type '${contentType || 'unknown'}').`
      }
      const { text, truncated } = await readBodyCapped(res, FETCH_MAX_BYTES)
      const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`
      // SUCCESS path: strip only the known header/secret values so legitimate
      // hashes/ids in the response body survive intact (generic patterns would
      // corrupt them). Error paths below still use full redactSecrets.
      return redactKnownSecrets(
        `${status}\n\n${text}${truncated ? '\n…[truncated at 512KB]' : ''}`,
        secrets
      )
    } catch (e) {
      return redactSecrets(
        `Error calling custom tool '${definition.name}': ${errorMessage(e)}`,
        secrets
      )
    } finally {
      clearTimeout(timer)
    }
  }
}
