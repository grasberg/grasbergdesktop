/**
 * Chat orchestration: resolves provider/model/params, persists messages,
 * drives adapter streams in detached loops (including the multi-round tool
 * loop), and forwards stream events to all renderer windows. The API key is
 * decrypted only inside the send/regenerate/editAndRerun call path and never
 * leaves this module.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type {
  AgentProfile,
  AppSettings,
  Attachment,
  AuthMode,
  ChatParams,
  Conversation,
  ConversationMode,
  Message,
  MessageStatus,
  MoaPreset,
  MoaReferenceOutput,
  NormalizedError,
  ProviderConfig,
  ProviderType,
  ResearchDepth,
  ResearchRunInfo,
  StartStreamResult,
  StreamEvent,
  StreamEventEnvelope,
  TokenUsage,
  ToolApprovalAnswer,
  ToolApprovalRequest,
  ToolCallRecord,
  ToolDefinition,
  UserQuestionRequest,
} from '@shared/types'
import {
  CHANNELS,
  type ChatEditAndRerunRequest,
  type ChatPickCompareWinnerRequest,
  type ChatPickCompareWinnerResult,
  type ChatRegenerateRequest,
  type ChatSendRequest,
} from '@shared/ipc'
import {
  PROVIDER_TYPES,
  modelSupportsTools,
  modelSupportsVision,
  providerSupportsImageOutput,
  resolveImageModelCatalog,
  resolveModelCatalog,
  resolveModelInfo,
} from '@shared/catalog'
import type { AppDatabase } from '../db/database'
import type { MessagePatch } from '../db/repositories/messages'
import type {
  AdapterContext,
  AdapterImageRequest,
  AdapterMessage,
  AdapterToolDef,
  ContentPart,
  ProviderAdapter,
} from '../providers/adapter'
import { resolveAdapter as resolveAdapterForProvider } from '../providers/registry'
import { ProviderError, toNormalizedError } from '../providers/errors'
import { decryptKey } from '../keys/keystore'
import { buildMemorySection, buildModeSystemPrompt, type ModePromptOptions } from '../prompts'
import type { ToolExecuteContext } from '../tools/executor'
import { HEADLESS_CONVERSATION_ID, USER_DECLINED_RESULT } from '../tools/executor'
import { runShell } from '../tools/shell'
import { redactSecrets } from '../providers/redact'
import { KEYLESS_API_KEY, isLoopbackBaseUrl, isValidStorageKey } from '@shared/schemas'
import { formatSourcesSection } from '@shared/citations'
import { storeGeneratedImage } from '../ipc/attachments'
import { runCompletionHooks } from './completion-hooks'
import { extractMemoryDirectives } from './mode-artifacts'
import { findPricing } from '@shared/pricing'
import { presetPricing } from '@shared/presets'
import { runResearchPipeline, type ResearchDeps, type ResearchOutcome } from './research'
import { StreamDeltaBuffer } from './stream-delta-buffer'

const DEFAULT_TITLE = 'New chat'
const TITLE_MAX_CHARS = 60

/** Pure policy core used by Auto routing and unit tests. */
export function pickAutoRouteProvider(
  providers: ProviderConfig[],
  settings: Pick<AppSettings, 'autoRoutingPolicy' | 'autoRoutingMaxCostUsd'>
): string | null {
  const isLocal = (provider: ProviderConfig): boolean => {
    try {
      const host = new URL(provider.baseUrl).hostname
      return host === 'localhost' || host === '127.0.0.1' || host === '::1'
    } catch {
      return false
    }
  }
  const cost = (provider: ProviderConfig): number | null => {
    if (isLocal(provider)) return 0
    // A preset-backed provider is type 'openai-compatible', whose pricing table
    // is empty by design — its prices live in the preset catalog.
    const pricing = provider.presetId
      ? presetPricing(provider.presetId, provider.defaultModelId)
      : findPricing(provider.type, provider.defaultModelId)
    return pricing ? pricing.inputPerMTok + pricing.outputPerMTok * 2 : null
  }
  let candidates = providers.filter(
    (provider) => provider.enabled && (provider.hasKey || provider.oauthConnected)
  )
  if (settings.autoRoutingPolicy === 'local_only') {
    candidates = candidates.filter(isLocal)
  }
  if (settings.autoRoutingMaxCostUsd !== null) {
    // Conservative preflight: assume 2k input + 2k output tokens for the
    // first model call. Unknown-priced remote models cannot satisfy a budget.
    candidates = candidates.filter((provider) => {
      const score = cost(provider)
      if (score === null) return false
      return (score * 2_000) / 1_000_000 <= settings.autoRoutingMaxCostUsd!
    })
  }
  // Decode pricing once per provider up front: a comparator would call cost()
  // O(n log n) times, re-scanning the preset tuple table on every comparison.
  const costs = new Map<ProviderConfig, number | null>(candidates.map((p) => [p, cost(p)]))
  const policy = settings.autoRoutingPolicy
  candidates.sort((a, b) => {
    const aCost = costs.get(a)
    const bCost = costs.get(b)
    if (policy === 'highest_quality') {
      return (bCost ?? -1) - (aCost ?? -1)
    }
    return (aCost ?? Number.POSITIVE_INFINITY) - (bCost ?? Number.POSITIVE_INFINITY)
  })
  return candidates[0]?.id ?? null
}

/**
 * Maximum number of tool-execution rounds per generation. Each round is one
 * adapter invocation that finished with 'tool_calls' followed by executing
 * those calls and feeding the results back. Generous by design — real agent
 * work (search → read → edit → test → fix) burns many rounds; the cap is a
 * runaway backstop, not a workflow limit. When the model asks for tools yet
 * again past the cap, the remaining calls are recorded (unexecuted) and the
 * generation finishes with a note appended to the content.
 */
const MAX_TOOL_ROUNDS = 40

const TOOL_LIMIT_NOTE =
  `[Tool-call limit reached (${MAX_TOOL_ROUNDS} rounds) — the remaining tool calls were not run.]`

/** Placeholder held in activeByConversation between reservation and start(). */
const PENDING_STREAM = '__pending__'

/**
 * Cap on each tool result replayed from an earlier turn, so old tool output
 * can't crowd the fresh turn out of the context window.
 */
const REPLAY_TOOL_RESULT_MAX_CHARS = 4000

function truncateToolResultForReplay(result: string): string {
  if (result.length <= REPLAY_TOOL_RESULT_MAX_CHARS) return result
  return `${result.slice(0, REPLAY_TOOL_RESULT_MAX_CHARS)}\n…[truncated for replay]`
}

/** Repo-root instruction files injected into work-mode prompts (first found wins). */
const PROJECT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const
const PROJECT_INSTRUCTIONS_MAX_CHARS = 16_000

/**
 * What the '/init' slash command sends to the model in place of the literal
 * message (the transcript still shows '/init'). Kept in main so regenerate /
 * edit+rerun replay the same expansion.
 */
export const INIT_COMMAND_PROMPT = `Analyze this codebase and create an AGENTS.md file that will guide future assistant sessions working in this repository.

Explore first: use repo_map, glob, grep and read_file (start with the README, package manifests, build and test configs) until you understand how the project is built, tested and organized.

What to include:
- Commonly used commands — build, lint, test, and how to run a single test.
- The big-picture architecture that requires reading multiple files to understand: the main components and how they connect.
- Project-specific conventions and rules an assistant must follow (naming, patterns, things deliberately done differently).

What NOT to include:
- Generic advice ("write tests", "handle errors"), exhaustive file listings, or anything obvious from a quick directory listing.

If a CLAUDE.md file exists, use it as the starting point. If AGENTS.md already exists, improve it rather than duplicating it. Keep the result focused — roughly 20 to 60 lines.

Create the file at the repository root with the write_file tool (path "AGENTS.md"). If file-writing tools are unavailable, emit a uld-change block instead.`

/**
 * Expands a slash command in a user message to its full prompt for the wire.
 * '/init' (work mode) and '/skill <name> [task]' expand; everything else
 * passes through verbatim. The transcript keeps the short command.
 */
export function expandSlashCommand(content: string, mode: ConversationMode): string {
  const trimmed = content.trim()
  if (mode === 'work' && trimmed === '/init') return INIT_COMMAND_PROMPT
  const skillMatch = /^\/skill\s+(\S+)(?:\s+([\s\S]+))?$/.exec(trimmed)
  if (skillMatch) {
    const [, name, task] = skillMatch
    return (
      `Load the skill "${name}" with the use_skill tool and follow its instructions` +
      (task ? ` for this task:\n\n${task}` : '.')
    )
  }
  return content
}

/** True when a user message is a slash command that expands on the wire. */
export function isExpandingSlashCommand(content: string, mode: ConversationMode): boolean {
  return expandSlashCommand(content, mode) !== content
}

/** Concurrent background tasks (delegate/shell background=true). */
const MAX_BACKGROUND_TASKS = 8
/**
 * How many terminal (done/error/stopped) background-task records to retain so
 * the model can still poll a recently finished task. Records past this cap are
 * evicted oldest-first; without this the registry grew unbounded for the whole
 * process lifetime (each record pinning its result string + AbortController).
 */
const MAX_RETAINED_TERMINAL_TASKS = 32
/** Hard runtime cap for a background shell job. */
const SHELL_BACKGROUND_TIMEOUT_MS = 30 * 60_000

/** Hard cap for one generate_image call (providers can take tens of seconds). */
const IMAGE_GENERATION_TIMEOUT_MS = 180_000

interface BackgroundTask {
  status: 'running' | 'done' | 'error' | 'stopped'
  result: string
  controller: AbortController
  /** Shell jobs: output captured so far (task_output shows it while running). */
  getPartial?: () => string
  /** Persistent control-plane row for delegate jobs (shell jobs omit it). */
  runId?: string
}

type Broadcast = (channel: string, payload: unknown) => void

// ---------------------------------------------------------------------------
// Tool-system seams (structural, so tests can stub them without the real
// registry/executor/broker classes; the real ones satisfy these directly).
// ---------------------------------------------------------------------------

export interface ChatToolRegistry {
  listEnabledDefinitions(): ToolDefinition[]
}

export interface ChatToolExecutor {
  /** Never throws; every failure path resolves to a readable string. */
  execute(toolCall: ToolCallRecord, ctx: ToolExecuteContext): Promise<string>
}

export interface ChatApprovalBroker {
  request(
    req: Omit<ToolApprovalRequest, 'requestId'>,
    broadcast: Broadcast,
    signal?: AbortSignal
  ): Promise<ToolApprovalAnswer>
}

export interface ChatQuestionBroker {
  request(
    req: Omit<UserQuestionRequest, 'requestId'>,
    broadcast: Broadcast,
    signal?: AbortSignal
  ): Promise<string | null>
}

export interface ChatToolSystem {
  registry: ChatToolRegistry
  executor: ChatToolExecutor
  broker: ChatApprovalBroker
  /** Optional: routes ask_user_question dialogs (absent in tests/headless). */
  questions?: ChatQuestionBroker
}

export interface ChatServiceOptions {
  /** When absent, generations never offer tools (MVP behaviour). */
  tools?: ChatToolSystem
  /** Test seam: adapter resolution (defaults to the real provider registry). */
  resolveAdapter?: (type: ProviderType, authMode: AuthMode) => ProviderAdapter
  /**
   * Resolves an OAuth access token (+ account id) for providers using a login
   * flow. Injected from the OpenAI OAuth manager; absent in tests/headless.
   */
  getAccessToken?: (
    providerId: string,
    signal?: AbortSignal
  ) => Promise<{ accessToken: string; accountId: string | null }>
  /** Directory holding stored image attachments (for the vision wire payload). */
  imageDir?: string
  /** Embedded browser — a computer-use screenshot is injected after each round. */
  browser?: { consumePendingScreenshot(): string | null }
  /**
   * Asks the user to approve one tool call over a side channel (the paired
   * Telegram chat). Headless runs have no dialog to pop, so without this they
   * can only auto-decline; with it, a scheduled task can ask instead of
   * failing. Resolves true/false, or null when no channel is available or
   * nobody answered — null is always treated as a decline.
   */
  remoteApproval?: (input: {
    requestKey: string
    title: string
    detail: string
    /** Aborting the run cancels the outstanding remote question. */
    signal?: AbortSignal
  }) => Promise<boolean | null>
  /**
   * Puts a multiple-choice question from a headless run to the user over the
   * same side channel. This is what lets a scheduled task or a background
   * sub-agent raise its hand instead of guessing: null (no channel, no answer)
   * simply means it has to proceed on its own judgement.
   */
  remoteChoice?: (input: {
    requestKey: string
    question: string
    options: string[]
    signal?: AbortSignal
  }) => Promise<string | null>
  /**
   * A background delegate run reached a terminal state. Wired to the desktop
   * notifier so a result that landed while the user was elsewhere announces
   * itself instead of waiting silently in the inbox.
   */
  onBackgroundRunFinished?: (info: {
    label: string
    status: 'done' | 'error'
    task: string
    result: string
    conversationId: string
  }) => void
}

interface ResolvedTarget {
  provider: ProviderConfig
  modelId: string
  params: ChatParams
  /** Bearer credential: API key or OAuth access token. */
  apiKey: string
  /** OAuth account id for the ChatGPT backend header; null for API-key auth. */
  accountId: string | null
}

interface ActiveStream {
  controller: AbortController
  conversationId: string
  /** Resolves when the detached runStream loop has fully settled (persisted). */
  done: Promise<void>
}

/** One send's resolved deep-research request (the /research command/toggle). */
interface ResearchRunRequest {
  depth: ResearchDepth
  /** The user's question, fed to the planner and workers. */
  question: string
}

/** How the tool system participates in one generation. */
interface ToolPlan {
  /** Definitions offered to the model; undefined = no tools on the wire. */
  adapterTools?: AdapterToolDef[]
  /** Mode-prompt options (manual-instructions fallback when unsupported). */
  promptOpts: ModePromptOptions
}

