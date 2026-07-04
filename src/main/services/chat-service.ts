/**
 * Chat orchestration: resolves provider/model/params, persists messages,
 * drives adapter streams in detached loops (including the multi-round tool
 * loop), and forwards stream events to all renderer windows. The API key is
 * decrypted only inside the send/regenerate/editAndRerun call path and never
 * leaves this module.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AppSettings,
  ChatParams,
  Conversation,
  Message,
  MessageStatus,
  NormalizedError,
  ProviderConfig,
  ProviderType,
  StartStreamResult,
  StreamEvent,
  StreamEventEnvelope,
  TokenUsage,
  ToolApprovalRequest,
  ToolCallRecord,
  ToolDefinition,
} from '@shared/types'
import {
  CHANNELS,
  type ChatEditAndRerunRequest,
  type ChatRegenerateRequest,
  type ChatSendRequest,
} from '@shared/ipc'
import { PROVIDER_TYPES, UNKNOWN_MODEL_CAPS, findCatalogModel } from '@shared/catalog'
import type { AppDatabase } from '../db/database'
import type { MessagePatch } from '../db/repositories/messages'
import type {
  AdapterMessage,
  AdapterToolDef,
  ContentPart,
  ProviderAdapter,
} from '../providers/adapter'
import { getAdapter } from '../providers/registry'
import { ProviderError, toNormalizedError } from '../providers/errors'
import { decryptKey } from '../keys/keystore'
import { buildModeSystemPrompt, type ModePromptOptions } from '../prompts'
import type { ToolExecuteContext } from '../tools/executor'
import { USER_DECLINED_RESULT } from '../tools/executor'
import { runCompletionHooks } from './completion-hooks'

const DEFAULT_TITLE = 'New chat'
const TITLE_MAX_CHARS = 60

/**
 * Maximum number of tool-execution rounds per generation. Each round is one
 * adapter invocation that finished with 'tool_calls' followed by executing
 * those calls and feeding the results back. When the model asks for tools yet
 * again after the fifth round, the remaining calls are recorded (unexecuted)
 * and the generation finishes with a note appended to the content.
 */
const MAX_TOOL_ROUNDS = 5

const TOOL_LIMIT_NOTE =
  `[Tool-call limit reached (${MAX_TOOL_ROUNDS} rounds) — the remaining tool calls were not run.]`

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
  ): Promise<boolean>
}

export interface ChatToolSystem {
  registry: ChatToolRegistry
  executor: ChatToolExecutor
  broker: ChatApprovalBroker
}

export interface ChatServiceOptions {
  /** When absent, generations never offer tools (MVP behaviour). */
  tools?: ChatToolSystem
  /** Test seam: adapter resolution (defaults to the real provider registry). */
  resolveAdapter?: (type: ProviderType) => ProviderAdapter
  /** Directory holding stored image attachments (for the vision wire payload). */
  imageDir?: string
  /** Embedded browser — a computer-use screenshot is injected after each round. */
  browser?: { consumePendingScreenshot(): string | null }
}

interface ResolvedTarget {
  provider: ProviderConfig
  modelId: string
  params: ChatParams
  apiKey: string
}

interface ActiveStream {
  controller: AbortController
  conversationId: string
  /** Resolves when the detached runStream loop has fully settled (persisted). */
  done: Promise<void>
}

/** How the tool system participates in one generation. */
interface ToolPlan {
  /** Definitions offered to the model; undefined = no tools on the wire. */
  adapterTools?: AdapterToolDef[]
  /** Mode-prompt options (manual-instructions fallback when unsupported). */
  promptOpts: ModePromptOptions
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

const DELEGATE_MAX_ROUNDS = 4
/** Read-only builtin tools a delegated sub-agent may use. */
const DELEGATE_TOOL_IDS = new Set([
  'file_search',
  'repo_map',
  'read_file',
  'list_directory',
  'fetch_url',
])
const DELEGATE_PERSONA =
  'You are a focused sub-agent working on a single delegated task. You do not see the parent ' +
  'conversation — work only from the task and context you are given. Use the available read-only ' +
  'tools when they help, then return a concise, self-contained result. Do not ask questions; make ' +
  'reasonable assumptions and state them.'

/** Text of a message for estimation/summarization (inlines attachment text). */
function messageEstimateText(message: Message): string {
  let text = message.content
  for (const attachment of message.attachments ?? []) {
    if (attachment.textContent) text += attachment.textContent
  }
  return text
}

export class ChatService {
  private readonly streams = new Map<string, ActiveStream>()
  private readonly activeByConversation = new Map<string, string>()