/**
 * Registry definition -> wire format. The wire function name MUST match the
 * provider pattern ^[A-Za-z0-9_-]{1,64}$ — def.name satisfies it for every
 * source: builtins (name === id), custom tools (user name validated to that
 * pattern — def.id is 'custom:<uuid>', which the ':' makes invalid), and MCP
 * tools (name === namespaced id). registry.resolveForCall() maps the returned
 * name back to the definition.
 */
function toAdapterToolDef(def: ToolDefinition): AdapterToolDef {
  return { name: def.name, description: def.description, parameters: def.parameters }
}

/** Sums token usage across tool-loop rounds (missing fields stay missing). */
function addUsage(total: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  if (!total) return { ...next }
  const add = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
  return {
    promptTokens: add(total.promptTokens, next.promptTokens),
    completionTokens: add(total.completionTokens, next.completionTokens),
    totalTokens: add(total.totalTokens, next.totalTokens),
    cachedInputTokens: add(total.cachedInputTokens, next.cachedInputTokens),
    cacheCreationTokens: add(total.cacheCreationTokens, next.cacheCreationTokens),
  }
}

/**
 * Derives the persisted ToolCallRecord status from the executor's result.
 * The executor never throws and does not report a status, so the only status
 * we can infer reliably is a user decline — signalled by the exact
 * USER_DECLINED_RESULT sentinel. Every other result (including tool outputs
 * that happen to begin with the word "Error") counts as a completed call: the
 * model still gets the string and decides what to do with it.
 */
function toolCallStatus(result: string): ToolCallRecord['status'] {
  return result === USER_DECLINED_RESULT ? 'denied' : 'done'
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    if (value && value.trim().length > 0) return value
  }
  return undefined
}

/** Reads a stored image attachment as a data URL, or null when unavailable. */
function imageDataUrl(
  attachment: NonNullable<Message['attachments']>[number],
  imageDir: string | undefined
): string | null {
  if (attachment.dataUrl) return attachment.dataUrl
  if (!imageDir || !attachment.storageKey) return null
  // A storageKey arrives over IPC (chat.send) length-capped only, so reject
  // anything that is not the app-generated '<uuid>.<ext>' shape before touching
  // the filesystem — otherwise '../../..' escapes imageDir (arbitrary file read).
  if (!isValidStorageKey(attachment.storageKey)) return null
  try {
    const buffer = readFileSync(join(imageDir, attachment.storageKey))
    return `data:${attachment.mimeType};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * User message as sent to the provider. Text attachments are inlined into the
 * text; images become OpenAI content parts when the model supports vision.
 * Returns a plain string when there are no images (zero-regression path).
 */
function composeUserContent(
  message: Message,
  visionEnabled: boolean,
  imageDir: string | undefined
): string | ContentPart[] {
  let text = message.content
  const images: ContentPart[] = []
  for (const attachment of message.attachments ?? []) {
    if (attachment.kind === 'image') {
      if (!visionEnabled) {
        text += `\n\n[Attached image: ${attachment.name} — this model has no vision support and it was not sent]`
        continue
      }
      const dataUrl = imageDataUrl(attachment, imageDir)
      if (dataUrl) {
        images.push({ type: 'image_url', image_url: { url: dataUrl } })
      } else {
        text += `\n\n[Attached image: ${attachment.name} — could not be read and was not sent]`
      }
      continue
    }
    if (!attachment.textContent) {
      // No extractable text (binary/unreadable): tell the model it exists but
      // was not sent, rather than silently dropping it and misleading it.
      text += `\n\n[Attached file: ${attachment.name} — could not be read as text and was not sent]`
      continue
    }
    text += `\n\n[Attached file: ${attachment.name}]\n\`\`\`\n${attachment.textContent}\n\`\`\``
  }
  if (images.length === 0) return text
  const parts: ContentPart[] = []
  if (text.trim().length > 0) parts.push({ type: 'text', text })
  parts.push(...images)
  return parts
}

/** True when a message has no text and no image parts (safe to drop). */
function contentIsEmpty(content: string | ContentPart[]): boolean {
  return typeof content === 'string' ? content.trim().length === 0 : content.length === 0
}

// -- memory ---------------------------------------------------------------------

/** Most-recent memories injected into the system prompt (char-capped there). */
const MEMORY_MAX_INJECTED = 50

// -- context compaction -------------------------------------------------------

/** Assumed context window when the model is not in the catalog. */
const DEFAULT_CONTEXT_LENGTH = 32_000
/** Recent messages always kept verbatim (never summarized away). */
const COMPACTION_KEEP_RECENT = 6
const COMPACTION_INSTRUCTION =
  'You are compacting a conversation to save context. Summarize the exchange ' +
  'below concisely but completely: preserve decisions, facts, code, names, open ' +
  'questions and any instructions the user gave. Write it as notes the assistant ' +
  'can rely on to continue. Output only the summary.'

interface HistoryBuildOptions {
  settings: AppSettings
  promptOpts: ModePromptOptions
  visionEnabled: boolean
}

/** Cheap token estimate (~4 chars/token). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// -- sub-agent delegation -----------------------------------------------------

const DELEGATE_MAX_ROUNDS = 12

/** Tool rounds for a workflow ai_agent node with useTools (headless, bounded). */
const WORKFLOW_AGENT_MAX_ROUNDS = 8
/**
 * Builtin tools a delegated sub-agent may use. Mostly read-only plus the
 * approval-gated file editors: every edit_file/write_file call still goes
 * through the parent's approval flow (and the audited change pipeline), so a
 * sub-agent can carry out real work without widening the write path.
 */
const DELEGATE_TOOL_IDS = new Set([
  'file_search',
  'repo_map',
  'read_file',
  'list_directory',
  'grep',
  'glob',
  'git',
  'fetch_url',
  'edit_file',
  'write_file',
  // A sub-agent that hits a genuine fork in the road can ask instead of
  // guessing; the question reaches the user wherever they are (dialog,
  // notification, or the paired chat).
  'ask_user_question',
])
const DELEGATE_PERSONA =
  'You are a focused sub-agent working on a single delegated task. You do not see the parent ' +
  'conversation — work only from the task and context you are given. Use the available tools ' +
  'when they help (file edits still require the user’s approval), then return a concise, ' +
  'self-contained result. Prefer reasonable assumptions and state them; use ask_user_question ' +
  'only for a genuine fork you cannot resolve, where guessing wrong would waste the work.'

// -- mixture of agents --------------------------------------------------------

/**
 * The private context appended to the aggregator's latest user turn: the advisor
 * (reference) model outputs framed as material to synthesize. Mirrors Hermes'
 * "reference outputs as private context for the aggregator".
 */
function formatMoaContext(references: MoaReferenceOutput[], preset: MoaPreset): string {
  const blocks = references.map((ref) =>
    ref.status === 'error'
      ? `### ${ref.label}\n[This advisor was unavailable: ${ref.error?.message ?? 'error'}]`
      : `### ${ref.label}\n${ref.text.trim() || '[empty response]'}`
  )
  return (
    `You are the aggregator in a Mixture-of-Agents system named "${preset.name}". ` +
    `Below are independent analyses of the user's latest message from advisor models. ` +
    `Weigh them critically — they may disagree, omit things or be wrong — and synthesize a ` +
    `single, best response in your own voice. Do not merely repeat or list them, and do not ` +
    `mention this process unless the user asks.\n\n` +
    `--- Advisor analyses ---\n\n${blocks.join('\n\n')}`
  )
}

/**
 * Appends `text` to the last user message's content (Hermes appends reference
 * context to the tail of the latest user turn). Keeps role alternation valid for
 * strict providers by never inserting a second consecutive user message unless
 * there is no user message at all.
 */
function appendContextToLastUser(messages: AdapterMessage[], text: string): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    const content = messages[i].content
    messages[i] =
      typeof content === 'string'
        ? { ...messages[i], content: `${content}\n\n${text}` }
        : { ...messages[i], content: [...content, { type: 'text', text }] }
    return
  }
  messages.push({ role: 'user', content: text })
}

/** Text of a message for estimation/summarization (inlines attachment text). */
function messageEstimateText(message: Message): string {
  let text = message.content
  for (const attachment of message.attachments ?? []) {
    if (attachment.textContent) text += attachment.textContent
  }
  return text
}

/**
 * Tokens one message costs on the wire: its text plus the tool round buildHistory
 * replays with it (arguments + the truncated result of every call). In agentic
 * conversations the replayed tool payload dominates the transcript, so an
 * estimate that ignores it never reaches the compaction threshold.
 */
function estimateMessageTokens(message: Message): number {
  let tokens = estimateTokens(messageEstimateText(message))
  for (const call of message.toolCalls ?? []) {
    tokens += estimateTokens(call.arguments)
    tokens += estimateTokens(truncateToolResultForReplay(call.result ?? ''))
  }
  return tokens
}

export class ChatService {
  private readonly streams = new Map<string, ActiveStream>()
  private readonly activeByConversation = new Map<string, string>()
  /** Abort controllers of PENDING reservations (see reserve()). */
  private readonly pendingControllers = new Map<string, AbortController>()
  private readonly backgroundTasks = new Map<string, BackgroundTask>()
  private backgroundTaskSeq = 0

  constructor(
    private readonly db: AppDatabase,
    private readonly broadcast: Broadcast,
    private readonly options: ChatServiceOptions = {}
  ) {}

  async send(req: ChatSendRequest): Promise<StartStreamResult> {
    return this.withReservation(req.conversationId, async (conversation) => {
      const settings = this.db.settings.get()
      // Deep research (the /research command/toggle) wins over MoA and
      // compare for this send: the acting model synthesizes the report.
      const research: ResearchRunRequest | null = req.overrides?.research
        ? {
            depth: req.overrides.research.depth ?? settings.researchDefaultDepth,
            question: req.content.trim(),
          }
        : null
      const moa = research ? null : this.resolveMoaPreset(conversation, settings, req.overrides)
      // Compare needs a preset to fan out; without one it degrades to a
      // normal single-model send. Its acting target is the first RESOLVABLE
      // advisor (no aggregator runs), so no single-model default is required
      // and one broken advisor doesn't block the whole comparison.
      const compare = !!moa && req.overrides?.compare === true
      const resolved =
        compare && moa
          ? await this.resolveFirstAdvisor(conversation, settings, moa)
          : await this.resolveTarget(
              conversation,
              settings,
              moa ? this.aggregatorOverrides(moa, req.overrides) : req.overrides
            )
      const userMessage = this.insertUserMessage(conversation.id, req.content, req.attachments)
      return this.start(conversation, settings, resolved, userMessage, moa, compare, research)
    })
  }

  async regenerate(req: ChatRegenerateRequest): Promise<StartStreamResult> {
    return this.withReservation(req.conversationId, async (conversation) => {
      const messages = this.db.messages.listByConversation(conversation.id)
      const target = messages.find((m) => m.id === req.messageId)
      if (!target || target.role !== 'assistant') {
        throw new ProviderError('invalid_request', 'Only assistant messages can be regenerated.')
      }
      const last = messages[messages.length - 1]
      if (!last || last.id !== target.id) {
        throw new ProviderError(
          'invalid_request',
          'Only the last message of a conversation can be regenerated.'
        )
      }
      const settings = this.db.settings.get()
      if (req.mode === 'second-opinion') {
        return this.startSecondOpinion(conversation, settings, target, req.overrides)
      }
      // A one-off model override ("regenerate with X") bypasses the
      // conversation's MoA preset — the user explicitly asked THIS model.
      const hasOverride = !!(req.overrides?.providerId || req.overrides?.modelId)
      const moa = hasOverride ? null : this.resolveMoaPreset(conversation, settings, undefined)
      const resolved = await this.resolveTarget(
        conversation,
        settings,
        moa ? this.aggregatorOverrides(moa) : req.overrides
      )
      this.db.messages.deleteById(target.id)
      return this.start(conversation, settings, resolved, null, moa)
    })
  }

  /**
   * "Second opinion": keeps the finished answer and streams a challenger
   * model beside it, by converting the persisted message into a compare
   * message — the original text becomes advisor block 0 (still pickable, so
   * nothing is ever destroyed; a crash mid-run leaves both blocks pickable)
   * and the challenger runs as block 1 through the same compare pipeline
   * that pickCompareWinner and the compare-column rendering already handle.
   */
  private async startSecondOpinion(
    conversation: Conversation,
    settings: AppSettings,
    target: Message,
    overrides: ChatRegenerateRequest['overrides']
  ): Promise<StartStreamResult> {
    if (!overrides?.providerId || !overrides.modelId) {
      throw new ProviderError('invalid_request', 'Pick a model to ask for a second opinion.')
    }
    if (target.compare || (target.moaReferences?.length ?? 0) > 0) {
      throw new ProviderError('invalid_request', 'This answer is already a model comparison.')
    }
    if (target.status !== 'complete' || target.content.trim().length === 0) {
      throw new ProviderError(
        'invalid_request',
        'Only a completed answer can get a second opinion.'
      )
    }
    const originalProviderId =
      target.providerId ?? conversation.providerId ?? settings.defaultProviderId
    const originalModelId = target.modelId ?? conversation.modelId ?? settings.defaultModelId
    if (!originalProviderId || !originalModelId) {
      throw new ProviderError(
        'invalid_request',
        'The original answer has no model attribution to compare against.'
      )
    }
    // Resolve the challenger BEFORE touching the message, so a bad pick
    // (disabled provider, missing key) leaves the answer untouched.
    const challenger = await this.resolveTarget(conversation, settings, overrides)

    const original: MoaReferenceOutput = {
      index: 0,
      label: this.moaLabel({ providerId: originalProviderId, modelId: originalModelId }),
      providerId: originalProviderId,
      modelId: originalModelId,
      status: 'done',
      text: target.content,
      ...(target.usage ? { usage: target.usage } : {}),
    }
    const challengerRef: MoaReferenceOutput = {
      index: 1,
      label: this.moaLabel({ providerId: overrides.providerId, modelId: overrides.modelId }),
      providerId: overrides.providerId,
      modelId: overrides.modelId,
      status: 'running',
      text: '',
    }
    const updated = this.db.messages.update(target.id, {
      content: '',
      status: 'streaming',
      error: null,
      moaReferences: [original, challengerRef],
      compare: { pickedIndex: null },
    })
    if (!updated) {
      throw new ProviderError('invalid_request', 'Message not found.')
    }

    const { streamId, controller, active } = this.registerStream(conversation.id)
    const buildOpts: HistoryBuildOptions = {
      settings,
      promptOpts: {},
      visionEnabled: modelSupportsVision(challenger.provider, challenger.modelId),
    }
    // Ephemeral single-advisor preset: the compare pipeline runs the
    // challenger; the seeded block 0 rides along untouched.
    const preset: MoaPreset = {
      id: 'second-opinion',
      name: 'Second opinion',
      referenceModels: [{ providerId: overrides.providerId, modelId: overrides.modelId }],
      aggregator: { providerId: challenger.provider.id, modelId: challenger.modelId },
      enabled: true,
    }
    active.done = this.runCompareStream(
      streamId,
      conversation,
      preset,
      buildOpts,
      updated,
      controller,
      [original]
    )
    return { streamId, userMessage: null, assistantMessage: updated }
  }