  constructor(
    private readonly db: AppDatabase,
    private readonly broadcast: Broadcast,
    private readonly options: ChatServiceOptions = {}
  ) {}

  send(req: ChatSendRequest): StartStreamResult {
    const conversation = this.requireConversation(req.conversationId)
    this.ensureIdle(conversation.id)
    const settings = this.db.settings.get()
    const resolved = this.resolveTarget(conversation, settings, req.overrides)

    // Content is stored as typed; attachment text is inlined only on the wire.
    const userMessage: Message = {
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'user',
      content: req.content,
      attachments: req.attachments && req.attachments.length > 0 ? req.attachments : undefined,
      status: 'complete',
      seq: this.db.messages.nextSeq(conversation.id),
      createdAt: Date.now(),
    }
    this.db.messages.insert(userMessage)

    return this.start(conversation, settings, resolved, userMessage)
  }

  regenerate(req: ChatRegenerateRequest): StartStreamResult {
    const conversation = this.requireConversation(req.conversationId)
    this.ensureIdle(conversation.id)
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
    const resolved = this.resolveTarget(conversation, settings, undefined)
    this.db.messages.deleteById(target.id)
    return this.start(conversation, settings, resolved, null)
  }

  editAndRerun(req: ChatEditAndRerunRequest): StartStreamResult {
    const conversation = this.requireConversation(req.conversationId)
    this.ensureIdle(conversation.id)
    const messages = this.db.messages.listByConversation(conversation.id)
    const target = messages.find((m) => m.id === req.messageId)
    if (!target || target.role !== 'user') {
      throw new ProviderError('invalid_request', 'Only user messages can be edited and rerun.')
    }
    const settings = this.db.settings.get()
    const resolved = this.resolveTarget(conversation, settings, undefined)
    const updated = this.db.messages.update(target.id, { content: req.newContent })
    if (!updated) {
      throw new ProviderError('invalid_request', 'Message not found.')
    }
    this.db.messages.deleteAfterSeq(conversation.id, target.seq)
    return this.start(conversation, settings, resolved, updated)
  }

  stop(streamId: string): void {
    this.streams.get(streamId)?.controller.abort()
  }

  /** Aborts the stream (if any) currently generating in a conversation. */
  stopConversation(conversationId: string): void {
    const streamId = this.activeByConversation.get(conversationId)
    if (!streamId) return
    this.streams.get(streamId)?.controller.abort()
  }

  /**
   * Called on app quit — no stream may outlive the process. Aborts every
   * active controller and awaits the detached loops so their partial output is
   * persisted before the caller closes the database, with a safety timeout so
   * a stuck loop can never block quit indefinitely.
   */
  async stopAll(timeoutMs = 3000): Promise<void> {
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

  private resolveTarget(
    conversation: Conversation,
    settings: AppSettings,
    overrides: ChatSendRequest['overrides']
  ): ResolvedTarget {
    const providerId =
      overrides?.providerId ?? conversation.providerId ?? settings.defaultProviderId
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
    const encrypted = this.db.providers.getEncryptedKey(provider.id)
    if (!encrypted) {
      throw new ProviderError(
        'auth',
        `No API key configured for ${provider.label}. Add one in Settings.`
      )
    }
    const apiKey = decryptKey(encrypted)

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
    return { provider, modelId, params, apiKey }
  }

  /** Inserts the placeholder, snapshots history, and kicks off the detached loop. */
  private start(
    conversation: Conversation,
    settings: AppSettings,
    resolved: ResolvedTarget,
    userMessage: Message | null
  ): StartStreamResult {
    const assistantMessage: Message = {
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'assistant',
      content: '',
      status: 'streaming',
      providerId: resolved.provider.id,
      modelId: resolved.modelId,
      seq: this.db.messages.nextSeq(conversation.id),
      createdAt: Date.now(),
    }
    this.db.messages.insert(assistantMessage)

    const toolPlan = this.planTools(resolved)
    const visionEnabled =
      findCatalogModel(resolved.provider.type, resolved.modelId)?.capabilities.vision ??
      UNKNOWN_MODEL_CAPS.vision
    const streamId = randomUUID()
    const controller = new AbortController()
    const active: ActiveStream = {
      controller,
      conversationId: conversation.id,
      done: Promise.resolve(),
    }
    this.streams.set(streamId, active)
    this.activeByConversation.set(conversation.id, streamId)

    // History is built inside runStream, AFTER an optional (async) context
    // compaction pass, so the summary and the pruned transcript are in sync.
    const buildOpts: HistoryBuildOptions = {
      settings,
      promptOpts: toolPlan.promptOpts,
      visionEnabled,
    }

    // Track the detached loop so stopAll() can await its persistence on quit.
    active.done = this.runStream(
      streamId,
      conversation,
      resolved,
      buildOpts,
      assistantMessage,
      controller,
      toolPlan.adapterTools
    )
    void active.done

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

    const modelSupportsTools =
      findCatalogModel(resolved.provider.type, resolved.modelId)?.capabilities.tools ??
      UNKNOWN_MODEL_CAPS.tools
    const toolNames = enabled.map((def) => def.name)
    if (!modelSupportsTools) {
      return { promptOpts: { toolsAvailable: false, toolNames } }
    }
    return {
      // Models call tools by our definition id (the registry resolves either
      // id or name, and builtin ids double as their names).
      adapterTools: enabled.map((def) => ({
        name: def.id,
        description: def.description,
        parameters: def.parameters,
      })),
      promptOpts: { toolsAvailable: true, toolNames },
    }
  }

  private buildHistory(
    conversation: Conversation,
    settings: AppSettings,
    promptOpts: ModePromptOptions,
    visionEnabled: boolean
  ): AdapterMessage[] {
    const history: AdapterMessage[] = []
    // Effective system prompt = mode base prompt + the user's extras (the
    // per-conversation prompt wins over the global default). The mode prompt
    // is always non-empty, so a system message is always sent now — in chat
    // mode with no extras that is just the base persona.
    const extras =
      (conversation.systemPrompt ?? '').trim() || settings.defaultSystemPrompt.trim()
    const systemPrompt = [buildModeSystemPrompt(conversation.mode, promptOpts), extras]
      .filter((part) => part.length > 0)
      .join('\n\n')
      .trim()
    if (systemPrompt) {
      history.push({ role: 'system', content: systemPrompt })
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
      const content =
        message.role === 'user'
          ? composeUserContent(message, visionEnabled, this.options.imageDir)
          : message.content
      if (contentIsEmpty(content)) continue
      // Tool calls are intentionally omitted from history in the MVP: without
      // matching role-'tool' result messages, providers reject the transcript.
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
      const contextLength =
        findCatalogModel(resolved.provider.type, resolved.modelId)?.contextLength ??
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

      const estimate =
        active.reduce((sum, m) => sum + estimateTokens(messageEstimateText(m)), 0) +
        estimateTokens(conversation.summaryText ?? '')
      if (estimate < threshold) return
      if (active.length <= COMPACTION_KEEP_RECENT + 1) return

      const toSummarize = active.slice(0, active.length - COMPACTION_KEEP_RECENT)
      if (toSummarize.length === 0) return
      const newThroughSeq = toSummarize[toSummarize.length - 1].seq
      // Never summarize past the latest user turn (it must be sent verbatim).
      const latestUserSeq = Math.max(
        ...active.filter((m) => m.role === 'user').map((m) => m.seq),
        -1
      )
      if (newThroughSeq >= latestUserSeq) return

      const parts: string[] = []
      if (conversation.summaryText) parts.push(`Summary so far:\n${conversation.summaryText}`)
      for (const m of toSummarize) {
        parts.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${messageEstimateText(m)}`)
      }

      const resolveAdapter = this.options.resolveAdapter ?? getAdapter
      const adapter = resolveAdapter(resolved.provider.type)
      const result = await adapter.chat(
        {
          modelId: resolved.modelId,
          messages: [
            { role: 'system', content: COMPACTION_INSTRUCTION },
            { role: 'user', content: parts.join('\n\n') },
          ],
          params: { maxTokens: 1024 },
          stream: false,
        },
        { apiKey: resolved.apiKey, baseUrl: resolved.provider.baseUrl, signal }
      )
      const summary = result.text.trim()
      if (summary.length === 0) return

      this.db.conversations.setSummary(conversation.id, summary, newThroughSeq)
      conversation.summaryText = summary
      conversation.summaryThroughSeq = newThroughSeq
    } catch {
      // Compaction is best-effort: fall back to the full history on any error.
    }
  }

  /**
   * Non-streaming generation used by headless callers (e.g. the Telegram
   * bridge). Persists the incoming user message and the assistant reply, and
   * returns the reply text. Throws on config errors (no provider/key/model).
   */
  async generateHeadless(conversationId: string, userText: string): Promise<string> {
    const conversation = this.requireConversation(conversationId)
    const settings = this.db.settings.get()
    const resolved = this.resolveTarget(conversation, settings, undefined)

    const userMessage: Message = {
      id: randomUUID(),
      conversationId,
      role: 'user',
      content: userText,
      status: 'complete',
      seq: this.db.messages.nextSeq(conversationId),
      createdAt: Date.now(),
    }
    this.db.messages.insert(userMessage)

    const toolPlan = this.planTools(resolved)
    const visionEnabled =
      findCatalogModel(resolved.provider.type, resolved.modelId)?.capabilities.vision ??
      UNKNOWN_MODEL_CAPS.vision
    const history = this.buildHistory(conversation, settings, toolPlan.promptOpts, visionEnabled)
    const adapter = (this.options.resolveAdapter ?? getAdapter)(resolved.provider.type)
    const result = await adapter.chat(
      {
        modelId: resolved.modelId,
        messages: history,
        params: resolved.params,
        stream: false,
      },
      { apiKey: resolved.apiKey, baseUrl: resolved.provider.baseUrl }
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
    this.broadcast(CHANNELS.conversationsChanged, {})
    await runCompletionHooks(conversation, assistant)
    return result.text
  }

  /**
   * One-shot, conversation-less generation for workflow ai_agent nodes.
   * Resolves the provider/model from the given ids or the global defaults.
   * Throws on config errors (no provider/key/model).
   */
  async generateForWorkflow(prompt: string, providerId?: string, modelId?: string): Promise<string> {
    const settings = this.db.settings.get()
    const stub: Conversation = {
      id: 'workflow',
      mode: 'chat',
      title: '',
      providerId: null,
      modelId: null,
      systemPrompt: null,
      params: {},
      workspaceId: null,
      projectId: null,
      createdAt: 0,
      updatedAt: 0,
    }
    const resolved = this.resolveTarget(stub, settings, { providerId, modelId })
    const adapter = (this.options.resolveAdapter ?? getAdapter)(resolved.provider.type)
    const result = await adapter.chat(
      {
        modelId: resolved.modelId,
        messages: [{ role: 'user', content: prompt }],
        params: resolved.params,
        stream: false,
      },
      { apiKey: resolved.apiKey, baseUrl: resolved.provider.baseUrl }
    )
    return result.text
  }

  /**
   * Runs a sub-agent for the 'delegate' tool: a bounded, non-streaming
   * reasoning loop over the same provider/model with read-only project tools.
   * Nested tool calls reuse the parent's approval callback (so the user still
   * approves anything sensitive). Never throws — returns a string result.
   */
  async runDelegate(task: string, ctx: ToolExecuteContext): Promise<string> {
    try {
      const parent = this.db.conversations.getById(ctx.conversation.id) ?? ctx.conversation
      const settings = this.db.settings.get()
      const resolved = this.resolveTarget(parent, settings, undefined)
      const adapter = (this.options.resolveAdapter ?? getAdapter)(resolved.provider.type)
      const tools = this.options.tools

      const toolDefs: AdapterToolDef[] = tools
        ? tools.registry
            .listEnabledDefinitions()
            .filter((d) => DELEGATE_TOOL_IDS.has(d.id))
            .map((d) => ({ name: d.id, description: d.description, parameters: d.parameters }))
        : []

      const messages: AdapterMessage[] = [
        { role: 'system', content: DELEGATE_PERSONA },
        { role: 'user', content: task },
      ]
      let final = ''
      for (let round = 0; round < DELEGATE_MAX_ROUNDS; round++) {
        const result = await adapter.chat(
          {
            modelId: resolved.modelId,
            messages,
            params: resolved.params,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
            stream: false,
          },
          { apiKey: resolved.apiKey, baseUrl: resolved.provider.baseUrl }
        )
        if (result.text.trim()) final = result.text
        if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0 || !tools) break
        messages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls })
        for (const call of result.toolCalls) {
          const out = DELEGATE_TOOL_IDS.has(call.name)
            ? await tools.executor.execute(call, {
                conversation: parent,
                streamId: ctx.streamId,
                approval: ctx.approval,
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
    adapterTools?: AdapterToolDef[]
  ): Promise<void> {
    const conversationId = conversation.id
    // Optional context compaction before the first round: summarize older
    // messages when the transcript approaches the model's context window. The
    // pass mutates `conversation.summary*` in place and persists them; on any
    // failure it is a no-op and the full history is used.
    await this.maybeCompact(conversation, resolved, buildOpts.settings, controller.signal)
    const history = this.buildHistory(
      conversation,
      buildOpts.settings,
      buildOpts.promptOpts,
      buildOpts.visionEnabled
    )
    const emit = (event: StreamEvent): void => {
      const envelope: StreamEventEnvelope = { streamId, conversationId, event }
      try {
        this.broadcast(CHANNELS.streamEvent, envelope)
      } catch {
        // A window can be torn down mid-broadcast; persistence still happens.
      }
    }

    let text = ''
    let reasoning = ''
    const toolCalls: ToolCallRecord[] = []
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
        if (error) fallback.error = error
        return fallback
      }
    }

    try {
      const resolveAdapter = this.options.resolveAdapter ?? getAdapter
      const adapter = resolveAdapter(resolved.provider.type)
      const tools = this.options.tools
      const messages: AdapterMessage[] = [...history]

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
          {
            apiKey: resolved.apiKey,
            baseUrl: resolved.provider.baseUrl,
            signal: controller.signal,
          }
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
        const approval = (req: Omit<ToolApprovalRequest, 'requestId'>): Promise<boolean> =>
          tools.broker.request(req, this.broadcast, controller.signal)
        for (const call of roundCalls) {
          if (controller.signal.aborted) {
            throw new ProviderError('aborted', 'Generation stopped.')
          }
          emit({ type: 'tool-call', toolCall: { ...call } }) // status 'proposed'
          const result = await tools.executor.execute(call, {
            conversation,
            streamId,
            approval,
          })
          call.result = result
          call.status = toolCallStatus(result)
          emit({ type: 'tool-call', toolCall: { ...call } }) // with result/status
        }
        toolCalls.push(...roundCalls)

        // Feed the round back: assistant message with toolCalls, then one
        // role-'tool' message per result, and re-invoke the adapter.
        messages.push({ role: 'assistant', content: roundText, toolCalls: roundCalls })
        for (const call of roundCalls) {
          messages.push({ role: 'tool', content: call.result ?? '', toolCallId: call.id })
        }

        // A computer-use action leaves a screenshot; give it to a vision model
        // as a synthetic user image (OpenAI rejects images in tool messages).
        if (buildOpts.visionEnabled && this.options.browser) {
          const shot = this.options.browser.consumePendingScreenshot()
          if (shot) {
            messages.push({
              role: 'user',
              content: [
                { type: 'text', text: 'Screenshot after the computer action:' },
                { type: 'image_url', image_url: { url: shot } },
              ],
            })
          }
        }

        if (controller.signal.aborted) {
          throw new ProviderError('aborted', 'Generation stopped.')
        }
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
      this.streams.delete(streamId)
      if (this.activeByConversation.get(conversationId) === streamId) {
        this.activeByConversation.delete(conversationId)
      }
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
      this.broadcast(CHANNELS.conversationsChanged, {})
    } catch {
      // Titling is cosmetic — never let it break stream completion.
    }
  }
}