  async editAndRerun(req: ChatEditAndRerunRequest): Promise<StartStreamResult> {
    return this.withReservation(req.conversationId, async (conversation) => {
      const messages = this.db.messages.listByConversation(conversation.id)
      const target = messages.find((m) => m.id === req.messageId)
      if (!target || target.role !== 'user') {
        throw new ProviderError('invalid_request', 'Only user messages can be edited and rerun.')
      }
      const settings = this.db.settings.get()
      const moa = this.resolveMoaPreset(conversation, settings, undefined)
      const resolved = await this.resolveTarget(
        conversation,
        settings,
        moa ? this.aggregatorOverrides(moa) : undefined
      )
      const updated = this.db.messages.update(target.id, { content: req.newContent })
      if (!updated) {
        throw new ProviderError('invalid_request', 'Message not found.')
      }
      this.db.messages.deleteAfterSeq(conversation.id, target.seq)
      // The summary covered messages that no longer exist, and the truncated
      // seqs get reused — leaving it would make the edited turn (and every turn
      // after it) fall below summary_through_seq and vanish from the wire.
      if ((conversation.summaryThroughSeq ?? 0) >= target.seq) {
        this.db.conversations.clearSummary(conversation.id)
        conversation.summaryText = null
        conversation.summaryThroughSeq = null
      }
      return this.start(conversation, settings, resolved, updated, moa)
    })
  }

  stop(streamId: string): void {
    this.streams.get(streamId)?.controller.abort()
  }

  /** Aborts the stream (if any) currently generating in a conversation. */
  stopConversation(conversationId: string): void {
    const streamId = this.activeByConversation.get(conversationId)
    if (!streamId) return
    if (streamId === PENDING_STREAM) {
      this.pendingControllers.get(conversationId)?.abort()
      return
    }
    this.streams.get(streamId)?.controller.abort()
  }

  /**
   * Called on app quit — no stream may outlive the process. Aborts every
   * active controller and awaits the detached loops so their partial output is
   * persisted before the caller closes the database, with a safety timeout so
   * a stuck loop can never block quit indefinitely.
   */
  async stopAll(timeoutMs = 3000): Promise<void> {
    for (const task of this.backgroundTasks.values()) {
      if (task.status === 'running') {
        task.status = 'stopped'
        task.controller.abort()
        // The .then/.catch handlers below skip runFinish once the record is no
        // longer 'running', so the persistent row must be closed here or it
        // stays 'running' forever.
        if (task.runId) {
          try {
            this.db.agentPlatform.runFinish(task.runId, 'stopped', task.result)
          } catch {
            // Writes can fail during shutdown; boot recovery sweeps the rest.
          }
        }
      }
    }
    for (const controller of this.pendingControllers.values()) controller.abort()
    const active = [...this.streams.values()]
    for (const { controller } of active) controller.abort()
    if (active.length === 0) return
    const settled = Promise.allSettled(active.map((s) => s.done))
    let timer: NodeJS.Timeout | undefined
    const guard = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
      timer.unref?.()
    })
    try {
      await Promise.race([settled.then(() => undefined), guard])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // -- internals --------------------------------------------------------------

  private requireConversation(id: string): Conversation {
    const conversation = this.db.conversations.getById(id)
    if (!conversation) {
      throw new ProviderError('invalid_request', 'Conversation not found.')
    }
    return conversation
  }

  private ensureIdle(conversationId: string): void {
    if (this.activeByConversation.has(conversationId)) {
      throw new ProviderError(
        'invalid_request',
        'A response is already streaming in this conversation — stop it first.'
      )
    }
  }

  /**
   * Reserve the conversation's single-generation slot BEFORE any async work.
   * resolveTarget is async (OAuth token refresh can hit the network), so without
   * an eager reservation two concurrent sends could both pass ensureIdle before
   * either registered its stream and double-start. `start()` overwrites the
   * PENDING marker with the real stream id; releaseReservation() clears it only
   * while it is still PENDING (i.e. the generation never actually started).
   *
   * The generation's AbortController is created here, not in registerStream, so
   * a Stop issued during the pre-registration phase (resolveTarget's OAuth token
   * refresh) is not silently dropped: registerStream adopts this controller, so
   * the generation aborts as soon as it reaches the adapter.
   */
  private reserve(conversationId: string): void {
    this.ensureIdle(conversationId)
    this.activeByConversation.set(conversationId, PENDING_STREAM)
    this.pendingControllers.set(conversationId, new AbortController())
  }

  private releaseReservation(conversationId: string): void {
    if (this.activeByConversation.get(conversationId) === PENDING_STREAM) {
      this.activeByConversation.delete(conversationId)
      this.pendingControllers.delete(conversationId)
    }
  }

  /**
   * Looks up the conversation, reserves its single-generation slot, and runs
   * `fn`. On any throw the PENDING reservation is released (a no-op once the
   * generation has registered its real stream id via start()/registerStream).
   */
  private async withReservation<T>(
    conversationId: string,
    fn: (conversation: Conversation) => Promise<T>
  ): Promise<T> {
    const conversation = this.requireConversation(conversationId)
    this.reserve(conversation.id)
    try {
      return await fn(conversation)
    } catch (e) {
      this.releaseReservation(conversation.id)
      throw e
    }
  }

  /**
   * Registers a generation in both tracking maps (overwriting the PENDING
   * reservation) so stop()/stopConversation()/stopAll() can reach it. Adopts the
   * reservation's controller, so a Stop already issued during the pending phase
   * still aborts this generation. The caller must assign the real work promise
   * to `active.done` and pair this with releaseStream() when the work settles.
   */
  private registerStream(conversationId: string): {
    streamId: string
    controller: AbortController
    active: ActiveStream
  } {
    const streamId = randomUUID()
    const controller = this.pendingControllers.get(conversationId) ?? new AbortController()
    this.pendingControllers.delete(conversationId)
    const active: ActiveStream = { controller, conversationId, done: Promise.resolve() }
    this.streams.set(streamId, active)
    this.activeByConversation.set(conversationId, streamId)
    return { streamId, controller, active }
  }

  /**
   * Drops a settled generation from both maps. The conversation slot is only
   * cleared while it still points at this stream, so a newer stream's slot is
   * never clobbered by a stale finalizer.
   */
  private releaseStream(streamId: string, conversationId: string): void {
    this.streams.delete(streamId)
    if (this.activeByConversation.get(conversationId) === streamId) {
      this.activeByConversation.delete(conversationId)
    }
  }

  private async resolveTarget(
    conversation: Conversation,
    settings: AppSettings,
    overrides: ChatSendRequest['overrides']
  ): Promise<ResolvedTarget> {
    const providerId =
      overrides?.providerId ??
      conversation.providerId ??
      (settings.autoRoutingEnabled ? this.autoRouteProvider(settings) : null) ??
      settings.defaultProviderId
    if (!providerId) {
      throw new ProviderError('invalid_request', 'No provider configured. Open Settings to add one.')
    }
    const provider = this.db.providers.getById(providerId)
    if (!provider) {
      throw new ProviderError('invalid_request', 'No provider configured. Open Settings to add one.')
    }
    if (!provider.enabled) {
      throw new ProviderError(
        'invalid_request',
        `${provider.label} is disabled — enable it in Settings.`
      )
    }

    // Auth: OAuth providers resolve an access token (refreshing if needed);
    // everyone else decrypts the stored API key.
    let apiKey: string
    let accountId: string | null = null
    if (provider.authMode === 'chatgpt_oauth') {
      if (!this.options.getAccessToken) {
        throw new ProviderError(
          'auth',
          `${provider.label} uses ChatGPT sign-in, which isn't available in this context.`
        )
      }
      // Pass the pending reservation's abort signal (if this resolve is part of
      // a reserved generation) so a Stop during the PENDING phase cancels a hung
      // token refresh and frees the conversation slot instead of blocking on it.
      const token = await this.options.getAccessToken(
        provider.id,
        this.pendingControllers.get(conversation.id)?.signal
      )
      apiKey = token.accessToken
      accountId = token.accountId
    } else {
      const encrypted = this.db.providers.getEncryptedKey(provider.id)
      if (encrypted) {
        apiKey = decryptKey(encrypted)
      } else if (provider.type === 'openai-compatible' && isLoopbackBaseUrl(provider.baseUrl)) {
        // SECURITY: keyless generation is allowed ONLY toward a loopback
        // server (Ollama, LM Studio, Jan). adapterCtx sends this provider's
        // own baseUrl, so the placeholder bearer can never travel to a
        // remote endpoint. Keep in sync with providerUsable() in the
        // renderer (src/renderer/src/lib/providers.ts).
        apiKey = KEYLESS_API_KEY
      } else {
        throw new ProviderError(
          'auth',
          `No API key configured for ${provider.label}. Add one in Settings.`
        )
      }
    }

    const modelId = firstNonEmpty(
      overrides?.modelId,
      conversation.modelId,
      provider.defaultModelId,
      PROVIDER_TYPES[provider.type].defaultModelId
    )
    if (!modelId) {
      throw new ProviderError(
        'invalid_request',
        `No model selected for ${provider.label} — pick one in Settings.`
      )
    }

    const params: ChatParams = {
      ...settings.defaultParams,
      ...conversation.params,
      ...overrides?.params,
    }
    return { provider, modelId, params, apiKey, accountId }
  }

  /**
   * Deterministic provider-neutral router. Explicit per-send and
   * per-conversation choices always win; Auto only fills an otherwise empty
   * target. Unknown prices sort behind known prices, while local endpoints are
   * treated as zero-cost for local-only routing.
   */
  private autoRouteProvider(settings: AppSettings): string | null {
    return pickAutoRouteProvider(this.db.providers.list(), settings)
  }

  /**
   * The MoA preset a generation should run through, or null for ordinary
   * single-model generation. A one-shot override (the `/moa` command) wins over
   * the conversation's stored preset. Returns null for an unknown, disabled or
   * structurally-invalid preset so generation silently falls back to the model.
   */
  private resolveMoaPreset(
    conversation: Conversation,
    settings: AppSettings,
    overrides: ChatSendRequest['overrides']
  ): MoaPreset | null {
    const id = overrides?.moaPresetId ?? conversation.moaPresetId
    if (!id) return null
    const preset = settings.moaPresets.find((p) => p.id === id)
    if (!preset || !preset.enabled) return null
    if (preset.referenceModels.length === 0) return null
    if (!preset.aggregator?.providerId || !preset.aggregator?.modelId) return null
    return preset
  }

  /**
   * Turns a MoA preset into resolveTarget overrides that select its aggregator
   * as the acting model and fold in the aggregator temperature / max-tokens
   * tunings. `base` (the caller's own overrides) is preserved for params.
   */
  private aggregatorOverrides(
    preset: MoaPreset,
    base?: ChatSendRequest['overrides']
  ): ChatSendRequest['overrides'] {
    const params: ChatParams = {
      ...base?.params,
      ...(preset.aggregatorTemperature !== undefined
        ? { temperature: preset.aggregatorTemperature }
        : {}),
      ...(preset.maxTokens !== undefined ? { maxTokens: preset.maxTokens } : {}),
    }
    return {
      providerId: preset.aggregator.providerId,
      modelId: preset.aggregator.modelId,
      ...(Object.keys(params).length > 0 ? { params } : {}),
    }
  }

  /** "<provider label> · <modelId>" for an advisor/aggregator model reference. */
  private moaLabel(ref: { providerId: string; modelId: string }): string {
    const provider = this.db.providers.getById(ref.providerId)
    return `${provider?.label ?? ref.providerId} · ${ref.modelId}`
  }

  /**
   * The acting target for a compare run: the first advisor whose provider
   * resolves (enabled, keyed). runAdvisors tolerates per-advisor failures, so
   * the send should too — only when EVERY advisor is unresolvable does the
   * last error propagate.
   */
  private async resolveFirstAdvisor(
    conversation: Conversation,
    settings: AppSettings,
    preset: MoaPreset
  ): Promise<ResolvedTarget> {
    let lastError: unknown
    for (const ref of preset.referenceModels) {
      try {
        return await this.resolveTarget(conversation, settings, {
          providerId: ref.providerId,
          modelId: ref.modelId,
        })
      } catch (e) {
        lastError = e
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ProviderError('invalid_request', 'No advisor model in this preset is usable.')
  }

  /**
   * See buildHistory's `replayToolCalls`: every provider replays earlier tool
   * rounds except Anthropic with extended thinking requested, where replayed
   * tool_use turns would force thinking off (anthropic.ts skips thinking when
   * the transcript carries tool_use without its original thinking blocks).
   */
  private shouldReplayToolCalls(resolved: ResolvedTarget): boolean {
    return !(resolved.provider.type === 'anthropic' && resolved.params.reasoningEffort)
  }

  /** Adapter for the resolved provider (test seam first, then the registry). */
  private adapterFor(resolved: ResolvedTarget): ProviderAdapter {
    return (this.options.resolveAdapter ?? resolveAdapterForProvider)(
      resolved.provider.type,
      resolved.provider.authMode
    )
  }

  /** Per-call adapter context for the resolved target. */
  private adapterCtx(resolved: ResolvedTarget, signal?: AbortSignal): AdapterContext {
    return {
      apiKey: resolved.apiKey,
      baseUrl: resolved.provider.baseUrl,
      accountId: resolved.accountId,
      modelCatalog: resolveModelCatalog(resolved.provider),
      signal,
    }
  }

  /**
   * Builds and persists a user message. Content is stored as typed; attachment
   * text is inlined only on the wire.
   */
  private insertUserMessage(
    conversationId: string,
    content: string,
    attachments?: Message['attachments']
  ): Message {
    const userMessage: Message = {
      id: randomUUID(),
      conversationId,
      role: 'user',
      content,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      status: 'complete',
      seq: this.db.messages.nextSeq(conversationId),
      createdAt: Date.now(),
    }
    this.db.messages.insert(userMessage)
    return userMessage
  }

  /** Inserts the placeholder, snapshots history, and kicks off the detached loop. */
  private start(
    conversation: Conversation,
    settings: AppSettings,
    resolved: ResolvedTarget,
    userMessage: Message | null,
    moa?: MoaPreset | null,
    compare = false,
    research: ResearchRunRequest | null = null
  ): StartStreamResult {
    const assistantMessage: Message = {
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'assistant',
      content: '',
      status: 'streaming',
      // A compare send runs N advisors, not one model: leave the placeholder
      // unattributed until pickCompareWinner stamps the winner's identity.
      ...(compare ? {} : { providerId: resolved.provider.id, modelId: resolved.modelId }),
      // Marked at insert so the renderer lays the advisors out side by side
      // from the first 'moa-reference' event.
      ...(compare && moa ? { compare: { pickedIndex: null } } : {}),
      seq: this.db.messages.nextSeq(conversation.id),
      createdAt: Date.now(),
    }
    this.db.messages.insert(assistantMessage)

    const toolPlan = this.planTools(resolved)
    const visionEnabled = modelSupportsVision(resolved.provider, resolved.modelId)
    const { streamId, controller, active } = this.registerStream(conversation.id)

    // History is built inside runStream, AFTER an optional (async) context
    // compaction pass, so the summary and the pruned transcript are in sync.
    const buildOpts: HistoryBuildOptions = {
      settings,
      promptOpts: toolPlan.promptOpts,
      visionEnabled,
    }

    // Track the detached loop so stopAll() can await its persistence on quit.
    // A research run gathers web findings first, then delegates to the same
    // streaming core. A MoA preset first fans out its advisor models, then
    // delegates with the aggregator as the acting model. A compare run is
    // the fan-out alone — the advisors ARE the result, no aggregator.
    active.done = research
      ? this.runResearchStream(
          streamId,
          conversation,
          resolved,
          research,
          buildOpts,
          assistantMessage,
          controller
        )
      : compare && moa
        ? this.runCompareStream(streamId, conversation, moa, buildOpts, assistantMessage, controller)
        : moa
          ? this.runMoaStream(
              streamId,
              conversation,
              resolved,
              moa,
              buildOpts,
              assistantMessage,
              controller,
              toolPlan.adapterTools
            )
          : this.runStream(
              streamId,
              conversation,
              resolved,
              buildOpts,
              assistantMessage,
              controller,
              toolPlan.adapterTools
            )

    return { streamId, userMessage, assistantMessage }
  }

  /**
   * Decides whether this generation offers tools to the model. Tools go on
   * the wire only when the model supports tool calling (catalog capability;
   * unknown models are assumed capable via UNKNOWN_MODEL_CAPS) AND at least
   * one tool is enabled. When tools exist but the model cannot call them, the
   * mode prompt gets the manual-instructions fallback instead.
   */
  private planTools(resolved: ResolvedTarget): ToolPlan {
    const tools = this.options.tools
    if (!tools) return { promptOpts: {} }
    const enabled = tools.registry.listEnabledDefinitions()
    if (enabled.length === 0) return { promptOpts: {} }

    const toolNames = enabled.map((def) => def.name)
    if (!modelSupportsTools(resolved.provider, resolved.modelId)) {
      return { promptOpts: { toolsAvailable: false, toolNames } }
    }
    return {
      adapterTools: enabled.map(toAdapterToolDef),
      promptOpts: { toolsAvailable: true, toolNames },
    }
  }

  private buildHistory(
    conversation: Conversation,
    settings: AppSettings,
    promptOpts: ModePromptOptions,
    visionEnabled: boolean,
    /**
     * Replay earlier turns' tool rounds (assistant tool_use + role-'tool'
     * results) so the model remembers what it already did. Off for advisor
     * fan-outs (cheap, tool-free) and for Anthropic with extended thinking
     * requested — replayed tool_use turns would force thinking off there
     * (see anthropic.ts), which is the worse trade.
     */
    replayToolCalls = false
  ): AdapterMessage[] {
    const history: AdapterMessage[] = []
    // Effective system prompt = mode base prompt + the user's extras (the
    // per-conversation prompt wins over the global default). The mode prompt
    // is always non-empty (base persona + a per-mode section), so a system
    // message is always sent now.
    // When memory is enabled, saved memories (and the uld-memory block
    // instructions) ride along in the mode prompt; enabled skills are always
    // listed. This single spot covers streaming, headless and delegate
    // generations alike.
    const enabledSkills = this.db.skills.listEnabled()
    const effectiveOpts: ModePromptOptions = {
      localDate: new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
      ...promptOpts,
      ...(conversation.mode === 'work' && conversation.params.planMode === true
        ? { planMode: true }
        : {}),
      ...(conversation.mode === 'work' && conversation.params.sandboxLevel === 'read-only'
        ? { sandboxReadOnly: true }
        : {}),
      ...(enabledSkills.length > 0
        ? {
            skills: enabledSkills.map((s) => ({
              name: s.name,
              description: s.description,
              content: s.content,
            })),
          }
        : {}),
      ...(settings.memoryEnabled
        ? {
            memoryEnabled: true,
            // Shared memories only: an agent profile's memories belong to
            // that agent and never leak into an ordinary conversation.
            memories: this.db.memories
              .listForAgent(null)
              .slice(0, MEMORY_MAX_INJECTED)
              .map((m) => ({ title: m.title, content: m.content })),
          }
        : {}),
    }
    const extras =
      (conversation.systemPrompt ?? '').trim() || settings.defaultSystemPrompt.trim()
    const systemPrompt = [buildModeSystemPrompt(conversation.mode, effectiveOpts), extras]
      .filter((part) => part.length > 0)
      .join('\n\n')
      .trim()
    if (systemPrompt) {
      history.push({ role: 'system', content: systemPrompt })
    }
    // Work mode: repo-root project instructions (AGENTS.md and friends) ride
    // along as a system note so the model follows the project's conventions.
    if (conversation.mode === 'work' && conversation.projectId) {
      const instructions = this.readProjectInstructions(conversation.projectId)
      if (instructions) history.push({ role: 'system', content: instructions })
    }
    // Attached knowledge base: steer the model to retrieve before answering.
    // Skipped when the knowledge_search tool itself is disabled — never
    // instruct the model to call a tool it isn't offered.
    const knowledgeToolAvailable =
      this.options.tools?.registry
        .listEnabledDefinitions()
        .some((d) => d.id === 'knowledge_search') ?? false
    if (conversation.knowledgeBaseId && knowledgeToolAvailable) {
      const kb = this.db.knowledge.getById(conversation.knowledgeBaseId)
      if (kb && kb.chunkCount > 0) {
        history.push({
          role: 'system',
          content:
            `A knowledge base named "${kb.name}" is attached to this conversation. ` +
            `Before answering questions that its documents may cover, call the ` +
            `knowledge_search tool to retrieve relevant passages, and ground your ` +
            `answer in what it returns.`,
        })
      }
    }
    // Condensed older turns (context compaction) go in as a system note; the
    // messages they cover (seq <= summaryThroughSeq) are then skipped below.
    const throughSeq = conversation.summaryThroughSeq ?? 0
    if (conversation.summaryText && conversation.summaryText.trim().length > 0) {
      history.push({
        role: 'system',
        content: `Summary of earlier conversation:\n${conversation.summaryText}`,
      })
    }
    for (const message of this.db.messages.listByConversation(conversation.id)) {
      if (message.role !== 'user' && message.role !== 'assistant') continue
      if (message.status !== 'complete' && message.status !== 'stopped') continue
      if (message.seq <= throughSeq) continue
      // Slash commands ('/init', '/skill …') stay short in the transcript but
      // expand to their full prompt on the wire, every round and replay alike.
      const content =
        message.role === 'user'
          ? isExpandingSlashCommand(message.content, conversation.mode)
            ? expandSlashCommand(message.content, conversation.mode)
            : composeUserContent(message, visionEnabled, this.options.imageDir)
          : message.content
      const calls =
        replayToolCalls && message.role === 'assistant' ? (message.toolCalls ?? []) : []
      if (calls.length > 0) {
        // Replay the turn's tool round(s): tool_use turn first, one result per
        // call (every call MUST have a result or providers reject the
        // transcript), then the final answer as its own assistant turn.
        history.push({ role: 'assistant', content: '', toolCalls: calls })
        for (const call of calls) {
          history.push({
            role: 'tool',
            content: truncateToolResultForReplay(call.result ?? '[not executed]'),
            toolCallId: call.id,
          })
        }
        if (!contentIsEmpty(content)) history.push({ role: 'assistant', content })
        continue
      }
      if (contentIsEmpty(content)) continue
      history.push({ role: message.role, content })
    }
    return history
  }

  /**
   * Summarizes older messages into conversation.summaryText when the active
   * transcript approaches the model's context window. Mutates the passed
   * `conversation` and persists the summary. Never drops the latest user turn;
   * any failure is swallowed so generation proceeds with the full history.
   */
  private async maybeCompact(
    conversation: Conversation,
    resolved: ResolvedTarget,
    settings: AppSettings,
    signal: AbortSignal
  ): Promise<void> {
    if (!settings.compactionEnabled) return
    try {
      await this.compact(conversation, resolved, settings, signal, false)
    } catch {
      // Auto-compaction is best-effort: fall back to the full history.
    }
  }

  /**
   * Manual compaction (the /compact command): summarizes regardless of the
   * auto-compaction setting and threshold. Returns whether anything was
   * summarized; provider/config errors propagate to the caller.
   */
  async compactNow(conversationId: string): Promise<{ compacted: boolean }> {
    const conversation = this.requireConversation(conversationId)
    // Take the single-generation slot so /compact can't interleave with a
    // running stream (and vice versa).
    this.reserve(conversation.id)
    try {
      const settings = this.db.settings.get()
      const resolved = await this.resolveTarget(conversation, settings, undefined)
      const compacted = await this.compact(conversation, resolved, settings, undefined, true)
      if (compacted) this.broadcast(CHANNELS.conversationsChanged, { conversationId: conversation.id })
      return { compacted }
    } finally {
      this.releaseReservation(conversation.id)
    }
  }

  /** Shared compaction core; `force` skips the token-estimate threshold. */
  private async compact(
    conversation: Conversation,
    resolved: ResolvedTarget,
    settings: AppSettings,
    signal: AbortSignal | undefined,
    force: boolean
  ): Promise<boolean> {
    const contextLength =
      resolveModelInfo(resolved.provider, resolved.modelId)?.contextLength ??
      DEFAULT_CONTEXT_LENGTH
    const threshold = contextLength * settings.compactionThresholdRatio

    const throughSeq = conversation.summaryThroughSeq ?? 0
    const active = this.db.messages
      .listByConversation(conversation.id)
      .filter(
        (m) =>
          (m.role === 'user' || m.role === 'assistant') &&
          (m.status === 'complete' || m.status === 'stopped') &&
          m.seq > throughSeq
      )

    if (!force) {
      const estimate =
        active.reduce((sum, m) => sum + estimateMessageTokens(m), 0) +
        estimateTokens(conversation.summaryText ?? '')
      if (estimate < threshold) return false
    }
    if (active.length <= COMPACTION_KEEP_RECENT + 1) return false

    const toSummarize = active.slice(0, active.length - COMPACTION_KEEP_RECENT)
    if (toSummarize.length === 0) return false
    const newThroughSeq = toSummarize[toSummarize.length - 1].seq
    // Never summarize past the latest user turn (it must be sent verbatim).
    const latestUserSeq = Math.max(
      ...active.filter((m) => m.role === 'user').map((m) => m.seq),
      -1
    )
    if (newThroughSeq >= latestUserSeq) return false

    const parts: string[] = []
    if (conversation.summaryText) parts.push(`Summary so far:\n${conversation.summaryText}`)
    for (const m of toSummarize) {
      parts.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${messageEstimateText(m)}`)
    }

    // Compaction is internal plumbing: route it to the configured economy
    // model when one is set; a broken economy config falls back silently to
    // the conversation's own model rather than blocking the summary.
    let target = resolved
    if (settings.economyProviderId) {
      try {
        target = await this.resolveTarget(conversation, settings, {
          providerId: settings.economyProviderId,
          modelId: settings.economyModelId ?? undefined,
        })
      } catch {
        target = resolved
      }
    }
    const adapter = this.adapterFor(target)
    const result = await adapter.chat(
      {
        modelId: target.modelId,
        messages: [
          { role: 'system', content: COMPACTION_INSTRUCTION },
          { role: 'user', content: parts.join('\n\n') },
        ],
        params: { maxTokens: 1024 },
        stream: false,
      },
      this.adapterCtx(target, signal)
    )
    const summary = result.text.trim()
    if (summary.length === 0) return false

    this.db.conversations.setSummary(conversation.id, summary, newThroughSeq)
    conversation.summaryText = summary
    conversation.summaryThroughSeq = newThroughSeq
    return true
  }

  /**
   * Non-streaming generation used by headless callers (e.g. the Telegram
   * bridge). Persists the incoming user message and the assistant reply, and
   * returns the reply text. Throws on config errors (no provider/key/model).
   */
  async generateHeadless(conversationId: string, userText: string): Promise<string> {
    const conversation = this.requireConversation(conversationId)
    // Enforce the same single-generation-per-conversation invariant as
    // send/regenerate/editAndRerun: without it an IM-bridge message could run a
    // second generation over the same history while a UI stream is live,
    // interleaving persisted turns. reserve() throws if the conversation is
    // already busy; the caller (IM bridge) reports that back to the user.
    this.reserve(conversation.id)
    const { streamId, controller, active } = this.registerStream(conversation.id)
    const work = this.runHeadless(conversation, userText, controller.signal)
    // Track the work so stopAll() can await its persistence on quit (same
    // contract as the streaming path); errors surface via `await work` below.
    active.done = work.then(
      () => undefined,
      () => undefined
    )
    try {
      return await work
    } finally {
      this.releaseStream(streamId, conversation.id)
    }
  }

  private async runHeadless(
    conversation: Conversation,
    userText: string,
    signal: AbortSignal
  ): Promise<string> {
    const conversationId = conversation.id
    const settings = this.db.settings.get()
    const resolved = await this.resolveTarget(conversation, settings, undefined)

    this.insertUserMessage(conversationId, userText)

    // A headless reply (the IM bridge) is one non-streaming chat() call with no
    // tools on the wire, so the prompt must not advertise any: empty promptOpts
    // suppress both the tools section and the manual-instructions fallback.
    const visionEnabled = modelSupportsVision(resolved.provider, resolved.modelId)
    const history = this.buildHistory(
      conversation,
      settings,
      {},
      visionEnabled,
      this.shouldReplayToolCalls(resolved)
    )
    const adapter = this.adapterFor(resolved)
    const result = await adapter.chat(
      {
        modelId: resolved.modelId,
        messages: history,
        params: resolved.params,
        stream: false,
      },
      this.adapterCtx(resolved, signal)
    )

    const assistant: Message = {
      id: randomUUID(),
      conversationId,
      role: 'assistant',
      content: result.text,
      reasoning: result.reasoning,
      status: 'complete',
      providerId: resolved.provider.id,
      modelId: resolved.modelId,
      usage: result.usage,
      seq: this.db.messages.nextSeq(conversationId),
      createdAt: Date.now(),
    }
    this.db.messages.insert(assistant)
    this.db.conversations.touch(conversationId, Date.now())
    this.broadcast(CHANNELS.conversationsChanged, { conversationId })
    await runCompletionHooks(conversation, assistant)
    return result.text
  }

  /**
   * One-shot, conversation-less generation for workflow ai_agent nodes.
   * Resolves the provider/model from the given ids or the global defaults.
   * Throws on config errors (no provider/key/model).
   */
  async generateForWorkflow(
    prompt: string,
    providerId?: string,
    modelId?: string,
    opts?: {
      useTools?: boolean
      agentId?: string
      json?: boolean
      signal?: AbortSignal
      /**
       * Tool ids the user pre-approved for this headless run (scheduled
       * tasks): they pass the approval gate that otherwise auto-declines.
       * A 'deny' permission still refuses inside the executor.
       */
      approvedToolIds?: string[]
      /** Working folder (code_projects row) for file/shell tools. */
      projectId?: string | null
      /**
       * Internal plumbing generation (commit messages, dreaming): route to
       * the configured economy model when one is set. Explicit provider/model
       * ids and agent profiles always win over the economy routing.
       */
      economy?: boolean
    }
  ): Promise<string> {
    const settings = this.db.settings.get()
    const stub: Conversation = {
      id: HEADLESS_CONVERSATION_ID,
      mode: 'chat',
      title: '',
      providerId: null,
      modelId: null,
      systemPrompt: null,
      params: {},
      workspaceId: null,
      projectId: opts?.projectId ?? null,
      projectRef: null,
      moaPresetId: null,
      createdAt: 0,
      updatedAt: 0,
    }
    // An agent profile supplies persona + default model + toolset; explicit
    // node provider/model config still wins over the profile's. A broken
    // reference fails the run — a scheduled workflow must not quietly degrade
    // to a persona-less generation.
    const profile = opts?.agentId ? this.db.agents.getById(opts.agentId) : null
    const agent = profile?.enabled ? profile : null
    if (opts?.agentId && !agent) {
      throw new ProviderError(
        'invalid_request',
        'The agent profile selected for this node is missing or disabled.'
      )
    }
    const economy =
      opts?.economy === true && !providerId && !modelId && !agent && settings.economyProviderId
        ? {
            providerId: settings.economyProviderId,
            modelId: settings.economyModelId ?? undefined,
          }
        : null
    const resolved = await this.resolveTarget(stub, settings, {
      providerId: providerId ?? agent?.providerId ?? economy?.providerId,
      modelId: modelId ?? agent?.modelId ?? economy?.modelId,
    })
    const adapter = this.adapterFor(resolved)

    // Tool-enabled node: a bounded, non-streaming loop over the enabled tools.
    // Headless runs can never pop an approval dialog, so the approval callback
    // auto-declines everything except the caller's pre-approved tool ids
    // (scheduled tasks: consented once at create time). Otherwise only tools
    // whose permission is 'always allow' actually run (web_search/fetch_url
    // by default; users can grant more in Settings).
    const approvedTools = new Set(opts?.approvedToolIds ?? [])
    const tools = this.options.tools
    // Keep the enabled defs: the grants hold definition ids ('custom:<uuid>' for
    // custom tools) while a call arrives under its WIRE name, so the name has to
    // be mapped back to an id before the membership test below.
    const enabledDefs = opts?.useTools && tools ? tools.registry.listEnabledDefinitions() : []
    const toolDefs: AdapterToolDef[] = enabledDefs
      .filter((d) => !agent?.toolIds || agent.toolIds.includes(d.id))
      .map(toAdapterToolDef)
    const params: ChatParams = {
      ...resolved.params,
      ...(opts?.json ? { responseFormat: 'json' as const } : {}),
    }
    // An agent profile brings its OWN memories: what "Watcher" remembers is
    // invisible to every other agent and to ordinary conversations, so a
    // recurring job builds up its own context instead of one global pile.
    const agentSystemPrompt = agent ? this.agentSystemPrompt(agent, settings) : null
    const messages: AdapterMessage[] = [
      ...(agentSystemPrompt
        ? [{ role: 'system', content: agentSystemPrompt } as AdapterMessage]
        : []),
      { role: 'user', content: prompt },
    ]
    const maxRounds =
      agent?.maxRounds && agent.maxRounds >= 1
        ? Math.min(agent.maxRounds, MAX_TOOL_ROUNDS)
        : WORKFLOW_AGENT_MAX_ROUNDS
    let final = ''
    for (let round = 0; round < maxRounds; round++) {
      if (opts?.signal?.aborted) {
        throw new ProviderError('aborted', 'The workflow run was cancelled.')
      }
      const result = await adapter.chat(
        {
          modelId: resolved.modelId,
          messages,
          params,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          stream: false,
        },
        this.adapterCtx(resolved, opts?.signal)
      )
      if (result.text.trim()) final = result.text
      if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0 || !tools) break
      messages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls })
      for (const call of result.toolCalls) {
        const out = await tools.executor.execute(call, {
          conversation: stub,
          approval: async (req) => {
            const def = enabledDefs.find(
              (d) => d.id === req.toolCall.name || d.name === req.toolCall.name
            )
            if (def && approvedTools.has(def.id)) {
              return { approved: true, scope: 'once' as const }
            }
            // Nothing pre-approved covers this call. Rather than auto-declining
            // (the old behaviour, which failed the run silently), ask the user
            // on their phone if remote approvals are configured. A missing
            // channel or an unanswered question still resolves to declined.
            const approved = await this.askRemoteApproval(req, opts?.signal)
            return { approved, scope: 'once' as const }
          },
          // A headless run has no dialog either, so ask_user_question goes to
          // the same side channel. Without one it resolves to null and the
          // tool tells the model to proceed on its own judgement.
          askUser: (question, options) => this.askRemoteChoice(question, options, opts?.signal),
          ...(agent ? { agentName: agent.name } : {}),
          ...(opts?.signal ? { signal: opts.signal } : {}),
        })
        messages.push({ role: 'tool', content: out, toolCallId: call.id })
      }
    }
    // Headless runs never create a message row, so the memory completion hook
    // cannot see them — an agent's own memories are persisted here instead.
    if (agent) this.persistAgentMemories(agent.id, final)
    return final
  }

  /**
   * An agent profile's persona plus the memory section listing ITS memories
   * (and the block format for writing new ones). Falls back to the bare
   * persona when the user has memory switched off.
   */
  private agentSystemPrompt(agent: AgentProfile, settings: AppSettings): string {
    if (!settings.memoryEnabled) return agent.systemPrompt
    const memories = this.db.memories
      .listForAgent(agent.id)
      .slice(0, MEMORY_MAX_INJECTED)
      .map((memory) => ({ title: memory.title, content: memory.content }))
    return [agent.systemPrompt.trim(), buildMemorySection(memories)]
      .filter((section) => section.length > 0)
      .join('\n\n')
  }

  /** Persists an agent's own ```uld-memory directives (never throws). */
  private persistAgentMemories(agentId: string, text: string): void {
    if (text.trim().length === 0) return
    try {
      if (!this.db.settings.get().memoryEnabled) return
      for (const directive of extractMemoryDirectives(text)) {
        if (directive.action === 'forget') {
          this.db.memories.removeByTitle(directive.title, agentId)
        } else {
          this.db.memories.upsertByTitle({
            title: directive.title,
            content: directive.content,
            agentId,
          })
        }
      }
    } catch {
      // A memory write must never fail the run that produced it.
    }
  }

  /**
   * Side-channel approval for a headless run: there is no window to pop a
   * dialog in, so the question goes to the paired Telegram chat instead. Any
   * outcome other than an explicit "allow" — no channel configured, a send
   * failure, nobody tapping in time, the run being stopped — is a decline.
   */
  private async askRemoteApproval(
    req: Omit<ToolApprovalRequest, 'requestId'>,
    signal?: AbortSignal
  ): Promise<boolean> {
    const ask = this.options.remoteApproval
    if (!ask || signal?.aborted) return false
    try {
      const answer = await ask({
        requestKey: randomUUID(),
        title: `${req.toolCall.name} wants to run in a background task`,
        detail: req.note ? `${req.note}\n\n${req.toolCall.arguments}` : req.toolCall.arguments,
        ...(signal ? { signal } : {}),
      })
      return answer === true
    } catch {
      return false
    }
  }

  /**
   * Side-channel question for a headless run (ask_user_question). null means
   * nobody could be reached or nobody answered — the tool then tells the model
   * to make a reasonable assumption rather than stalling the run.
   */
  private async askRemoteChoice(
    question: string,
    options: string[],
    signal?: AbortSignal
  ): Promise<string | null> {
    const ask = this.options.remoteChoice
    if (!ask || signal?.aborted) return null
    try {
      return await ask({
        requestKey: randomUUID(),
        question,
        options,
        ...(signal ? { signal } : {}),
      })
    } catch {
      return null
    }
  }

  /**
   * Text embeddings for the knowledge-base service: resolves the provider,
   * decrypts its key (never leaves main) and calls the adapter's /embeddings.
   */
  async embedTexts(providerId: string, modelId: string, texts: string[]): Promise<number[][]> {
    const settings = this.db.settings.get()
    const stub: Conversation = {
      id: 'knowledge',
      mode: 'chat',
      title: '',
      providerId: null,
      modelId: null,
      systemPrompt: null,
      params: {},
      workspaceId: null,
      projectId: null,
      projectRef: null,
      moaPresetId: null,
      createdAt: 0,
      updatedAt: 0,
    }
    const resolved = await this.resolveTarget(stub, settings, { providerId, modelId })
    const adapter = this.adapterFor(resolved)
    if (!adapter.embed) {
      throw new ProviderError(
        'not_supported',
        `${resolved.provider.label} has no embeddings endpoint — pick an OpenAI-compatible provider for knowledge bases.`
      )
    }
    return adapter.embed({ modelId: resolved.modelId, input: texts }, this.adapterCtx(resolved))
  }

  /**
   * Text-to-image for the generate_image tool: resolves the configured (or
   * auto-picked) image provider, decrypts its key (never leaves main), calls
   * the adapter and stores the results as image attachments on disk. Mirrors
   * embedTexts' stub-conversation resolution.
   */
  async generateImage(req: {
    prompt: string
    count?: number
    size?: AdapterImageRequest['size']
  }): Promise<Attachment[]> {
    const imageDir = this.options.imageDir
    if (!imageDir) {
      throw new ProviderError('not_supported', 'Image storage is unavailable in this context.')
    }
    const settings = this.db.settings.get()
    const providerId = settings.defaultImageProviderId ?? this.autoPickImageProviderId()
    if (!providerId) {
      throw new ProviderError(
        'invalid_request',
        'No image-capable provider is configured — pick one in Settings → Defaults → Image generation.'
      )
    }
    const provider = this.db.providers.getById(providerId)
    if (!provider) {
      throw new ProviderError(
        'invalid_request',
        'The configured image provider no longer exists — pick another in Settings.'
      )
    }
    if (provider.authMode === 'chatgpt_oauth') {
      throw new ProviderError(
        'not_supported',
        'Image generation needs an OpenAI API key — ChatGPT sign-in has no image endpoint.'
      )
    }
    const modelId =
      (settings.defaultImageProviderId === providerId ? settings.defaultImageModelId : null) ??
      resolveImageModelCatalog(provider).defaultImageModelId
    if (!modelId) {
      throw new ProviderError(
        'not_supported',
        `${provider.label} has no image-generation model — pick an image-capable provider in Settings.`
      )
    }
    const stub: Conversation = {
      id: 'image',
      mode: 'chat',
      title: '',
      providerId: null,
      modelId: null,
      systemPrompt: null,
      params: {},
      workspaceId: null,
      projectId: null,
      projectRef: null,
      moaPresetId: null,
      createdAt: 0,
      updatedAt: 0,
    }
    const resolved = await this.resolveTarget(stub, settings, { providerId, modelId })
    const adapter = this.adapterFor(resolved)
    if (!adapter.generateImage) {
      throw new ProviderError('not_supported', `${provider.label} cannot generate images.`)
    }
    const count = Math.min(Math.max(Math.floor(req.count ?? 1), 1), 4)
    // Image generation is slow (tens of seconds); executor calls are not
    // stream-abortable today, so a hard timeout bounds the worst case.
    const signal = AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS)
    const images = await adapter.generateImage(
      { modelId: resolved.modelId, prompt: req.prompt, count, size: req.size },
      this.adapterCtx(resolved, signal)
    )
    const attachments: Attachment[] = []
    for (const image of images) {
      attachments.push(
        await storeGeneratedImage(imageDir, image.bytes, image.mimeType, {
          prompt: req.prompt,
          modelId: resolved.modelId,
          ...(req.size && req.size !== 'auto' ? { size: req.size } : {}),
        })
      )
    }
    return attachments
  }

  /** First enabled, keyed, image-capable provider (chatgpt-oauth excluded). */
  private autoPickImageProviderId(): string | null {
    for (const provider of this.db.providers.list()) {
      if (!provider.enabled || !provider.hasKey) continue
      if (provider.authMode === 'chatgpt_oauth') continue
      if (providerSupportsImageOutput(provider)) return provider.id
    }
    return null
  }

  /**
   * Reads the project's assistant-instruction file (GRASBERG.md, or the
   * AGENTS.md / CLAUDE.md conventions), capped. Null when none exists —
   * always best-effort, never throws.
   */
  private readProjectInstructions(projectId: string): string | null {
    try {
      const project = this.db.code.projectGetById(projectId)
      if (!project) return null
      // SECURITY: canonicalize the project root once so the per-file symlink
      // check below can re-assert containment. Mirrors CodeService's root jail
      // (code-service.ts realInsideRoot) — the canonical guard for reading
      // inside a granted project.
      const realRoot = realpathSync.native(resolve(project.path))
      const rootPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep
      for (const name of PROJECT_INSTRUCTION_FILES) {
        let raw: string
        try {
          // SECURITY: realpath resolves every symlink; reject an instruction
          // file that a repo has pointed outside the project root (e.g.
          // AGENTS.md -> ~/.ssh/id_rsa) so its contents never reach the model.
          const real = realpathSync.native(join(project.path, name))
          if (real !== realRoot && !real.startsWith(rootPrefix)) continue
          raw = readFileSync(real, 'utf8')
        } catch {
          continue
        }
        const text = raw.trim()
        if (text.length === 0) continue
        const capped =
          text.length > PROJECT_INSTRUCTIONS_MAX_CHARS
            ? `${text.slice(0, PROJECT_INSTRUCTIONS_MAX_CHARS)}\n…[truncated]`
            : text
        return `Project instructions from ${name} (guidance for assistants working in this repository — follow it):\n\n${capped}`
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * Starts a background sub-agent (delegate background=true) and returns a
   * task-id note for the model. The task runs the same bounded delegate loop
   * with its own AbortController; task_stop / app teardown abort it.
   */
  /**
   * Evicts terminal background-task records beyond MAX_RETAINED_TERMINAL_TASKS,
   * oldest first (Map preserves insertion order). Running tasks are never
   * evicted. Called whenever a new task is registered so the registry stays
   * bounded regardless of how many tasks the model spawns over a session.
   */
  private pruneTerminalBackgroundTasks(): void {
    const terminal: string[] = []
    for (const [id, task] of this.backgroundTasks) {
      if (task.status !== 'running') terminal.push(id)
    }
    const excess = terminal.length - MAX_RETAINED_TERMINAL_TASKS
    for (let i = 0; i < excess; i++) this.backgroundTasks.delete(terminal[i])
  }

  startDelegateBackground(task: string, ctx: ToolExecuteContext, agentName?: string): string {
    this.pruneTerminalBackgroundTasks()
    const running = [...this.backgroundTasks.values()].filter(
      (t) => t.status === 'running'
    ).length
    if (running >= MAX_BACKGROUND_TASKS) {
      return `Error: ${MAX_BACKGROUND_TASKS} background tasks are already running. Poll task_output or stop one with task_stop first.`
    }
    this.backgroundTaskSeq += 1
    const taskId = `task-${this.backgroundTaskSeq}`
    const controller = new AbortController()
    const profile = agentName ? this.db.agents.getByName(agentName) : null
    const persisted = this.db.agentPlatform.runStart({
      conversationId: ctx.conversation.id,
      projectId: ctx.conversation.projectId,
      agentName: profile?.name ?? agentName ?? null,
      task,
      worktreePath: null,
      providerId: profile?.providerId ?? ctx.conversation.providerId,
      modelId: profile?.modelId ?? ctx.conversation.modelId,
    })
    const record: BackgroundTask = {
      status: 'running',
      result: '',
      controller,
      runId: persisted.id,
    }
    this.backgroundTasks.set(taskId, record)
    void this.runDelegate(task, ctx, controller.signal, agentName)
      .then((result) => {
        record.result = result
        if (record.status === 'running') {
          record.status = 'done'
          this.db.agentPlatform.runFinish(persisted.id, 'done', result)
          this.announceBackgroundRun(profile?.name ?? agentName, 'done', task, result, ctx)
        } else if (record.status === 'stopped') {
          // task_stop finished the row with an empty result before the loop
          // unwound — backfill whatever the delegate came back with (its last
          // answer or the stopped note) so Agent Control Center shows it too.
          this.db.agentPlatform.runFinish(persisted.id, 'stopped', result)
        }
      })
      .catch((e: unknown) => {
        if (record.status === 'running') {
          record.status = 'error'
          record.result = toNormalizedError(e).message
          this.db.agentPlatform.runFinish(persisted.id, 'error', record.result)
          this.announceBackgroundRun(profile?.name ?? agentName, 'error', task, record.result, ctx)
        }
      })
    return `Started background task '${taskId}'. Poll it with task_output({"taskId":"${taskId}"}); continue other work meanwhile.`
  }

  /** Tells the notifier a background run landed (never throws). */
  private announceBackgroundRun(
    label: string | null | undefined,
    status: 'done' | 'error',
    task: string,
    result: string,
    ctx: ToolExecuteContext
  ): void {
    try {
      this.options.onBackgroundRunFinished?.({
        label: label && label.trim().length > 0 ? label : 'Background agent',
        status,
        task,
        result,
        conversationId: ctx.conversation.id,
      })
    } catch {
      // Notification delivery is a courtesy, never a failure path.
    }
  }

  /**
   * Starts a background shell job (run_shell_command background=true) in the
   * granted project root and returns a task-id note for the model. The job
   * shares the delegate background-task registry, so task_output/task_stop
   * work on it; task_output additionally shows its output so far.
   */
  startShellBackground(command: string, cwd: string): string {
    this.pruneTerminalBackgroundTasks()
    const running = [...this.backgroundTasks.values()].filter(
      (t) => t.status === 'running'
    ).length
    if (running >= MAX_BACKGROUND_TASKS) {
      return `Error: ${MAX_BACKGROUND_TASKS} background tasks are already running. Poll task_output or stop one with task_stop first.`
    }
    this.backgroundTaskSeq += 1
    const taskId = `task-${this.backgroundTaskSeq}`
    const controller = new AbortController()
    let output = ''
    const record: BackgroundTask = {
      status: 'running',
      result: '',
      controller,
      getPartial: () => output,
    }
    this.backgroundTasks.set(taskId, record)
    void runShell(command, cwd, SHELL_BACKGROUND_TIMEOUT_MS, controller.signal, (chunk) => {
      output += chunk // runShell stops emitting at its output cap
    })
      .then((result) => {
        const parts: string[] = []
        if (result.timedOut) {
          parts.push(
            `Command timed out after ${SHELL_BACKGROUND_TIMEOUT_MS / 60_000} minutes and was killed.`
          )
        } else if (result.aborted) {
          parts.push('Command was stopped.')
        } else {
          parts.push(`Exit code: ${result.code ?? 'unknown'}`)
        }
        if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trimEnd()}`)
        if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trimEnd()}`)
        const text = redactSecrets(parts.join('\n\n')) || '(no output)'
        // A stopped job keeps 'stopped' status but records what it printed.
        if (record.status === 'running') record.status = 'done'
        record.result = text
      })
      .catch((e: unknown) => {
        if (record.status === 'running') {
          record.status = 'error'
          record.result = toNormalizedError(e).message
        }
      })
    return `Started background shell job '${taskId}' running: ${command}\nPoll it with task_output({"taskId":"${taskId}"}); stop it with task_stop.`
  }

  /** Status/result of a background task, as a model-readable string. */
  delegateTaskOutput(taskId: string): string {
    const record = this.backgroundTasks.get(taskId)
    if (!record) return `Error: unknown task id '${taskId}'.`
    switch (record.status) {
      case 'running':
        return record.getPartial
          ? `Task '${taskId}' is still running. Output so far:\n${
              redactSecrets(record.getPartial()) || '(no output yet)'
            }`
          : `Task '${taskId}' is still running.`
      case 'stopped':
        return record.result
          ? `Task '${taskId}' was stopped. ${record.result}`
          : `Task '${taskId}' was stopped before finishing.`
      case 'error':
        return `Task '${taskId}' failed: ${record.result}`
      default:
        return `Task '${taskId}' finished:\n${record.result}`
    }
  }

  /** Stops a running background task; its final output is recorded once the loop unwinds. */
  delegateTaskStop(taskId: string): string {
    const record = this.backgroundTasks.get(taskId)
    if (!record) return `Error: unknown task id '${taskId}'.`
    if (record.status !== 'running') {
      return `Task '${taskId}' already finished (${record.status}).`
    }
    record.status = 'stopped'
    record.controller.abort()
    if (record.runId) this.db.agentPlatform.runFinish(record.runId, 'stopped', record.result)
    return `Task '${taskId}' stopped.`
  }

  /** User-facing stop by persistent run id (Agent Control Center). */
  stopAgentRun(runId: string): boolean {
    for (const [taskId, record] of this.backgroundTasks) {
      if (record.runId !== runId || record.status !== 'running') continue
      this.delegateTaskStop(taskId)
      return true
    }
    return false
  }

  /**
   * Runs a sub-agent for the 'delegate' tool: a bounded, non-streaming
   * reasoning loop over the same provider/model with read-only project tools.
   * With `agentName` a user-defined agent profile supplies the persona, an
   * optional dedicated (often cheaper) model, a restricted toolset, and the
   * round budget instead. Nested tool calls reuse the parent's approval
   * callback (so the user still approves anything sensitive). Never throws —
   * returns a string result.
   */
  async runDelegate(
    task: string,
    ctx: ToolExecuteContext,
    signal?: AbortSignal,
    agentName?: string
  ): Promise<string> {
    try {
      const parent = this.db.conversations.getById(ctx.conversation.id) ?? ctx.conversation
      const settings = this.db.settings.get()

      let persona = DELEGATE_PERSONA
      let allowedToolIds: ReadonlySet<string> = DELEGATE_TOOL_IDS
      let maxRounds = DELEGATE_MAX_ROUNDS
      let overrides: ChatSendRequest['overrides']
      if (agentName) {
        const profile = this.db.agents.getByName(agentName)
        if (!profile || !profile.enabled) {
          const names = this.db.agents.listEnabled().map((a) => a.name)
          return names.length > 0
            ? `Error: no enabled agent named '${agentName}'. Available agents: ${names.join(', ')}.`
            : `Error: no agent profiles are defined. Omit the 'agent' parameter to use the general sub-agent.`
        }
        persona = profile.systemPrompt
        if (profile.providerId || profile.modelId) {
          overrides = {
            ...(profile.providerId ? { providerId: profile.providerId } : {}),
            ...(profile.modelId ? { modelId: profile.modelId } : {}),
          }
        }
        // No nesting regardless of the profile's tool list.
        if (profile.toolIds) {
          allowedToolIds = new Set(profile.toolIds.filter((id) => id !== 'delegate'))
        }
        if (profile.maxRounds && profile.maxRounds >= 1) {
          maxRounds = Math.min(profile.maxRounds, MAX_TOOL_ROUNDS)
        }
      }

      const resolved = await this.resolveTarget(parent, settings, overrides)
      const adapter = this.adapterFor(resolved)
      const tools = this.options.tools

      // The profile's allow-list holds definition ids (e.g. 'custom:<uuid>'),
      // but the model calls a tool by its WIRE name (== id for builtins, but
      // the user-chosen name for custom tools). Keep the enabled defs so we can
      // map a call's name back to its id before the allow-check below.
      const enabledDefs = tools ? tools.registry.listEnabledDefinitions() : []
      const toolDefs: AdapterToolDef[] = enabledDefs
        .filter((d) => allowedToolIds.has(d.id))
        .map(toAdapterToolDef)

      const messages: AdapterMessage[] = [
        { role: 'system', content: persona },
        { role: 'user', content: task },
      ]
      let final = ''
      for (let round = 0; round < maxRounds; round++) {
        if (signal?.aborted) return 'The task was stopped.'
        const result = await adapter.chat(
          {
            modelId: resolved.modelId,
            messages,
            params: resolved.params,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
            stream: false,
          },
          this.adapterCtx(resolved, signal)
        )
        if (result.text.trim()) final = result.text
        if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0 || !tools) break
        messages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls })
        for (const call of result.toolCalls) {
          // Resolve the wire name back to a definition id, then gate on the id
          // — otherwise a custom tool (id 'custom:<uuid>', name '<userName>')
          // is offered above but wrongly denied here.
          const def = enabledDefs.find((d) => d.id === call.name || d.name === call.name)
          const out =
            def && allowedToolIds.has(def.id)
              ? await tools.executor.execute(call, {
                  conversation: parent,
                  streamId: ctx.streamId,
                  approval: ctx.approval,
                  // Inherit the parent's mode gates: plan mode still blocks
                  // mutations, auto-accept edits still skips the edit dialog,
                  // and the sandbox level travels into sub-agents unchanged.
                  planMode: ctx.planMode,
                  autoAcceptEdits: ctx.autoAcceptEdits,
                  // The parent's question channel travels down too, so a
                  // sub-agent's question reaches the same places.
                  ...(ctx.askUser ? { askUser: ctx.askUser } : {}),
                  ...(agentName ? { agentName } : {}),
                  ...(ctx.sandboxLevel ? { sandboxLevel: ctx.sandboxLevel } : {}),
                  ...(signal ? { signal } : {}),
                })
              : `Tool '${call.name}' is not available to the sub-agent.`
          messages.push({ role: 'tool', content: out, toolCallId: call.id })
        }
      }
      return final.trim().length > 0
        ? `Sub-agent result:\n${final.trim()}`
        : 'The sub-agent produced no result.'
    } catch (e) {
      return `Delegation failed: ${toNormalizedError(e).message}`
    }
  }

  /**
   * Fans the preset's advisor (reference) models out in parallel over the
   * conversation text (no tools, no system prompt — cheap and provider-safe),
   * emitting a 'moa-reference' event as each starts/settles and persisting the
   * blocks on the placeholder. Shared by MoA (which aggregates afterwards) and
   * Compare (where the fan-out IS the result). Never throws; on an unexpected
   * failure the returned refs may still be 'running'.
   */
  private async runAdvisors(
    conversation: Conversation,
    preset: MoaPreset,
    buildOpts: HistoryBuildOptions,
    placeholder: Message,
    controller: AbortController,
    emit: (event: StreamEvent) => void,
    /**
     * Pre-seeded, already-final blocks (a second opinion's original answer).
     * They occupy the first indexes; only preset.referenceModels actually run.
     */
    seed: MoaReferenceOutput[] = []
  ): Promise<MoaReferenceOutput[]> {
    const settings = buildOpts.settings
    const references: MoaReferenceOutput[] = seed.map((ref) => ({ ...ref }))

    try {
      // moaLabel reads the providers table, so the blocks are built inside the
      // try — a DB failure here must not escape this never-throws method.
      for (const [index, ref] of preset.referenceModels.entries()) {
        references.push({
          index: seed.length + index,
          label: this.moaLabel(ref),
          providerId: ref.providerId,
          modelId: ref.modelId,
          status: 'running',
          text: '',
        })
      }
      // Advisors see the conversation turns only (system prompt + tools stripped),
      // matching Hermes: keeps reference calls cheap and dodges strict-provider
      // rejections of an unfamiliar system prompt.
      const refHistory = this.buildHistory(
        conversation,
        settings,
        {},
        buildOpts.visionEnabled
      ).filter((m) => m.role !== 'system')

      for (const ref of references) emit({ type: 'moa-reference', reference: { ...ref } })

      await Promise.all(
        preset.referenceModels.map(async (modelRef, index) => {
          const ref = references[seed.length + index]
          let target: ResolvedTarget | undefined
          try {
            target = await this.resolveTarget(conversation, settings, {
              providerId: modelRef.providerId,
              modelId: modelRef.modelId,
            })
            const params: ChatParams = {
              ...target.params,
              ...(preset.referenceMaxTokens !== undefined
                ? { maxTokens: preset.referenceMaxTokens }
                : {}),
              ...(preset.referenceTemperature !== undefined
                ? { temperature: preset.referenceTemperature }
                : {}),
            }
            const result = await this.adapterFor(target).chat(
              { modelId: target.modelId, messages: refHistory, params, stream: false },
              this.adapterCtx(target, controller.signal)
            )
            ref.status = 'done'
            ref.text = result.text
            if (result.usage) ref.usage = result.usage
          } catch (e) {
            ref.status = 'error'
            ref.error = toNormalizedError(
              e,
              target?.provider.type,
              target?.apiKey ? [target.apiKey] : undefined
            )
          }
          emit({ type: 'moa-reference', reference: { ...ref } })
        })
      )

      // Persist the advisor blocks now so a reload mid-aggregation still shows
      // them (the caller's finalize re-persists the same array at the end).
      try {
        this.db.messages.update(placeholder.id, { moaReferences: references })
      } catch {
        // Best-effort; the caller persists them again regardless.
      }
    } catch {
      // Unexpected reference-phase failure (e.g. a DB read): return what we
      // have rather than wedging the stream as 'streaming'.
    }
    return references
  }

  /**
   * Deep Research: plan → parallel web workers (web_search/fetch_url through
   * the real executor, so its deny/SSRF/https/size guards all apply) → then
   * delegate to the same runStream with the findings + numbered sources
   * injected into the last user turn (the MoA seam), keeping streaming,
   * abort and persistence unchanged. The pipeline never throws; a total
   * failure degrades to an answer-from-knowledge instruction.
   */
  private async runResearchStream(
    streamId: string,
    conversation: Conversation,
    resolved: ResolvedTarget,
    research: ResearchRunRequest,
    buildOpts: HistoryBuildOptions,
    placeholder: Message,
    controller: AbortController
  ): Promise<void> {
    const conversationId = conversation.id
    const emit = (event: StreamEvent): void => {
      try {
        this.broadcast(CHANNELS.streamEvent, { streamId, conversationId, event })
      } catch {
        // A window can be torn down mid-broadcast; persistence still happens.
      }
    }
    let outcome: ResearchOutcome
    try {
      const workerTarget = await this.resolveResearchWorkerTarget(
        conversation,
        buildOpts.settings,
        resolved
      )
      const tools = this.options.tools
      const researchToolDefs = tools
        ? tools.registry
            .listEnabledDefinitions()
            .filter((d) => d.id === 'web_search' || d.id === 'fetch_url')
            .map(toAdapterToolDef)
        : []
      // The explicit /research send is the user's consent for the run's
      // read-only web activity, so ONLY web_search/fetch_url are offered and
      // auto-approved (mirrors generateForWorkflow's headless callback, with
      // the opposite default). A 'deny' permission still refuses inside the
      // executor, and the pipeline declines every other tool name itself.
      const researchApproval = async (): Promise<ToolApprovalAnswer> => ({
        approved: true,
        scope: 'once',
      })
      const deps: ResearchDeps = {
        chat: (opts) =>
          this.adapterFor(workerTarget).chat(
            {
              modelId: workerTarget.modelId,
              messages: opts.messages,
              params: { ...workerTarget.params, ...opts.params },
              ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
              stream: false,
            },
            this.adapterCtx(workerTarget, controller.signal)
          ),
        executeTool: (call) =>
          tools
            ? tools.executor.execute(call, {
                conversation,
                streamId,
                approval: researchApproval,
                signal: controller.signal,
              })
            : Promise.resolve('Error: tools are unavailable in this context.'),
        listToolDefs: () => researchToolDefs,
        emit: (activity) => emit({ type: 'research-activity', activity }),
        signal: controller.signal,
      }
      outcome = await runResearchPipeline(research.question, research.depth, deps)
    } catch {
      // Defensive (the pipeline itself never throws): never wedge the stream.
      outcome = {
        injectedContext:
          'Web research failed to run. Answer from your own knowledge, clearly state that ' +
          'live research was unavailable, and do not fabricate sources or citations.',
        research: { depth: research.depth, plan: [], sources: [], searches: 0, pagesRead: 0 },
      }
    }
    // Synthesis runs tool-free with a plain mode prompt: report writing must
    // not wander into more tool rounds.
    return this.runStream(
      streamId,
      conversation,
      resolved,
      { ...buildOpts, promptOpts: {} },
      placeholder,
      controller,
      undefined,
      { injectedContext: outcome.injectedContext, research: outcome.research }
    )
  }

  /**
   * Worker model for research planning/gathering: the settings override when
   * resolvable, else the conversation's acting model. A broken override
   * degrades silently (never fatal) — the run just uses the acting model.
   */
  private async resolveResearchWorkerTarget(
    conversation: Conversation,
    settings: AppSettings,
    fallback: ResolvedTarget
  ): Promise<ResolvedTarget> {
    if (!settings.researchWorkerProviderId) return fallback
    try {
      return await this.resolveTarget(conversation, settings, {
        providerId: settings.researchWorkerProviderId,
        ...(settings.researchWorkerModelId ? { modelId: settings.researchWorkerModelId } : {}),
      })
    } catch {
      return fallback
    }
  }

  /**
   * Containment for the fan-out phase that runs BEFORE the generation is handed
   * to runStream (which has its own try/catch/finally): persists the placeholder
   * as failed and tells the renderer, so an unexpected throw can never leave the
   * message spinning as 'streaming'. The caller frees the conversation's slot.
   */
  private failPlaceholder(
    conversationId: string,
    placeholder: Message,
    e: unknown,
    emit: (event: StreamEvent) => void,
    resolved?: ResolvedTarget
  ): void {
    const error = toNormalizedError(
      e,
      resolved?.provider.type,
      resolved?.apiKey ? [resolved.apiKey] : undefined
    )
    let finalMessage: Message | null
    try {
      finalMessage = this.db.messages.update(placeholder.id, { status: 'error', error })
      if (finalMessage) this.db.conversations.touch(conversationId, Date.now())
    } catch {
      // Writes can fail during shutdown; broadcast the in-memory fallback.
      finalMessage = { ...placeholder, status: 'error', error }
    }
    if (finalMessage) emit({ type: 'error', error, message: finalMessage })
  }

  private async runMoaStream(
    streamId: string,
    conversation: Conversation,
    aggregator: ResolvedTarget,
    preset: MoaPreset,
    buildOpts: HistoryBuildOptions,
    placeholder: Message,
    controller: AbortController,
    adapterTools?: AdapterToolDef[]
  ): Promise<void> {
    const conversationId = conversation.id
    const emit = (event: StreamEvent): void => {
      try {
        this.broadcast(CHANNELS.streamEvent, { streamId, conversationId, event })
      } catch {
        // A window can be torn down mid-broadcast; persistence still happens.
      }
    }
    let references: MoaReferenceOutput[]
    try {
      references = await this.runAdvisors(
        conversation,
        preset,
        buildOpts,
        placeholder,
        controller,
        emit
      )
    } catch (e) {
      this.failPlaceholder(conversationId, placeholder, e, emit, aggregator)
      this.releaseStream(streamId, conversationId)
      return
    }

    const anyReferences = references.some((r) => r.status !== 'running')
    return this.runStream(
      streamId,
      conversation,
      aggregator,
      buildOpts,
      placeholder,
      controller,
      adapterTools,
      anyReferences
        ? { injectedContext: formatMoaContext(references, preset), moaReferences: references }
        : undefined
    )
  }

  /**
   * Compare ("Arena") run: the advisor fan-out IS the whole generation — no
   * aggregator. The placeholder finalizes with empty content plus the advisor
   * blocks; the user promotes one to the answer via pickCompareWinner.
   * Completion hooks are skipped: there is no answer text to parse yet.
   */
  private async runCompareStream(
    streamId: string,
    conversation: Conversation,
    preset: MoaPreset,
    buildOpts: HistoryBuildOptions,
    placeholder: Message,
    controller: AbortController,
    /** Pre-seeded final blocks (second opinion) — see runAdvisors. */
    seed: MoaReferenceOutput[] = []
  ): Promise<void> {
    const conversationId = conversation.id
    const emit = (event: StreamEvent): void => {
      try {
        this.broadcast(CHANNELS.streamEvent, { streamId, conversationId, event })
      } catch {
        // A window can be torn down mid-broadcast; persistence still happens.
      }
    }
    try {
      const references = await this.runAdvisors(
        conversation,
        preset,
        buildOpts,
        placeholder,
        controller,
        emit,
        seed
      )
      const aborted = controller.signal.aborted
      const anyDone = references.some((r) => r.status === 'done')
      const status: MessageStatus = aborted ? 'stopped' : anyDone ? 'complete' : 'error'
      const error: NormalizedError | null =
        status === 'error'
          ? (references.find((r) => r.error)?.error ?? {
              code: 'unknown',
              message: 'All compared models failed.',
              retryable: true,
            })
          : null
      let finalMessage: Message | null
      try {
        finalMessage = this.db.messages.update(placeholder.id, {
          content: '',
          status,
          error,
          moaReferences: references,
          compare: { pickedIndex: null },
        })
        if (finalMessage) this.db.conversations.touch(conversationId, Date.now())
      } catch {
        // Writes can fail during shutdown; broadcast the in-memory fallback.
        finalMessage = { ...placeholder, status, moaReferences: references }
      }
      // Row gone = the conversation was deleted mid-run: nothing to broadcast.
      if (!finalMessage) return
      this.maybeAutoTitle(conversationId)
      if (status === 'error' && error) {
        emit({ type: 'error', error, message: finalMessage })
      } else {
        emit({
          type: 'done',
          finishReason: aborted ? 'aborted' : 'stop',
          message: finalMessage,
        })
      }
    } catch (e) {
      this.failPlaceholder(conversationId, placeholder, e, emit)
    } finally {
      this.releaseStream(streamId, conversationId)
    }
  }

  /**
   * Promotes one advisor of a compare run to the message's answer: its text
   * becomes the message content, the message is re-attributed to the winning
   * provider/model, and the conversation switches to that model for the turns
   * that follow.
   */
  pickCompareWinner(req: ChatPickCompareWinnerRequest): ChatPickCompareWinnerResult {
    const conversation = this.db.conversations.getById(req.conversationId)
    if (!conversation) {
      throw new ProviderError('invalid_request', 'Conversation not found.')
    }
    if (this.activeByConversation.has(conversation.id)) {
      throw new ProviderError(
        'invalid_request',
        'Wait for the current generation to finish first.'
      )
    }
    const message = this.db.messages
      .listByConversation(conversation.id)
      .find((m) => m.id === req.messageId)
    if (!message || message.role !== 'assistant' || !message.compare) {
      throw new ProviderError('invalid_request', 'Not a compare message.')
    }
    if (message.compare.pickedIndex !== null) {
      throw new ProviderError(
        'invalid_request',
        'A winner was already picked for this comparison.'
      )
    }
    const ref = message.moaReferences?.find((r) => r.index === req.referenceIndex)
    if (!ref || ref.status !== 'done') {
      throw new ProviderError('invalid_request', 'That model produced no answer to use.')
    }
    const updatedMessage = this.db.messages.update(message.id, {
      content: ref.text,
      usage: ref.usage ?? null,
      providerId: ref.providerId,
      modelId: ref.modelId,
      compare: { pickedIndex: ref.index },
    })
    if (!updatedMessage) {
      throw new ProviderError('invalid_request', 'Message not found.')
    }
    const updatedConversation =
      this.db.conversations.update(conversation.id, {
        providerId: ref.providerId,
        modelId: ref.modelId,
      }) ?? conversation
    return { message: updatedMessage, conversation: updatedConversation }
  }

  /**
   * Drives the generation, including the tool loop:
   * - Rounds where the adapter finishes with 'tool_calls' execute each call
   *   through the ToolExecutor (permission short-circuits and per-call user
   *   approval happen inside it), then feed the assistant tool-call message
   *   plus role-'tool' result messages back and re-invoke the adapter with
   *   the same AbortController. Text deltas from every round stream into the
   *   same assistant placeholder ('\n\n'-separated once it has text).
   * - Abort is honoured between rounds and inside adapter streams. Executor
   *   calls themselves are not abortable (a pending approval resolves false
   *   on quit via the broker); the signal is re-checked right after them.
   * - The FINAL assistant message persists the toolCalls of all rounds with
   *   their results/statuses; usage is summed across rounds.
   */
  private async runStream(
    streamId: string,
    conversation: Conversation,
    resolved: ResolvedTarget,
    buildOpts: HistoryBuildOptions,
    placeholder: Message,
    controller: AbortController,
    adapterTools?: AdapterToolDef[],
    /**
     * Fan-out seam (MoA + Deep Research): `injectedContext` is appended to
     * the last user turn (advisor analyses / research findings the acting
     * model synthesizes); `moaReferences`/`research` are persisted on the
     * final message so the labelled blocks survive a reload. All undefined on
     * the ordinary single-model path.
     */
    extraOpts?: {
      injectedContext?: string
      moaReferences?: MoaReferenceOutput[]
      research?: ResearchRunInfo
    }
  ): Promise<void> {
    const conversationId = conversation.id
    const emitNow = (event: StreamEvent): void => {
      const envelope: StreamEventEnvelope = { streamId, conversationId, event }
      try {
        this.broadcast(CHANNELS.streamEvent, envelope)
      } catch {
        // A window can be torn down mid-broadcast; persistence still happens.
      }
    }
    const deltaBuffer = new StreamDeltaBuffer(emitNow)
    const emit = (event: StreamEvent): void => {
      if (event.type === 'text-delta' || event.type === 'reasoning-delta') {
        deltaBuffer.push(event)
        return
      }
      deltaBuffer.flush()
      emitNow(event)
    }

    let text = ''
    let reasoning = ''
    const toolCalls: ToolCallRecord[] = []
    // Images the generate_image tool produced this generation: streamed live
    // via 'attachment' events and persisted on the final assistant message.
    const generatedAttachments: Attachment[] = []
    let usage: TokenUsage | undefined
    let finishReason: 'stop' | 'length' | 'tool_calls' = 'stop'

    // Returns the persisted (or best-effort fallback) message, or null when the
    // placeholder row is gone — its conversation was deleted mid-stream, so the
    // caller must skip completion hooks and any further broadcast for it.
    const finalize = (status: MessageStatus, error?: NormalizedError): Message | null => {
      const patch: MessagePatch = {
        content: text,
        reasoning: reasoning.length > 0 ? reasoning : null,
        status,
        usage: usage ?? null,
        toolCalls: toolCalls.length > 0 ? toolCalls : null,
        error: error ?? null,
        ...(generatedAttachments.length > 0 ? { attachments: generatedAttachments } : {}),
        ...(extraOpts?.moaReferences ? { moaReferences: extraOpts.moaReferences } : {}),
        ...(extraOpts?.research ? { research: extraOpts.research } : {}),
      }
      try {
        const updated = this.db.messages.update(placeholder.id, patch)
        // update() returns null only when the id is unknown, i.e. the message
        // (and usually its conversation) was deleted while we streamed.
        if (!updated) return null
        this.db.conversations.touch(conversationId, Date.now())
        return updated
      } catch {
        // Writes can fail during shutdown; return the in-memory fallback so the
        // renderer still gets a final event. Boot-time recovery marks dangling
        // 'streaming' rows as 'stopped'.
        const fallback: Message = { ...placeholder, content: text, status }
        if (reasoning.length > 0) fallback.reasoning = reasoning
        if (usage) fallback.usage = usage
        if (toolCalls.length > 0) fallback.toolCalls = toolCalls
        if (generatedAttachments.length > 0) fallback.attachments = generatedAttachments
        if (error) fallback.error = error
        return fallback
      }
    }

    try {
      // Optional context compaction before the first round: summarize older
      // messages when the transcript approaches the model's context window. The
      // pass mutates `conversation.summary*` in place and persists them; on any
      // failure it is a no-op and the full history is used. This and buildHistory
      // run INSIDE the try so a DB read error is caught and finalized (and the
      // finally clears the stream slot) instead of leaving the conversation
      // wedged as 'streaming' forever with an unhandled rejection.
      await this.maybeCompact(conversation, resolved, buildOpts.settings, controller.signal)
      const history = this.buildHistory(
        conversation,
        buildOpts.settings,
        buildOpts.promptOpts,
        buildOpts.visionEnabled,
        this.shouldReplayToolCalls(resolved)
      )
      const adapter = this.adapterFor(resolved)
      const tools = this.options.tools
      const messages: AdapterMessage[] = [...history]
      // MoA/research: fold the injected context into the latest user turn.
      if (extraOpts?.injectedContext) appendContextToLastUser(messages, extraOpts.injectedContext)

      const appendText = (chunk: string): void => {
        if (chunk.length === 0) return
        text += chunk
        emit({ type: 'text-delta', text: chunk })
      }

      let toolRounds = 0
      for (;;) {
        const roundCalls: ToolCallRecord[] = []
        let roundText = ''
        let roundFinish: 'stop' | 'length' | 'tool_calls' = 'stop'
        // '\n\n' separator once per round, only when the placeholder already
        // has text (i.e. this is a follow-up round after tool results).
        let separatorPending = text.length > 0

        const stream = adapter.chatStream(
          {
            modelId: resolved.modelId,
            messages,
            params: resolved.params,
            tools: adapterTools,
            stream: true,
          },
          this.adapterCtx(resolved, controller.signal)
        )
        for await (const event of stream) {
          switch (event.type) {
            case 'text':
              if (event.text.length === 0) break
              if (separatorPending) {
                separatorPending = false
                appendText('\n\n')
              }
              roundText += event.text
              appendText(event.text)
              break
            case 'reasoning':
              reasoning += event.text
              emit({ type: 'reasoning-delta', text: event.text })
              break
            case 'tool_call':
              // Accumulate only; broadcast happens when the round settles.
              roundCalls.push({ ...event.toolCall, status: 'proposed' })
              break
            case 'usage':
              usage = addUsage(usage, event.usage)
              emit({ type: 'usage', usage })
              break
            case 'finish':
              roundFinish = event.reason === 'other' ? 'stop' : event.reason
              break
          }
        }

        // Final round: the model is done (or emitted calls we cannot run).
        if (roundFinish !== 'tool_calls' || roundCalls.length === 0 || !tools) {
          for (const call of roundCalls) emit({ type: 'tool-call', toolCall: call })
          toolCalls.push(...roundCalls)
          finishReason = roundFinish
          break
        }

        // Round cap exceeded: record the unexecuted calls, note it, finish.
        if (toolRounds >= MAX_TOOL_ROUNDS) {
          for (const call of roundCalls) emit({ type: 'tool-call', toolCall: call })
          toolCalls.push(...roundCalls)
          appendText(text.length > 0 ? `\n\n${TOOL_LIMIT_NOTE}` : TOOL_LIMIT_NOTE)
          finishReason = 'stop'
          break
        }
        toolRounds += 1

        // A stop issued while the adapter round was streaming must abort before
        // we run any tool (or ask for approval).
        if (controller.signal.aborted) {
          throw new ProviderError('aborted', 'Generation stopped.')
        }

        // Execute the round's calls sequentially (model emission order). The
        // executor handles permission short-circuits ('deny'/'always_allow')
        // and routes 'ask' through the broker -> renderer approval click. The
        // stream's AbortSignal is threaded through so a pending approval
        // resolves false immediately when the stream is stopped.
        const approval = (
          req: Omit<ToolApprovalRequest, 'requestId'>
        ): Promise<ToolApprovalAnswer> =>
          tools.broker.request(req, this.broadcast, controller.signal)
        const questions = tools.questions
        const askUser = questions
          ? (question: string, options: string[]): Promise<string | null> =>
              questions.request(
                { streamId, conversationId, question, options },
                this.broadcast,
                controller.signal
              )
          : undefined
        const planMode = conversation.mode === 'work' && conversation.params.planMode === true
        const autoAcceptEdits = !planMode && conversation.params.autoAcceptEdits === true
        const sandboxLevel =
          conversation.mode === 'work' ? conversation.params.sandboxLevel : undefined
        // Live tool output (shell commands) streams into the same envelope
        // channel so the renderer can show it while the tool runs.
        const onToolOutput = (toolCallId: string, chunk: string): void =>
          emit({ type: 'tool-output', toolCallId, chunk })
        // Generated images: collected for the final message and streamed live.
        const onAttachment = (attachment: Attachment): void => {
          generatedAttachments.push(attachment)
          emit({ type: 'attachment', attachment })
        }
        for (const call of roundCalls) {
          if (controller.signal.aborted) {
            throw new ProviderError('aborted', 'Generation stopped.')
          }
          emit({ type: 'tool-call', toolCall: { ...call } }) // status 'proposed'
          const result = await tools.executor.execute(call, {
            conversation,
            streamId,
            approval,
            ...(askUser ? { askUser } : {}),
            planMode,
            autoAcceptEdits,
            ...(sandboxLevel ? { sandboxLevel } : {}),
            onToolOutput,
            onAttachment,
            signal: controller.signal,
          })
          call.result = result
          call.status = toolCallStatus(result)
          // Recorded as it settles, not after the round: a Stop between two
          // calls throws out of this loop, and a call whose side effects already
          // happened must never be missing from the persisted message.
          toolCalls.push(call)
          emit({ type: 'tool-call', toolCall: { ...call } }) // with result/status
        }

        // Feed the round back: assistant message with toolCalls, then one
        // role-'tool' message per result, and re-invoke the adapter.
        messages.push({ role: 'assistant', content: roundText, toolCalls: roundCalls })
        for (const call of roundCalls) {
          messages.push({ role: 'tool', content: call.result ?? '', toolCallId: call.id })
        }

        // A computer-use action leaves a screenshot on the shared browser
        // session. ALWAYS consume it here (draining every round, vision or not)
        // so a non-vision generation can never leave one parked for a later
        // vision generation in another conversation to pick up. It is only
        // injected as a synthetic user image when this model has vision
        // (OpenAI rejects images in tool messages).
        const shot = this.options.browser?.consumePendingScreenshot() ?? null
        if (shot && buildOpts.visionEnabled) {
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: 'Screenshot after the computer action:' },
              { type: 'image_url', image_url: { url: shot } },
            ],
          })
        }

        if (controller.signal.aborted) {
          throw new ProviderError('aborted', 'Generation stopped.')
        }
      }

      // Research report: append the deterministic Sources section (built from
      // the app-collected registry, never model output) to the content itself,
      // so copy/export/bridges carry the sources with zero further changes.
      if (extraOpts?.research && extraOpts.research.sources.length > 0) {
        appendText(`\n\n${formatSourcesSection(extraOpts.research.sources)}`)
      }

      const finalMessage = finalize('complete')
      // The conversation was deleted mid-stream: the row is gone, so skip the
      // completion hooks and the 'done' broadcast entirely.
      if (!finalMessage) return
      this.maybeAutoTitle(conversationId)
      // Completion hooks run AFTER the message is persisted and BEFORE 'done'
      // is broadcast, so a renderer that refreshes on 'done' already sees the
      // side effects (proposed code changes, saved workspace items). Hooks
      // never throw (each is isolated inside runCompletionHooks).
      await runCompletionHooks(conversation, finalMessage)
      emit({ type: 'done', finishReason, message: finalMessage })
    } catch (e) {
      const normalized = toNormalizedError(e, resolved.provider.type, [resolved.apiKey])
      if (controller.signal.aborted || normalized.code === 'aborted') {
        const finalMessage = finalize('stopped')
        if (finalMessage) emit({ type: 'done', finishReason: 'aborted', message: finalMessage })
      } else {
        const finalMessage = finalize('error', normalized)
        if (finalMessage) emit({ type: 'error', error: normalized, message: finalMessage })
      }
    } finally {
      deltaBuffer.flush()
      this.releaseStream(streamId, conversationId)
    }
  }

  private maybeAutoTitle(conversationId: string): void {
    try {
      const conversation = this.db.conversations.getById(conversationId)
      if (!conversation || conversation.title !== DEFAULT_TITLE) return
      const firstUser = this.db.messages
        .listByConversation(conversationId)
        .find((m) => m.role === 'user' && m.content.trim().length > 0)
      if (!firstUser) return
      const firstLine = firstUser.content.trim().split('\n')[0].trim()
      const title = firstLine.slice(0, TITLE_MAX_CHARS)
      if (title.length === 0) return
      this.db.conversations.update(conversationId, { title })
      this.broadcast(CHANNELS.conversationsChanged, { conversationId })
    } catch {
      // Titling is cosmetic — never let it break stream completion.
    }
  }
}
