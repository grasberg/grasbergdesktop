/**
 * Shared domain types for Grasberg.
 * This file is the contract between main process, preload and renderer.
 * It must not import from any runtime module (types only + pure constants).
 */

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Built-in provider families. `openai-compatible` covers any custom endpoint. */
export type ProviderType =
  | 'deepseek'
  | 'zhipu'
  | 'minimax'
  | 'openai'
  | 'zai-coding'
  | 'anthropic'
  | 'google'
  | 'bedrock'
  | 'openai-compatible'

/**
 * How a provider authenticates.
 * - `api_key`: a stored, encrypted key sent as `Authorization: Bearer <key>`
 *   (the default; covers subscription/coding-plan keys too — those are just a
 *   key against a specific endpoint).
 * - `chatgpt_oauth`: "Sign in with ChatGPT" — an OAuth/PKCE flow whose access
 *   token pays via the user's ChatGPT subscription against the ChatGPT backend.
 *   Reverse-engineered and unofficial; clearly flagged experimental in the UI.
 */
export type AuthMode = 'api_key' | 'chatgpt_oauth'

export interface ModelCapabilities {
  streaming: boolean
  /** Supports OpenAI-style tool/function calling. */
  tools: boolean
  vision: boolean
  /** Emits reasoning/thinking content (e.g. deepseek-reasoner). */
  reasoning: boolean
  /** Generates images (text-to-image output). Absent = no. */
  imageOutput?: boolean
}

export interface ModelInfo {
  id: string
  /** Human-readable label; falls back to id. */
  label?: string
  contextLength?: number
  maxOutputTokens?: number
  capabilities: ModelCapabilities
  /** True when the id came from the static catalog rather than a live /models call. */
  fromCatalog?: boolean
}

/** Static metadata about a provider family (used by Settings UI + adapters). */
export interface ProviderTypeMeta {
  type: ProviderType
  label: string
  defaultBaseUrl: string
  /** Docs link shown in Settings when adding a key. */
  docsUrl: string
  /** Whether GET {baseUrl}/models is expected to work. */
  supportsModelListing: boolean
  /** Catalog of known models (used as fallback and for capability display). */
  knownModels: ModelInfo[]
  defaultModelId: string
  /** Auth methods this family supports; defaults to ['api_key'] when omitted. */
  authModes?: AuthMode[]
  /** Field label for the API key, e.g. "Coding Plan API key". */
  keyLabel?: string
  /** Short note shown under the type (e.g. subscription/coding-plan hint). */
  hint?: string
  /**
   * Image-generation models this family serves (the generate_image tool).
   * Absent = the family has no image endpoint.
   */
  imageModels?: ModelInfo[]
  /** Default image model when the user hasn't picked one. */
  defaultImageModelId?: string
}

/** A user-configured provider instance (stored in SQLite; key stored separately). */
export interface ProviderConfig {
  id: string
  type: ProviderType
  /** User-facing name, e.g. "DeepSeek" or "My local vLLM". */
  label: string
  baseUrl: string
  defaultModelId: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  /** How this provider authenticates (api_key unless it uses a login flow). */
  authMode: AuthMode
  /**
   * For an OpenAI-compatible provider created from a generated preset (models.dev),
   * the preset id — supplies its model catalog + pricing. Null for direct families.
   */
  presetId: string | null
  /** Derived, never the key itself. */
  hasKey: boolean
  /** Masked preview like "sk-…4f2a", computed in main. Never the full key. */
  keyPreview: string | null
  /** For OAuth providers: whether a valid session/token is stored. */
  oauthConnected?: boolean
  /** For OAuth providers: safe display of the signed-in account (never a token). */
  oauthAccountLabel?: string | null
}

export interface ProviderConfigInput {
  type: ProviderType
  label: string
  baseUrl?: string
  defaultModelId?: string
  enabled?: boolean
  authMode?: AuthMode
  /** Links this provider to a generated OpenAI-compatible preset (models.dev). */
  presetId?: string | null
}

/** Safe, token-free view of an OAuth session for a provider. */
export interface OAuthStatus {
  connected: boolean
  /** e.g. an email or account id — never a token. */
  accountLabel?: string | null
  /** Unix ms when the current access token expires, when known. */
  expiresAt?: number | null
}

export interface ProviderConfigPatch {
  label?: string
  baseUrl?: string
  defaultModelId?: string
  enabled?: boolean
}

export interface TestConnectionResult {
  ok: boolean
  /** Safe, human-readable outcome. Must never contain the API key. */
  message: string
  /** Round-trip latency in ms when ok. */
  latencyMs?: number
  modelCount?: number
}

// ---------------------------------------------------------------------------
// Errors (normalized across providers)
// ---------------------------------------------------------------------------

export type ProviderErrorCode =
  | 'auth' // 401/403 — bad or missing key
  | 'rate_limit' // 429
  | 'invalid_request' // 400/404/422 — bad model id, bad params
  | 'context_length' // prompt too long
  | 'server' // 5xx
  | 'network' // DNS/socket/fetch failure
  | 'timeout'
  | 'aborted' // user pressed stop
  | 'not_supported' // feature unavailable on this provider/model
  | 'unknown'

export interface NormalizedError {
  code: ProviderErrorCode
  /** Sanitized message safe to show and log — never contains API keys. */
  message: string
  status?: number
  /** Seconds to wait, from Retry-After when present. */
  retryAfterSec?: number
  retryable: boolean
  providerType?: ProviderType
}

/**
 * Why a Reliability Autopilot hop happened: a transient provider error, or a
 * completed stream that produced no text, reasoning or tool calls at all.
 */
export type FailoverReason = ProviderErrorCode | 'empty_reply'

/** One failover hop: the provider/model that failed, and why. */
export interface FailoverAttempt {
  providerId: string
  modelId: string
  code: FailoverReason
}

/** One entry of a failover chain (both parts required). */
export interface FailoverChainEntry {
  providerId: string
  modelId: string
}

/**
 * Ordered fallback models tried when a generation fails with a transient
 * provider error (rate limit, outage, network, timeout) or returns nothing —
 * before any tool has run. Separate chains for interactive chats and
 * headless/background runs.
 */
export interface FailoverChains {
  interactive?: FailoverChainEntry[]
  headless?: FailoverChainEntry[]
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/**
 * 'chat' = plain conversation. 'work' = agentic mode: the assistant can create
 * real files (in the task's workspace folder or a user-granted folder), edit
 * code through the reviewable change pipeline, build HTML prototypes, and keep
 * a task list — surfaced on demand in the Work panel.
 */
export type ConversationMode = 'chat' | 'work'

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

export type MessageStatus = 'complete' | 'streaming' | 'error' | 'stopped'

export interface Attachment {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  /** 'image' for images sent to vision models, 'pdf' for stored PDFs, 'audio' for stored audio; otherwise text (default). */
  kind?: 'text' | 'image' | 'pdf' | 'audio'
  /** Extracted text content that gets sent to the provider (text files). */
  textContent?: string
  /** Text pulled from a PDF text layer, OCR or an audio transcript; inlined on the wire like textContent. */
  extractedText?: string
  /**
   * How extractedText was produced. 'none' = no machine-readable text was
   * found (a scanned document) — the UI offers user-triggered OCR then.
   * 'transcript' = whisper speech-to-text of an audio attachment.
   */
  extraction?: 'text' | 'ocr' | 'transcript' | 'none'
  /**
   * Send the original PDF bytes as a document content part to providers that
   * support it (Anthropic, Google); others receive the extracted text instead.
   * Capped at MAX_RAW_ATTACH_BYTES main-side.
   */
  rawAttach?: boolean
  /**
   * Filename of the stored image under the app's attachments dir (image kind).
   * The bytes live on disk, not inline in the DB; the wire payload and
   * thumbnails are built on demand from this.
   */
  storageKey?: string
  /**
   * Transient data URL for immediate preview right after picking. Never
   * persisted (stripped at the IPC boundary) — reload uses app.readAttachment.
   */
  dataUrl?: string
  /**
   * Present on assistant-message images produced by the generate_image tool:
   * which model made it and at what requested size (for the caption).
   */
  generatedBy?: { modelId: string; size?: string }
}

export interface ToolCallRecord {
  id: string
  name: string
  /** JSON string of arguments as produced by the model. */
  arguments: string
  /** Result content if the tool ran (or user-declined note). */
  result?: string
  status: 'proposed' | 'approved' | 'denied' | 'done' | 'error'
  /**
   * Live output streamed while the tool runs (currently shell commands).
   * Renderer-side only — accumulated from 'tool-output' stream events; main
   * never sets it and the final `result` supersedes it.
   */
  liveOutput?: string
}

export interface TokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  /** Prompt tokens served from the provider's prompt cache (cheaper rate). */
  cachedInputTokens?: number
  /** Prompt tokens written to the provider's prompt cache (Anthropic). */
  cacheCreationTokens?: number
}

/** One row of the local usage summary (Settings → Usage). Estimates only. */
export interface UsageSummaryEntry {
  providerId: string
  providerLabel: string
  providerType: ProviderType
  modelId: string
  /** Assistant messages that recorded usage for this provider+model. */
  messages: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** Estimated from the static local price list; null for unknown models. */
  estimatedCostUsd: number | null
}

/** Month-to-date estimated spend of one conversation, for the header HUD. */
export interface ConversationCostSummary {
  /** Priced spend only (messages + this conversation's headless runs). */
  estimatedCostUsd: number
  /** Usage rows that could not be priced (excluded from the estimate). */
  unpricedCount: number
  /** This conversation's monthly cap, or null. */
  budgetUsd: number | null
  /** The global monthly cap (AppSettings.monthlyBudgetUsd), or null. */
  globalBudgetUsd: number | null
  /** Start of the month the summary covers (local calendar month). */
  monthStartMs: number
}

/** One row of the Settings → Usage background-spend section (per run kind). */
export interface HeadlessUsageSummaryEntry {
  runKind: string
  runs: number
  promptTokens: number
  completionTokens: number
  /** Priced spend; null when every run in the group was unpriced. */
  estimatedCostUsd: number | null
  /** Runs with no price entry (excluded from the estimate). */
  unpricedRuns: number
}

export interface Message {
  id: string
  conversationId: string
  role: MessageRole
  content: string
  /** Reasoning/thinking text for models that emit it. */
  reasoning?: string
  attachments?: Attachment[]
  toolCalls?: ToolCallRecord[]
  status: MessageStatus
  error?: NormalizedError
  /** Provider/model actually used for this assistant message. */
  providerId?: string
  modelId?: string
  usage?: TokenUsage
  /**
   * Reliability Autopilot: the provider/model attempts that failed before the
   * attributed model answered. Persisted INSIDE the usage_json column (as an
   * extra `failedOverFrom` key) and split back out by the messages repository —
   * no schema migration.
   */
  failedOverFrom?: FailoverAttempt[]
  /**
   * Mixture-of-Agents: the advisor (reference) model outputs that fed the
   * aggregator which produced this assistant message. Present only when the
   * message was generated via a MoA preset.
   */
  moaReferences?: MoaReferenceOutput[]
  /**
   * Compare run ("Arena"): the `moaReferences` outputs are shown side by side
   * and ARE the result — no aggregator ran. `pickedIndex` is the advisor whose
   * text the user promoted into `content` (null until picked).
   */
  compare?: { pickedIndex: number | null }
  /**
   * Deep Research: plan + consulted sources of the research run that produced
   * this assistant message (the [n] markers in `content` cite these sources).
   * Present only when the message was generated via /research.
   */
  research?: ResearchRunInfo
  /**
   * Bot Mode (v46): the agent profile that authored this message. Set on a
   * group-room bot turn (attribution in a multi-bot transcript) and on
   * bot-authored messages in canonical chats. Null/absent = the conversation's
   * implicit speaker.
   */
  agentId?: string | null
  /**
   * Bot Mode (v48): this row is part of a bot-to-bot handoff — the
   * sender-side status marker (role 'system', invisible to the model), the
   * target's incoming turn, or the reply/failure row routed back to the
   * sender. Rendered as a handoff card instead of a plain message.
   */
  handoff?: MessageHandoff
  /** Monotonic order within the conversation. */
  seq: number
  createdAt: number
}

/** a2a_outbox.status (v48) — also the visible handoff status. */
export type A2aOutboxStatus = 'queued' | 'delivered' | 'replied' | 'failed' | 'cancelled'

/**
 * Handoff chrome on a message row (messages.handoff_json, v48). Names are
 * snapshotted at send time so the card still renders after a rename/delete.
 */
export interface MessageHandoff {
  outboxId: string
  /**
   * 'out' = the sender-side marker (system row, status follows the outbox row);
   * 'in' = the incoming turn in the target's chat; 'reply' = the reply or
   * failure row in the sender's chat.
   */
  direction: 'out' | 'in' | 'reply'
  /** Null = the app itself woke the bot (event/routine), not another bot. */
  fromAgentId: string | null
  toAgentId: string
  fromName: string
  toName: string
  status: A2aOutboxStatus
  /** Typed failure reason (provider_rate_limit, runtime_offline, …) when failed. */
  reason?: string | null
  updatedAt: number
}

/** One durable bot-to-bot delivery (a2a_outbox row, v48). */
export interface A2aOutboxEntry {
  id: string
  /** Sending bot; null = the app itself (an event wake). */
  fromAgentId: string | null
  toAgentId: string
  groupId: string | null
  /** The sender's canonical chat — where the reply routes back; null for app-originated wakes. */
  conversationId: string | null
  body: string
  status: A2aOutboxStatus
  /** Chain depth (the hop cap survives restarts). */
  hop: number
  /** Send attempts started (max 2: one transient retry or one post-restart redelivery). */
  attempts: number
  /** Set once the turn runs in the target chat — the boot-recovery join. */
  targetConversationId: string | null
  assistantMessageId: string | null
  /** The sender-side marker message, when one was written. */
  handoffMessageId: string | null
  error: string | null
  createdAt: number
  updatedAt: number
  deliveredAt: number | null
}

/**
 * How much reasoning/thinking the model should spend before answering.
 * Mapped per provider: OpenAI-compatible `reasoning_effort`, Anthropic
 * extended-thinking budgets, Gemini `thinkingConfig.thinkingBudget`.
 * Unset = provider default (no reasoning parameter sent).
 */
export type ReasoningEffort = 'low' | 'medium' | 'high'

/**
 * Sandbox posture for a Work conversation's tool loop:
 * - 'read-only': every mutating tool is refused — safe autonomous investigation.
 * - 'workspace-write' (the default when unset): writes through audited file
 *   tools are path-jailed to the granted folder; host shell is unavailable.
 * - 'full': additionally enables the unrestricted host shell. A cwd is not a
 *   confinement boundary; every shell call still requires approval.
 */
export type SandboxLevel = 'read-only' | 'workspace-write' | 'full'

// ---------------------------------------------------------------------------
// Terminal (user-driven Work-view terminal sessions; pipes-based, no pty)
// ---------------------------------------------------------------------------

/** A live (or replayed) terminal session bound to one Work conversation. */
export interface TerminalSessionInfo {
  sessionId: string
  conversationId: string
  /** The shell binary backing the session (cmd.exe / bash / $SHELL). */
  shell: string
  cwd: string
  /** Capped scrollback so a re-opened panel can replay history. */
  backlog: string
  alive: boolean
}

/** Push payload: one interleaved stdout/stderr chunk. */
export interface TerminalDataEvent {
  sessionId: string
  chunk: string
}

/** Push payload: the session's shell exited (code null = killed/failed). */
export interface TerminalExitEvent {
  sessionId: string
  code: number | null
}

// ---------------------------------------------------------------------------
// Voice (offline whisper.cpp speech-to-text; downloaded on demand)
// ---------------------------------------------------------------------------

/** The downloadable ggml whisper models the app knows about. */
export type VoiceModelId = 'tiny' | 'base'

/** Settings → Voice snapshot: what is installed and what is in flight. */
export interface VoiceStatus {
  /** False when no whisper.cpp release binary exists for this OS/arch (macOS). */
  platformDownloadSupported: boolean
  /** A runnable whisper binary is available (downloaded or user-picked). */
  binaryReady: boolean
  binarySource: 'downloaded' | 'custom' | null
  models: Array<{ id: VoiceModelId; sizeBytes: number; downloaded: boolean }>
  /** Which model transcription uses (settings.voiceModelId). */
  activeModelId: VoiceModelId
  downloading: boolean
}

/** Push payload for push:voiceDownloadProgress (throttled to ~4/s). */
export interface VoiceDownloadProgressEvent {
  item: 'binary' | 'model'
  modelId?: VoiceModelId
  receivedBytes: number
  /** Content-Length (or the pinned size), null when unknown. */
  totalBytes: number | null
  status: 'downloading' | 'verifying' | 'extracting' | 'done' | 'error'
  error?: string
}

/** Sampling parameters; all optional — provider defaults apply when unset. */
export interface ChatParams {
  temperature?: number
  maxTokens?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
  /** Work mode: read-only investigation + plan first (mutating tools blocked). */
  planMode?: boolean
  /**
   * Auto-accept file edits: edit_file/write_file run without the per-call
   * approval dialog (all other tools still ask). Off unless explicitly set.
   */
  autoAcceptEdits?: boolean
  /** Sandbox posture (work mode); unset = 'workspace-write'. */
  sandboxLevel?: SandboxLevel
  /** Reasoning/thinking effort; unset = provider default. */
  reasoningEffort?: ReasoningEffort
  /**
   * 'json' forces valid-JSON output where the provider supports it
   * (OpenAI-compatible response_format json_object; Gemini responseMimeType).
   * Providers without a JSON mode ignore it.
   */
  responseFormat?: 'json'
}

export interface Conversation {
  id: string
  mode: ConversationMode
  title: string
  /** Per-conversation override; null = use global default provider/model. */
  providerId: string | null
  modelId: string | null
  systemPrompt: string | null
  params: ChatParams
  /** Workspace holding the task's goal/plans/checklists (work mode). */
  workspaceId: string | null
  /**
   * Folder this task works in (work mode): a user-granted folder, or the
   * task's auto-created workspace folder once the assistant writes files.
   */
  projectId: string | null
  /**
   * Organizational Project (see the `Project` type / `projects` table) this
   * task belongs to, or null = unfiled. Available in every mode and always of
   * the same mode as the conversation. Distinct from `projectId`, which is the
   * working folder.
   */
  projectRef: string | null
  /**
   * Mixture-of-Agents preset (see `AppSettings.moaPresets`) this conversation
   * generates through, or null = ordinary single-model generation. When set,
   * the aggregator model of the preset acts as the assistant.
   */
  moaPresetId: string | null
  /** Knowledge base attached for retrieval (knowledge_search), or null. */
  knowledgeBaseId?: string | null
  /** Running summary of older messages (context compaction), or null. */
  summaryText?: string | null
  /** Highest message seq the summary covers; messages at/below it are pruned. */
  summaryThroughSeq?: number | null
  /**
   * Conversation this one was forked from (v41), or null. A plain pointer,
   * not an FK — the parent may since have been deleted.
   */
  parentConversationId?: string | null
  /** Id of the SOURCE message the fork was taken at (ids are regenerated in the fork). */
  forkedAtMessageId?: string | null
  /**
   * Monthly spend cap in USD (v44): generation pauses to ask once this
   * conversation's month-to-date estimate reaches it. Null/absent = no cap.
   */
  budgetUsd?: number | null
  /** Private space this conversation belongs to, or null = default space (v45). */
  spaceId?: string | null
  /**
   * Bot Mode (v46): the agent profile that owns this conversation — set only
   * on a bot's canonical chat. The bot's persona, memories, model pin and
   * toolset apply to every turn, and `message_agent` becomes available.
   * Bot-owned conversations are excluded from the regular sidebar listing.
   */
  agentId?: string | null
  createdAt: number
  updatedAt: number
}

export interface ConversationSummary {
  id: string
  mode: ConversationMode
  title: string
  updatedAt: number
  /** First ~100 chars of the latest message, for the sidebar. */
  snippet: string | null
  /** Organizational Project this task belongs to, or null = unfiled. */
  projectRef: string | null
  /** Private space membership (v45); null = default space. */
  spaceId?: string | null
}

// ---------------------------------------------------------------------------
// Private spaces + app lock (v45)
// ---------------------------------------------------------------------------

/**
 * A private space: a named partition of the conversation list. Conversations
 * in a private space are excluded from the default listing/search, backups
 * (unless explicitly included), the phone tunnel, the Telegram bridge and
 * notification previews. NOT encryption at rest — a privacy screen only.
 */
export interface Space {
  id: string
  name: string
  /** Provider ids generation in this space may use; null = all providers. */
  providerAllowlist: string[] | null
  createdAt: number
}

export interface SpacePatch {
  name?: string
  providerAllowlist?: string[] | null
}

/**
 * The stored scrypt verifier for the app-lock passphrase. Never the
 * passphrase itself; params live beside the hash so they can be raised later
 * without invalidating existing hashes.
 */
export interface AppLockHash {
  algo: 'scrypt'
  saltBase64: string
  hashBase64: string
  n: number
  r: number
  p: number
  keyLen: number
}

export interface AppLockStatus {
  /** A passphrase is set (the app locks on launch and on idle). */
  configured: boolean
  locked: boolean
  /** Minutes of system idle before auto-lock; null = never. */
  idleMinutes: number | null
}

export interface AppLockSetPassphraseInput {
  /** Required when a passphrase is already set. */
  current?: string
  /** The new passphrase, or null to remove the lock. */
  next: string | null
}

/**
 * A per-mode organizational Project: a lightweight folder that groups tasks
 * (conversations) within one mode. Chat and Work each have their own project
 * list. Orthogonal to workspaces and working folders — a project just
 * organizes the sidebar; it holds no working state of its own.
 */
export interface Project {
  id: string
  mode: ConversationMode
  name: string
  createdAt: number
  updatedAt: number
}

export interface ProjectInput {
  mode: ConversationMode
  name: string
}

export interface ProjectPatch {
  name?: string
}

// ---------------------------------------------------------------------------
// Mixture of Agents (MoA)
// ---------------------------------------------------------------------------

/** A provider+model pair referenced by a MoA preset (advisor or aggregator). */
export interface MoaModelRef {
  providerId: string
  modelId: string
}

/**
 * A Mixture-of-Agents preset: N advisor ("reference") models answer the request
 * in parallel, then a single aggregator model synthesizes their outputs into the
 * final answer (and drives any tool calls). Presets live in AppSettings; a
 * conversation opts in via `Conversation.moaPresetId`.
 */
export interface MoaPreset {
  id: string
  name: string
  /** Advisor models, run in parallel with no tools on the conversation text (≥1). */
  referenceModels: MoaModelRef[]
  /** The acting model: reads all advisor outputs and writes the assistant reply. */
  aggregator: MoaModelRef
  /** Caps advisor output; undefined = provider/conversation default. */
  referenceMaxTokens?: number
  referenceTemperature?: number
  aggregatorTemperature?: number
  /** Max output tokens for the aggregator; undefined = provider/conversation default. */
  maxTokens?: number
  enabled: boolean
}

/**
 * One advisor model's contribution to a MoA generation. Streamed to the renderer
 * as it runs and persisted on the produced assistant message so the labelled
 * blocks survive a reload. A failed advisor is recorded (status 'error') but
 * never aborts the aggregator.
 */
export interface MoaReferenceOutput {
  /** Stable position in the preset's referenceModels list. */
  index: number
  /** Human-readable "<provider label> · <modelId>". */
  label: string
  providerId: string
  modelId: string
  status: 'running' | 'done' | 'error'
  text: string
  error?: NormalizedError
  usage?: TokenUsage
}

// ---------------------------------------------------------------------------
// Deep Research
// ---------------------------------------------------------------------------

/** How much a research run may search/read (caps live in research.ts). */
export type ResearchDepth = 'quick' | 'standard' | 'deep'

/**
 * One source a research run consulted. Sources are collected in main from the
 * OBSERVED web_search/fetch_url tool calls (never from model output) and get
 * app-assigned 1-based citation ids the report's [n] markers refer to.
 */
export interface ResearchSource {
  /** 1-based citation number, assigned by the app after dedupe. */
  id: number
  url: string
  title: string
  /** Search-result snippet, when the source came from a search hit. */
  snippet?: string
  /** Set when the page body was actually fetched and read. */
  fetchedAt?: number
  status: 'fetched' | 'search-only' | 'error'
}

/**
 * Live progress record for a research run, streamed as 'research-activity'
 * events (upsert by id). Renderer-transient — accumulated on the streaming
 * message like ToolCallRecord.liveOutput; main never persists activities.
 */
export interface ResearchActivity {
  id: string
  phase: 'planning' | 'searching' | 'reading' | 'synthesizing'
  /** e.g. "Searching: best 2026 heat pumps" or "Reading: example.com". */
  label: string
  status: 'running' | 'done' | 'error'
  detail?: string
}

/** Persisted on the assistant message a deep-research run produced. */
export interface ResearchRunInfo {
  depth: ResearchDepth
  /** Sub-queries the planner decomposed the question into. */
  plan: string[]
  sources: ResearchSource[]
  /** Totals for the collapsed summary line. */
  searches: number
  pagesRead: number
  /** Summed planner+worker usage (synthesis usage is in message.usage). */
  workerUsage?: TokenUsage
  /**
   * Live activities while streaming. Renderer-side only — accumulated from
   * 'research-activity' events; main never sets or persists this field.
   */
  activities?: ResearchActivity[]
}

// ---------------------------------------------------------------------------
// Streaming (main -> renderer)
// ---------------------------------------------------------------------------

/** Events for one in-flight generation, delivered over the stream channel. */
export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; toolCall: ToolCallRecord }
  /** Incremental output from a running tool (shell commands stream stdout/err). */
  | { type: 'tool-output'; toolCallId: string; chunk: string }
  | { type: 'usage'; usage: TokenUsage }
  /** Mixture-of-Agents: an advisor model started/finished (upsert by index). */
  | { type: 'moa-reference'; reference: MoaReferenceOutput }
  /** Deep Research: a pipeline activity started/settled (upsert by id). */
  | { type: 'research-activity'; activity: ResearchActivity }
  /** A generated image was stored and attached to the assistant message. */
  | { type: 'attachment'; attachment: Attachment }
  /**
   * Reliability failover: the placeholder was reset and now re-runs on a
   * fallback model. Replace the message wholesale (clearing pushed partial
   * text); streaming state is unchanged — same streamId across attempts.
   */
  | { type: 'failover'; message: Message }
  | {
      type: 'done'
      finishReason: 'stop' | 'length' | 'tool_calls' | 'aborted' | 'error'
      /** Final persisted assistant message. */
      message: Message
    }
  | { type: 'error'; error: NormalizedError; message: Message }

export interface StreamEventEnvelope {
  streamId: string
  conversationId: string
  event: StreamEvent
}

/** Returned when a generation is started. */
export interface StartStreamResult {
  streamId: string
  userMessage: Message | null
  /** Placeholder assistant message (status 'streaming') already persisted. */
  assistantMessage: Message
}

/**
 * Message queue (v47, OpenClaw collect semantics): the conversation was busy,
 * so the user message was persisted and queued instead of starting a stream.
 * Queued messages coalesce into ONE follow-up turn (all of them are already
 * in the history) that starts ~500 ms after the current stream completes.
 */
export interface QueuedSendResult {
  queued: true
  userMessage: Message
}

export type ChatSendResult = StartStreamResult | QueuedSendResult

// ---------------------------------------------------------------------------
// Quick assistant (global-shortcut clipboard mini window)
// ---------------------------------------------------------------------------

/** The clipboard text captured when the quick window was summoned. */
export interface QuickContext {
  selectionText: string
  /** True when the capture was cut at QUICK_SELECTION_MAX_CHARS. */
  truncated: boolean
}

/**
 * Events of one ephemeral quick-assistant generation. The delta variants are
 * shape-identical to StreamEvent's so StreamDeltaBuffer coalesces them as-is;
 * nothing here is ever persisted.
 */
export type QuickStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'done'; finishReason: 'stop' | 'length' | 'aborted'; text: string; usage?: TokenUsage }
  | { type: 'error'; error: NormalizedError }

export interface QuickStreamEventEnvelope {
  streamId: string
  event: QuickStreamEvent
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ThemeSetting = 'system' | 'light' | 'dark'

/** A per-mode default provider/model for new conversations (null = global default). */
export interface ModeModelDefault {
  providerId: string | null
  modelId: string | null
}

/** Morning brief config (null in AppSettings = never configured / off). */
export interface MorningBriefSettings {
  enabled: boolean
  /** Local time of day, 'HH:mm'. */
  time: string
  /** Agent profile that writes the brief; null = economy/default model. */
  agentId: string | null
  deliverTelegram: boolean
  deliverNotification: boolean
}

/** One generated morning brief (stored in settings, newest first, max 7). */
export interface MorningBrief {
  id: string
  /** Local calendar day the brief covers, 'YYYY-MM-DD'. */
  dateKey: string
  generatedAt: number
  status: 'ok' | 'error'
  /** Markdown body ('' when status is 'error'). */
  content: string
  error: string | null
  /** Ran later than its slot (the app was closed at brief time). */
  catchUp: boolean
  dismissedAt: number | null
}

/**
 * One quick-assistant action (a button in the quick window). `{selection}` in
 * the prompt is replaced with the copied text; a prompt without the placeholder
 * gets the text appended after a blank line, so an edited action can never
 * silently drop it.
 */
export interface QuickAction {
  id: string
  label: string
  prompt: string
  /** Optional per-action model; unset = the default resolution chain. */
  providerId?: string
  modelId?: string
}

export const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'explain',
    label: 'Explain',
    prompt: 'Explain the following text clearly and concisely:\n\n{selection}',
  },
  {
    id: 'translate',
    label: 'Translate',
    prompt: 'Translate the following text to English:\n\n{selection}',
  },
  {
    id: 'rewrite',
    label: 'Rewrite',
    prompt:
      'Rewrite the following text to be clearer and more polished, keeping its meaning and tone:\n\n{selection}',
  },
  {
    id: 'summarize',
    label: 'Summarize',
    prompt: 'Summarize the following text in a few bullet points:\n\n{selection}',
  },
]

export interface AppSettings {
  theme: ThemeSetting
  /** Global default provider/model used by new conversations. */
  defaultProviderId: string | null
  defaultModelId: string | null
  /**
   * When true, a new conversation is stamped with the per-mode provider/model
   * from `modeModels` for its mode (modes left blank fall back to the global
   * default). When false, every mode uses the global default. Existing
   * conversations are unaffected; each can still override its model.
   */
  perModeModelsEnabled: boolean
  /** Per-mode default provider/model (a null providerId means "use default"). */
  modeModels: Record<ConversationMode, ModeModelDefault>
  /**
   * Mixture-of-Agents presets (advisor models + aggregator). Configured in
   * Settings → Mixture of Agents; a conversation opts in via its `moaPresetId`.
   */
  moaPresets: MoaPreset[]
  /** Preset used by the one-shot `/moa` command; null = no default configured. */
  defaultMoaPresetId: string | null
  defaultSystemPrompt: string
  defaultParams: ChatParams
  /** Local-first: everything below defaults to false/off. */
  telemetryEnabled: boolean
  /** Warn before sending file contents to a provider. */
  warnBeforeSendingFiles: boolean
  sendUsageWithMessages: boolean
  onboardingCompleted: boolean
  fontSize: 'small' | 'medium' | 'large'
  /** Auto-summarize long conversations to stay within the context window. */
  compactionEnabled: boolean
  /** Fraction of the model context length at which compaction triggers. */
  compactionThresholdRatio: number
  /**
   * Let the assistant remember durable facts across conversations (stored
   * locally, injected into the system prompt). On by default; toggleable in
   * Settings → Memory, where saved memories can be reviewed and deleted.
   */
  memoryEnabled: boolean
  /**
   * Dreaming: periodically consolidate saved memories with the default model
   * (merge duplicates, rewrite stale entries, drop obsolete ones). On by
   * default; only runs automatically while `memoryEnabled` is also on.
   */
  dreamingEnabled: boolean
  /**
   * Opt-in: expose run_shell_command when the conversation also uses the Full
   * sandbox level (still gated by per-call approval). Off by default — the app
   * otherwise only ever *suggests* shell commands.
   */
  shellExecutionEnabled: boolean
  /**
   * Command prefixes run_shell_command may run WITHOUT the per-call approval
   * dialog (e.g. "npm test", "git status"). A command matches when it equals a
   * prefix or continues it at a word boundary. Empty by default; only relevant
   * while shellExecutionEnabled is on.
   */
  shellCommandAllowlist: string[]
  /**
   * Opt-in: enable the `browser` and `computer` tools (an embedded, sandboxed
   * browser the assistant can drive). Off by default — they reach the internet
   * and act on pages, still gated by per-call approval.
   */
  browserToolsEnabled: boolean
  /** IM bridge: run a Telegram bot bound to a conversation (off by default). */
  telegramBridgeEnabled: boolean
  /** Conversation the Telegram bridge routes messages to. */
  telegramBridgeConversationId: string | null
  /**
   * The single Telegram chat id authorized to use the bridge. Null means "not
   * yet paired". Pairing is explicit: the app shows a one-time code
   * (telegramBridgePairingCode) that the first sender must echo before their
   * chat id is pinned here; every other sender is refused thereafter. Reset to
   * null when a new bot token is set. A discoverable bot username means an
   * unauthenticated stranger could otherwise win a trust-on-first-use race and
   * capture the bound conversation.
   */
  telegramBridgeAllowedChatId: number | null
  /**
   * One-time code the first Telegram sender must send to pair. Set when the
   * bridge is enabled with no pinned chat; cleared once a chat pairs. Shown in
   * the desktop UI only — never accepted from the renderer or a backup.
   */
  telegramBridgePairingCode: string | null
  /** Generic outbound webhook posted on each assistant completion (opt-in). */
  outboundWebhookUrl: string | null
  /**
   * Provider used for deep-research planning and web workers (often a cheaper
   * model). Null = the conversation's acting model does everything.
   */
  researchWorkerProviderId: string | null
  researchWorkerModelId: string | null
  /**
   * Economy model: a cheap model for internal plumbing generations —
   * context compaction, commit-message suggestions, memory consolidation
   * (dreaming). Null = those use the default model too.
   */
  economyProviderId: string | null
  economyModelId: string | null
  /** Depth used when /research or the composer toggle doesn't specify one. */
  researchDefaultDepth: ResearchDepth
  /**
   * Provider/model the generate_image tool uses. Null provider = auto-pick
   * the first enabled, keyed provider whose family can generate images.
   */
  defaultImageProviderId: string | null
  defaultImageModelId: string | null
  /** Automatically choose the cheapest configured default model when a task
   * has no explicit conversation/provider override. */
  autoRoutingEnabled: boolean
  autoRoutingPolicy: 'balanced' | 'lowest_cost' | 'highest_quality' | 'local_only'
  /** Optional soft budget displayed/enforced by future multi-round routing. */
  autoRoutingMaxCostUsd: number | null
  /**
   * Global soft cap on month-to-date estimated spend (priced models only, v44):
   * interactive sends ask once, headless runs are skipped. Null = off.
   */
  monthlyBudgetUsd: number | null
  /**
   * Reliability Autopilot: ordered fallback models tried when a generation
   * fails with a transient provider error or returns nothing before any tool
   * has run. Empty chains = failover off.
   */
  failoverChains: FailoverChains
  /** User-configurable lifecycle hooks. Commands remain disabled unless shell
   * execution is enabled and the exact command matches the allowlist. */
  projectHooks: ProjectHook[]
  /** Preferred editor command for the IDE bridge. */
  ideCommand: 'auto' | 'code' | 'cursor' | 'zed'
  /**
   * Home "Getting started"/Discover card: when the user hid it ("Hide tips"),
   * the unix-ms timestamp; null keeps the card visible.
   */
  gettingStartedDismissedAt: number | null
  /** Discover-card feature tips the user acknowledged ("Got it"). */
  dismissedTipIds: string[]
  /** Set once the command palette has been opened (Getting-started check). */
  paletteEverOpened: boolean
  /**
   * OS notifications when a background result lands or a tool call needs
   * approval. Only fire while the main window is unfocused — the app is not
   * going to notify you about something you are looking at. On by default;
   * the unread badge is independent of this toggle.
   */
  desktopNotificationsEnabled: boolean
  /**
   * Let a pending tool approval also be answered from the paired Telegram
   * chat, so a background/scheduled run can ask instead of failing while the
   * user is away. Off by default and security-sensitive: it moves an approval
   * decision onto a phone. Requires the Telegram bridge to be connected AND
   * paired; the pinned owner chat is the only one whose answer counts.
   */
  remoteApprovalsEnabled: boolean
  /**
   * Local trigger endpoint: a loopback-only HTTP listener that starts a
   * workflow on an outside event (a git hook, a CI job, a shell script). Off
   * by default. It binds 127.0.0.1 ONLY, requires the token below, and starts
   * nothing but the workflows that individually opted in (Workflow.webhookEnabled).
   */
  workflowWebhookEnabled: boolean
  /** Port for that listener. */
  workflowWebhookPort: number
  /**
   * Shared secret for the endpoint, generated when it is first switched on.
   * Local-only, but still a credential: never imported from a backup.
   */
  workflowWebhookToken: string | null
  /**
   * Opt-in remote access: let a paired phone use the full app through an
   * outbound tunnel to the relay below. Off by default. The desktop opens NO
   * inbound port — it connects out (like the Telegram bridge), so the feature
   * works behind CGNAT/firewalls and adds no listening network surface.
   */
  remoteAccessEnabled: boolean
  /**
   * Base URL of the relay that routes the phone tunnel (wss://… or ws:// for
   * local testing). Security-sensitive: a URL from an untrusted backup would
   * silently point the tunnel — and therefore the phone's traffic — at an
   * attacker's server. Never imported from a backup.
   */
  remoteRelayUrl: string | null
  /** Separately trusted HTTPS origin that serves the static phone client. */
  remoteClientUrl: string | null
  /**
   * Public routing id of this desktop on the relay (random, minted on first
   * enable). Not a secret: it only identifies WHICH desktop a phone connects
   * to; authentication is the relay/desktop token + per-device keys, which
   * live in encrypted storage and never travel in a backup.
   */
  remoteDesktopId: string | null
  /** Morning brief: a once-daily digest of overnight results. Null = off. */
  morningBrief: MorningBriefSettings | null
  /**
   * Last 7 briefs, newest first. Written ONLY by main (BriefService);
   * deliberately not part of the renderer patch surface — see
   * settingsPatchSchema.
   */
  morningBriefHistory: MorningBrief[]
  /**
   * Push-to-talk dictation (offline whisper.cpp). Also gates the microphone
   * permission grant in main — the mic is never available while this is off.
   */
  voiceInputEnabled: boolean
  /** Per-message read-aloud with the OS voice (speechSynthesis, offline). */
  voiceReadAloudEnabled: boolean
  /** Which downloaded ggml model transcription uses. */
  voiceModelId: VoiceModelId
  /**
   * Custom/manual whisper-cli path (macOS has no downloadable CLI binary).
   * Main-owned: set ONLY by the voice:pickBinary handler's native dialog —
   * never from a renderer patch or an imported backup, since it is an
   * executable main will spawn.
   */
  voiceWhisperBinaryPath: string | null
  /** Quick-assistant actions shown in the mini window (editable in Settings). */
  quickActions: QuickAction[]
  /**
   * Electron accelerator that summons the quick-assistant window. Empty string
   * disables it. Registration is try/catch — another app may own the combo.
   */
  quickAssistantShortcut: string
  /**
   * App-lock passphrase verifier (scrypt), or null = no lock. Main-owned:
   * deliberately absent from settingsPatchSchema (only lock:setPassphrase
   * writes it) and a member of SECURITY_SENSITIVE_SETTING_KEYS so it never
   * travels in a backup. Never the passphrase itself.
   */
  appLockHash: AppLockHash | null
  /** Minutes of system idle before auto-lock; null = never auto-lock. */
  appLockIdleMinutes: number | null
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  defaultProviderId: null,
  defaultModelId: null,
  perModeModelsEnabled: false,
  modeModels: {
    chat: { providerId: null, modelId: null },
    work: { providerId: null, modelId: null },
  },
  moaPresets: [],
  defaultMoaPresetId: null,
  defaultSystemPrompt: '',
  defaultParams: {},
  telemetryEnabled: false,
  warnBeforeSendingFiles: true,
  sendUsageWithMessages: true,
  onboardingCompleted: false,
  fontSize: 'medium',
  compactionEnabled: false,
  compactionThresholdRatio: 0.75,
  memoryEnabled: true,
  dreamingEnabled: true,
  shellExecutionEnabled: false,
  shellCommandAllowlist: [],
  browserToolsEnabled: false,
  telegramBridgeEnabled: false,
  telegramBridgeConversationId: null,
  telegramBridgeAllowedChatId: null,
  telegramBridgePairingCode: null,
  outboundWebhookUrl: null,
  researchWorkerProviderId: null,
  researchWorkerModelId: null,
  economyProviderId: null,
  economyModelId: null,
  researchDefaultDepth: 'standard',
  defaultImageProviderId: null,
  defaultImageModelId: null,
  autoRoutingEnabled: false,
  autoRoutingPolicy: 'balanced',
  autoRoutingMaxCostUsd: null,
  monthlyBudgetUsd: null,
  failoverChains: {},
  projectHooks: [],
  ideCommand: 'auto',
  gettingStartedDismissedAt: null,
  dismissedTipIds: [],
  paletteEverOpened: false,
  desktopNotificationsEnabled: true,
  remoteApprovalsEnabled: false,
  workflowWebhookEnabled: false,
  workflowWebhookPort: 8787,
  workflowWebhookToken: null,
  remoteAccessEnabled: false,
  remoteRelayUrl: null,
  remoteClientUrl: null,
  remoteDesktopId: null,
  morningBrief: null,
  morningBriefHistory: [],
  voiceInputEnabled: false,
  voiceReadAloudEnabled: false,
  voiceModelId: 'base',
  voiceWhisperBinaryPath: null,
  quickActions: DEFAULT_QUICK_ACTIONS,
  quickAssistantShortcut: 'CommandOrControl+Shift+Space',
  appLockHash: null,
  appLockIdleMinutes: null,
}

/**
 * Settings that are NEVER applied from an imported backup: enabling them from
 * an untrusted file would silently grant shell/browser execution, wire up an
 * exfiltration webhook, or pre-authorize a Telegram sender — all behind a
 * single "Import" click. They stay whatever the local machine already has.
 * Kept next to AppSettings/DEFAULT_SETTINGS so adding a dangerous key and
 * classifying it happen in the same edit.
 */
export const SECURITY_SENSITIVE_SETTING_KEYS: ReadonlySet<string> = new Set([
  'shellExecutionEnabled',
  'shellCommandAllowlist',
  'browserToolsEnabled',
  'outboundWebhookUrl',
  'telegramBridgeEnabled',
  'telegramBridgeConversationId',
  'telegramBridgeAllowedChatId',
  'telegramBridgePairingCode',
  'projectHooks',
  // Importing this would move approval authority to whatever chat the backup's
  // bridge settings point at.
  'remoteApprovalsEnabled',
  // …and these would open a local port and hand over its key.
  'workflowWebhookEnabled',
  'workflowWebhookPort',
  'workflowWebhookToken',
  // …and these would re-enable the phone tunnel and point it at whatever
  // relay the backup names — the desktop would then connect OUT to a server
  // the backup's author controls.
  'remoteAccessEnabled',
  'remoteRelayUrl',
  'remoteClientUrl',
  // An imported backup could otherwise point main at an arbitrary executable
  // that transcription would then spawn.
  'voiceWhisperBinaryPath',
  // Importing this would silently swap the app-lock passphrase for whatever
  // the backup's author chose.
  'appLockHash',
] satisfies readonly (keyof AppSettings)[])

// ---------------------------------------------------------------------------
// Agent control plane, checkpoints, hooks and IDE bridge
// ---------------------------------------------------------------------------

export interface AgentRun {
  id: string
  conversationId: string | null
  projectId: string | null
  agentName: string | null
  task: string
  status: 'running' | 'done' | 'error' | 'stopped'
  result: string
  worktreePath: string | null
  providerId: string | null
  modelId: string | null
  startedAt: number
  finishedAt: number | null
}

// ---------------------------------------------------------------------------
// Code Arena (same task, N models, isolated worktrees, side-by-side diffs)
// ---------------------------------------------------------------------------

export interface ArenaCandidateState {
  /** The persisted agent_runs row backing this candidate. */
  runId: string
  providerId: string
  modelId: string
  providerLabel: string
  worktreePath: string
  branch: string
  status: 'running' | 'done' | 'error' | 'stopped'
  /** The model's closing summary (or the error), capped. */
  summary: string
  /** `git diff --stat` of the candidate's worktree, captured on finish. */
  diffStat: string
  /** Full unified diff (capped) for side-by-side review. */
  diff: string
  /** Files the candidate changed (staged in its worktree). */
  changedFiles: GitFileChange[]
  /** Round this candidate ran in (1-based). Always 1 when totalRounds is 1. */
  round: number
  /** The runId whose worktree this candidate's copy was seeded from (round > 1). */
  parentRunId: string | null
}

export interface ArenaState {
  id: string
  conversationId: string
  /** The REAL project the winner is applied to. */
  projectId: string
  task: string
  status: 'running' | 'finished' | 'applied' | 'discarded'
  candidates: ArenaCandidateState[]
  appliedRunId: string | null
  createdAt: number
  /** Evolutionary arenas run more than one judged round (default 1). */
  totalRounds: number
  /** Current/last completed round (1-based). */
  round: number
  /** The judged winner of the last completed round (rounds > 1 only). */
  winnerRunId: string | null
}

export interface ArenaStartRequest {
  conversationId: string
  task: string
  /** 2–4 models to race on identical worktree copies of the repo. */
  candidates: MoaModelRef[]
  /**
   * Evolutionary rounds: after each round an LLM judge picks a winning diff,
   * and every candidate of the next round starts from the winner's tree to
   * improve on it. Default 1 (single round, no judging).
   */
  rounds?: number
}

// ---------------------------------------------------------------------------
// Optimizer (autonomous benchmark-improve-commit loop per project)
// ---------------------------------------------------------------------------

export interface OptimizerRun {
  id: string
  projectId: string
  goal: string
  /** Command whose exit code gates correctness and whose output is scored. */
  evalCommand: string
  /** Optional second gate that must pass for a version to be accepted. */
  testCommand: string | null
  providerId: string | null
  modelId: string | null
  maxRounds: number
  /** Whether a higher score wins ('maximize', e.g. ops/sec) or a lower one ('minimize', e.g. runtime). */
  direction: 'maximize' | 'minimize'
  status: 'running' | 'stopped' | 'done' | 'failed'
  roundsDone: number
  bestScore: number | null
  bestVersion: number | null
  lastError: string | null
  /** App-owned isolated checkout used by this run (kept on publish conflict). */
  worktreePath: string | null
  worktreeBranch: string | null
  baseBranch: string | null
  baseSha: string | null
  createdAt: number
  updatedAt: number
}

/** One evaluated attempt within an optimizer run (accepted = became a commit). */
export interface OptimizerVersion {
  runId: string
  seq: number
  score: number | null
  accepted: boolean
  summary: string
  commitSha: string | null
  createdAt: number
}

export interface OptimizerStartInput {
  projectId: string
  goal: string
  evalCommand: string
  testCommand?: string
  providerId?: string | null
  modelId?: string | null
  maxRounds?: number
  /** Higher score wins by default; set 'minimize' when a lower score is better (runtime, memory). */
  direction?: 'maximize' | 'minimize'
  /** Let the optimization agent run shell commands itself (eval runs regardless). */
  allowShell?: boolean
}

/** One recorded experiment outcome, injected into future sessions (#AVO lineage memory). */
export interface ExperimentEntry {
  id: string
  projectId: string
  title: string
  outcome: 'improved' | 'failed' | 'neutral'
  detail: string
  source: string
  createdAt: number
}

// ---------------------------------------------------------------------------
// Agent inbox (unified review queue for background results)
// ---------------------------------------------------------------------------

export type InboxItemType = 'agent_run' | 'workflow_run' | 'scheduled_task_run'

/** One reviewable background result in the Home inbox. */
export interface InboxItem {
  itemType: InboxItemType
  /** Stable id within its type (scheduled tasks: `taskId:lastRunAt`). */
  itemId: string
  /** What produced it: the agent name, workflow name or task title. */
  sourceLabel: string
  /** The task/prompt/output headline shown as the row title. */
  title: string
  status: 'ok' | 'error' | 'stopped'
  /** Capped result/output/error preview. */
  snippet: string
  /** Open target when the item belongs to a conversation. */
  conversationId: string | null
  /** Open target when the item is a workflow run. */
  workflowId: string | null
  finishedAt: number
  /** Set when the user marked it reviewed (from inbox_state). */
  reviewedAt: number | null
}

export interface CheckpointFile {
  relPath: string
  /** null means the file did not exist at checkpoint time. */
  content: string | null
}

export interface Checkpoint {
  id: string
  conversationId: string
  projectId: string
  changeId: string | null
  label: string
  messageSeq: number
  files: CheckpointFile[]
  createdAt: number
}

export type ProjectHookEvent = 'afterAgent' | 'afterApply' | 'beforeCommit'
export interface ProjectHook {
  id: string
  name: string
  event: ProjectHookEvent
  command: string
  enabled: boolean
}

export interface WorktreeInfo {
  path: string
  branch: string
  projectId: string
}

// ---------------------------------------------------------------------------
// Workspaces (Work-mode goal/plans/checklists — the Tasks panel)
// ---------------------------------------------------------------------------

export interface Workspace {
  id: string
  name: string
  goal: string | null
  status: 'active' | 'done' | 'archived'
  createdAt: number
  updatedAt: number
}

export type WorkspaceItemKind = 'note' | 'plan' | 'checklist' | 'doc' | 'task'

export interface WorkspaceItem {
  id: string
  workspaceId: string
  kind: WorkspaceItemKind
  title: string
  /** Markdown body; for checklists use "- [ ] item" lines. */
  content: string
  /** For kind 'task'. */
  status: 'todo' | 'doing' | 'done' | null
  sort: number
  /** Who created it — keeps user instructions separate from assistant suggestions. */
  origin: 'user' | 'assistant'
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Working folders (Work mode: granted folders + auto task workspaces)
// ---------------------------------------------------------------------------

export interface CodeProject {
  id: string
  /**
   * Absolute path: granted explicitly by the user via folder picker, or the
   * app-owned workspace folder auto-created for a Work task's files.
   */
  path: string
  name: string
  approvedAt: number
  lastOpenedAt: number | null
  /**
   * True when the path is the app's own per-task workspace folder (derived in
   * main from the path prefix; never persisted). Auto rows are hidden from
   * folder pickers and deleted with their conversation.
   */
  autoCreated?: boolean
}

export interface FileTreeNode {
  name: string
  /** Path relative to the project root. */
  relPath: string
  type: 'file' | 'dir'
  children?: FileTreeNode[]
  sizeBytes?: number
}

export type CodeChangeType = 'create' | 'edit' | 'delete'
export type CodeChangeStatus = 'proposed' | 'applied' | 'rejected' | 'reverted'

/** One path in `git status` (status = the porcelain letter, e.g. M/A/D/R). */
export interface GitFileChange {
  path: string
  status: string
  /** Original path for a porcelain rename/copy record. */
  oldPath?: string
}

/** Working-tree status for the Code-mode commit bar. */
export interface GitStatus {
  isRepo: boolean
  /** Current branch, or null when detached / unborn / not a repo. */
  branch: string | null
  /** origin/HEAD or main/master heuristic; null for bare local repos. */
  defaultBranch: string | null
  detached: boolean
  /** Commits ahead/behind the upstream (0 when no upstream). */
  ahead: number
  behind: number
  /** Whether a remote named origin exists (the URL itself may contain secrets and never crosses IPC). */
  hasOrigin: boolean
  /** Tracking branch such as origin/feature; null until the branch has been pushed. */
  upstream: string | null
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: string[]
}

export interface GitHubPrInput {
  title: string
  body?: string
  base?: string
  draft?: boolean
}

export interface GitHubPrResult {
  url: string
}

/** Input for git_write action 'pr_review' (posts a PR review via gh). */
export interface GitHubPrReviewInput {
  /** PR number; omitted = the current branch's pull request. */
  number?: number
  event: 'comment' | 'approve' | 'request_changes'
  /** Review text; required for comment/request_changes. */
  body?: string
}

export interface CodeChange {
  id: string
  projectId: string
  conversationId: string | null
  /** Relative to project root. */
  filePath: string
  changeType: CodeChangeType
  /** Unified diff for display. */
  diff: string
  /** Full new file content (used when applying create/edit). */
  newContent: string | null
  /**
   * The file's content captured at proposal time ('' for create), used as a
   * staleness baseline when applying. Null when it could not be captured
   * (binary/oversized/unreadable) or for rows created before this was added.
   */
  oldContent?: string | null
  status: CodeChangeStatus
  createdAt: number
  appliedAt: number | null
}

// ---------------------------------------------------------------------------
// Tools (MCP-style local registry)
// ---------------------------------------------------------------------------

export type ToolRiskLevel = 'safe' | 'sensitive' | 'dangerous'

/** Where a tool comes from — used for grouping in the Tools settings UI. */
export type ToolSource = 'builtin' | 'custom' | 'mcp'

export interface ToolDefinition {
  id: string
  name: string
  description: string
  /** JSON Schema for the arguments (OpenAI tool format). */
  parameters: Record<string, unknown>
  risk: ToolRiskLevel
  /** Built-in tools ship with the app; custom ones are user-defined HTTP tools. */
  builtin: boolean
  enabled: boolean
  /** Origin of the tool. Absent implies 'builtin' for older payloads. */
  source?: ToolSource
  /**
   * May mutate the project/machine/web — refused in plan mode ("read-only
   * investigation only"). Absent means read-only. Declared where the tool is
   * defined: builtins in definitions.ts, custom HTTP tools derived from their
   * method (GET = read-only by convention), MCP tools always true (their side
   * effects can't be inspected, so they're treated conservatively as mutating).
   */
  mutating?: boolean
  /**
   * EVERY call needs a fresh approval click: excluded from "allow for this
   * conversation" grants and from auto-accept-edits. For tools whose calls
   * are individually consequential (git_write commits).
   */
  noStandingApproval?: boolean
}

// ---------------------------------------------------------------------------
// Custom HTTP tools (user-defined; Settings → Tools)
// ---------------------------------------------------------------------------

/** What the Settings UI submits when adding a custom HTTP tool. */
export interface CustomToolInput {
  name: string
  description?: string
  baseUrl: string
  /** HTTP method; defaults to 'GET'. */
  method?: string
  /** Non-secret request headers, stored in plaintext and visible in the UI. */
  headers?: Record<string, string>
  /**
   * Secret headers to (over)write, name -> value. Values travel to main once,
   * are encrypted immediately (safeStorage) and are never returned to the
   * renderer — only the header names + a masked preview come back.
   */
  setSecretHeaders?: Record<string, string>
  /** JSON Schema for the arguments; defaults to an empty object schema. */
  paramsSchema?: Record<string, unknown>
}

/** Partial edit of a custom HTTP tool. */
export interface CustomToolPatch {
  name?: string
  description?: string
  baseUrl?: string
  method?: string
  headers?: Record<string, string>
  setSecretHeaders?: Record<string, string>
  /** Names of secret headers to remove. */
  deleteSecretHeaders?: string[]
  paramsSchema?: Record<string, unknown>
}

/** A masked secret reference (name + preview, never the value). */
export interface SecretRef {
  name: string
  preview: string
}

/** Full custom-tool details for the edit form (values never included). */
export interface CustomToolInfo {
  /** ToolDefinition id, 'custom:<uuid>'. */
  id: string
  name: string
  description: string
  baseUrl: string
  method: string
  /** Non-secret headers (plaintext). */
  headers: Record<string, string>
  /** Names + previews of secret headers; values are never returned. */
  secretHeaders: SecretRef[]
  paramsSchema: Record<string, unknown>
  enabled: boolean
}

export type ToolPermissionDecision = 'always_allow' | 'ask' | 'deny'

export interface ToolPermission {
  toolId: string
  decision: ToolPermissionDecision
  updatedAt: number
}

/** A pending tool invocation awaiting user approval in the renderer. */
export interface ToolApprovalRequest {
  requestId: string
  streamId: string
  conversationId: string
  toolCall: ToolCallRecord
  risk: ToolRiskLevel
  /**
   * Main-computed context line the dialog shows prominently, e.g.
   * "Commits 3 staged files on branch 'main' — the DEFAULT branch". Never
   * model text.
   */
  note?: string
}

/**
 * How far an approval reaches. 'once' approves this single call; the wider
 * scopes persist a matching ToolRule (see below), so they survive a restart:
 * 'conversation' auto-approves the tool's future calls in the same
 * conversation, 'always' anywhere. Tools marked noStandingApproval only ever
 * accept 'once'.
 */
export type ToolApprovalScope = 'once' | 'conversation' | 'always'

/**
 * A standing approval rule (migration v31, table `tool_rules`) — the
 * persistent form of "always allow"/"always ask".
 *
 * Precedence is deliberate and non-negotiable: a matching 'require_approval'
 * rule ALWAYS wins, over another rule, over a standing grant, and over an
 * 'always_allow' tool permission. An 'allow' rule only ever removes a dialog,
 * never adds capability — 'deny', plan mode, the read-only sandbox and
 * noStandingApproval tools all still refuse first.
 */
export type ToolRuleEffect = 'allow' | 'require_approval'

/** Where a rule applies. 'conversation'/'project' need a matching scopeId. */
export type ToolRuleScope = 'global' | 'conversation' | 'project'

export interface ToolRule {
  id: string
  /** Tool definition id ('run_shell_command', 'custom:<uuid>', 'mcp__…'). */
  toolId: string
  effect: ToolRuleEffect
  scope: ToolRuleScope
  /** Conversation/project id for the scoped kinds; null when global. */
  scopeId: string | null
  /**
   * Optional narrowing of WHICH calls the rule covers, matched against the
   * call's subject: the command for run_shell_command, the URL host for
   * fetch_url/browser, the relative path for the file tools. Null = every
   * call of the tool. A pattern on a tool with no subject is fail-safe: it
   * never grants, and always stops.
   */
  pattern: string | null
  createdAt: number
}

export interface ToolRuleInput {
  toolId: string
  effect: ToolRuleEffect
  scope: ToolRuleScope
  scopeId?: string | null
  pattern?: string | null
}

/**
 * How a tool call got past the approval gate — the activity log's "why".
 * - 'auto': the tool's stored permission is always-allow and no rule objected.
 * - 'rule': a standing approval rule covered it (an earlier "always allow").
 * - 'approved': a human said yes to this specific call, here or on a phone.
 * - 'declined': a human said no, or a headless run had nobody to ask.
 * - 'blocked': policy refused before anyone was asked (deny, plan mode, the
 *   read-only sandbox, a disabled tool).
 */
export type ActivityDecision = 'auto' | 'rule' | 'approved' | 'declined' | 'blocked'

/**
 * One tool call, as recorded for review (migration v34). This is the answer to
 * "what did it actually do while I was away, and who let it?" — every field is
 * observed by the executor rather than reported by the model, and the argument
 * and result text is redacted and capped before it is stored.
 */
export interface ActivityEntry {
  id: string
  at: number
  /** Conversation the call belonged to; null for a headless run. */
  conversationId: string | null
  /** Agent profile acting, when the call came from one. */
  agentName: string | null
  toolId: string
  toolName: string
  risk: ToolRiskLevel
  decision: ActivityDecision
  /** Short human reason: 'always allow', 'rule', 'plan mode', 'no channel'. */
  detail: string
  /** Redacted, capped call arguments. */
  arguments: string
  /** Redacted, capped result. */
  result: string
  /** code_changes row this call proposed, so the entry can link to its diff. */
  changeId: string | null
}

/**
 * Where a page of the log stopped. Both halves travel together: entries are
 * ordered by timestamp then by insertion order, and two tool calls routinely
 * land in the same millisecond, so a cursor on the clock alone would skip
 * every entry sharing the boundary one — from this page and every later one.
 */
export interface ActivityCursor {
  at: number
  /** The entry's insertion order within its millisecond; higher is newer. */
  seq: number
}

export interface ActivityQuery {
  /** Newest first; defaults to a page of 100. */
  limit?: number
  /** Only entries older than this cursor (the previous page's "load older"). */
  before?: ActivityCursor
  /** Restrict to one decision, e.g. only what a human approved. */
  decision?: ActivityDecision
  /** Free-text over tool name, detail, arguments and result. */
  search?: string
}

/** The renderer's answer to a ToolApprovalRequest. */
export interface ToolApprovalAnswer {
  approved: boolean
  /** Meaningful only when approved; defaults to 'once'. */
  scope: ToolApprovalScope
}

/** A structured clarifying question from the assistant (ask_user_question). */
export interface UserQuestionRequest {
  requestId: string
  streamId: string
  conversationId: string
  question: string
  /** Suggested answers; the user can always type a custom one instead. */
  options: string[]
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) servers
// ---------------------------------------------------------------------------

export type McpTransport = 'stdio' | 'http'
export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/** A configured MCP server (secret values are never included). */
export interface McpServerConfig {
  id: string
  /** Short slug used in the tool namespace 'mcp__<key>__<tool>'. */
  key: string
  name: string
  transport: McpTransport
  /** stdio: command + args + env. */
  command: string | null
  args: string[]
  env: Record<string, string>
  /** http: url + headers. */
  url: string | null
  headers: Record<string, string>
  enabled: boolean
  /** Names of secret env vars / headers (values never returned). */
  secretNames: string[]
  createdAt: number
  updatedAt: number
}

export interface McpServerInput {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /** Secret env/headers to store encrypted (name -> value), never returned. */
  setSecrets?: Record<string, string>
  enabled?: boolean
}

export interface McpServerPatch {
  name?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  setSecrets?: Record<string, string>
  deleteSecrets?: string[]
  enabled?: boolean
}

/** A tool discovered from a connected MCP server. */
export interface McpDiscoveredTool {
  /** ToolDefinition id, 'mcp__<key>__<tool>'. */
  toolId: string
  /** The tool's original (un-namespaced) name. */
  name: string
  description: string
}

/** Live connection state for one server (for the Settings UI). */
export interface McpServerRuntime {
  id: string
  status: McpConnectionStatus
  error: string | null
  toolCount: number
  tools: McpDiscoveredTool[]
}

// ---------------------------------------------------------------------------
// Knowledge bases (RAG)
// ---------------------------------------------------------------------------

/** A knowledge base: embedded text chunks searched by the knowledge_search tool. */
export interface KnowledgeBase {
  id: string
  name: string
  /** Provider whose /embeddings endpoint embeds the chunks and queries. */
  providerId: string
  /** Embedding model id (e.g. text-embedding-3-small, nomic-embed-text). */
  modelId: string
  /** Number of stored chunks (filled in by list/get). */
  chunkCount: number
  createdAt: number
  updatedAt: number
}

export interface KnowledgeBaseInput {
  name: string
  providerId: string
  modelId: string
}

/** One retrieval hit. */
export interface KnowledgeSearchHit {
  source: string
  content: string
  /** Cosine similarity in [-1, 1]. */
  score: number
}

// ---------------------------------------------------------------------------
// Agent profiles (user-defined sub-agents)
// ---------------------------------------------------------------------------

/**
 * A user-defined agent: its own persona, an optional dedicated (often cheaper)
 * model, and an optional restricted toolset. Runnable as a `delegate` target
 * (`delegate(agent="research")`) and as the acting agent of a workflow
 * ai_agent node.
 */
export interface AgentProfile {
  id: string
  /** Unique (case-insensitive) — how the model addresses the agent. */
  name: string
  description: string
  systemPrompt: string
  /** null = the parent conversation's / default provider. */
  providerId: string | null
  modelId: string | null
  /** Tool ids the agent may call; null = the delegate default set. */
  toolIds: string[] | null
  /** Max reasoning/tool rounds; null = the delegate default. */
  maxRounds: number | null
  enabled: boolean
  /** Bot Mode (v46): the bot's role designation ("Researcher", "Editor"). */
  title: string
  /** Bot Mode (v46): visual identity in the roster; null = initials + hashed color. */
  avatar: BotAvatar | null
  /**
   * Bot Mode (v46): hidden from the roster. Display-only — @mentions still
   * resolve, group memberships stay, routines keep running (Hermes semantics).
   */
  hidden: boolean
  /**
   * Bot Mode (v46): the bot's canonical chat (a `conversations` row with
   * agent_id = this profile), created lazily on first open. Null until then.
   */
  chatConversationId: string | null
  /**
   * Bot gateway (v47): periodic "anything need attention?" turn in the
   * canonical chat with a NO_REPLY quiet contract (OpenClaw heartbeat).
   * Null = no heartbeat.
   */
  heartbeat: BotHeartbeat | null
  /**
   * Bot gateway (v47): auto-compact policy for the canonical chat — daily at
   * an hour and/or after idle minutes; whichever expires first wins. Always
   * compaction, never deletion. Null = no automatic reset.
   */
  reset: BotResetPolicy | null
  /**
   * Bot gateway (v47): agent ids this bot may message via message_agent.
   * Null = every enabled bot (the open default); [] = messaging disabled.
   */
  messageAllow: string[] | null
  createdAt: number
  updatedAt: number
}

/** Bot roster avatar: an emoji and/or an accent color (hex). */
export interface BotAvatar {
  emoji?: string | null
  color?: string | null
}

/** Bot heartbeat config (v47). */
export interface BotHeartbeat {
  /** Cadence in minutes (min 15 enforced at the boundary). */
  everyMinutes: number
  /** 'chat' = surfaced turn stays in the chat; 'notify' additionally raises an OS notification. */
  deliver: 'chat' | 'notify'
  /** Extra standing instruction appended to the heartbeat prompt. */
  prompt?: string | null
}

/** Bot canonical-chat auto-compact policy (v47). */
export interface BotResetPolicy {
  /** Compact once daily at this local hour (0–23). */
  dailyHour?: number | null
  /** Compact after this many minutes without a new message. */
  idleMinutes?: number | null
}

export interface AgentProfileInput {
  name: string
  description?: string
  systemPrompt: string
  providerId?: string | null
  modelId?: string | null
  toolIds?: string[] | null
  maxRounds?: number | null
  enabled?: boolean
  title?: string
  avatar?: BotAvatar | null
  hidden?: boolean
  heartbeat?: BotHeartbeat | null
  reset?: BotResetPolicy | null
  messageAllow?: string[] | null
}

export type AgentProfilePatch = Partial<AgentProfileInput>

// ---------------------------------------------------------------------------
// Bot Mode (v46) — roster, bot-to-bot messaging, group rooms
// ---------------------------------------------------------------------------

/**
 * A group room: 2–6 bots deliberating in one shared conversation
 * (`conversationId` holds the transcript; member turns are assistant messages
 * attributed via `messages.agent_id`). Mirrors Hermes group chats: up to three
 * serial reply-or-pass rounds per user message, capped at 10 bot messages.
 */
export interface BotGroup {
  id: string
  name: string
  conversationId: string
  /** A member escalated with @user and the user hasn't opened the room since. */
  needsUser: boolean
  memberIds: string[]
  /**
   * Room activation (v47, OpenClaw grammar): 'always' = every user message
   * triggers open reply-or-pass rounds; 'mention' = only @named bots take one
   * turn, no open rounds.
   */
  activation: BotGroupActivation
  /**
   * Observer members (v47): read the room but speak only when @mentioned —
   * a note-taker or auditor bot. Subset of memberIds.
   */
  observerIds: string[]
  createdAt: number
  updatedAt: number
}

export type BotGroupActivation = 'always' | 'mention'

/**
 * External chat presence for one bot (v47): its own Telegram bot, paired to
 * the owner's DM (trust-on-first-use) and optionally admitted to groups via
 * owner-only in-chat commands. The bot token lives encrypted in tool_secrets
 * and never crosses IPC outward — `hasToken` is all the renderer sees.
 */
export interface BotBinding {
  agentId: string
  channel: 'telegram'
  enabled: boolean
  hasToken: boolean
  /** The paired DM chat id, or null while unpaired. */
  paired: boolean
  /** One-time pairing code to send the bot on Telegram (while unpaired). */
  pairingCode: string | null
  groups: BotBindingGroup[]
  /** Live bridge state, from the channel pool. */
  status: 'stopped' | 'running' | 'error'
  statusDetail: string | null
}

export interface BotBindingGroup {
  id: string
  title: string
  /** 'mention' (default) = speak only when @mentioned or replied to; 'always' = every message. */
  activation: BotGroupActivation
}

/** One roster row of the Bots pane: a bot plus its canonical-chat activity. */
export interface BotRosterItem {
  agent: AgentProfile
  /** Canonical chat id, or null when the chat hasn't been opened yet. */
  conversationId: string | null
  lastMessageAt: number | null
  snippet: string | null
  /** Generating right now, or wrote within the last 90 s (active-now strip). */
  active: boolean
  /** Bot-to-bot deliveries waiting for this bot (a2a_outbox, v48). */
  queuedCount: number
  /** A bot-to-bot delivery is being answered in this bot's chat right now. */
  inFlight: boolean
}

/** One group-room row of the Bots pane roster. */
export interface BotGroupRosterItem {
  group: BotGroup
  lastMessageAt: number | null
  snippet: string | null
  /** A round is currently running in this room. */
  active: boolean
}

export interface BotRoster {
  bots: BotRosterItem[]
  groups: BotGroupRosterItem[]
}

// ---------------------------------------------------------------------------
// Workflows (visual node graph)
// ---------------------------------------------------------------------------

export type WorkflowNodeKind =
  | 'manual'
  | 'ai_agent'
  | 'http_request'
  | 'template'
  | 'condition'
  | 'notify'
  | 'output'

export interface WorkflowNode {
  id: string
  kind: WorkflowNodeKind
  label: string
  position: { x: number; y: number }
  /** Kind-specific configuration (prompt, url, template, …). */
  config: Record<string, unknown>
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
  /**
   * Branch handle on the source node. Condition nodes emit on 'true'/'false';
   * an edge without a handle counts as the 'true' branch. Other node kinds
   * ignore it.
   */
  sourceHandle?: string | null
}

export interface WorkflowGraph {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

/**
 * Recurring trigger for a workflow. 'interval' is the original "every N
 * minutes"; 'calendar' is wall-clock ("08:00 on weekdays"), which is what
 * people actually mean by a morning digest. Rows written before v33 carry the
 * bare `{everyMinutes}` shape and are read back as 'interval'.
 */
export type WorkflowSchedule = WorkflowIntervalSchedule | WorkflowCalendarSchedule

export interface WorkflowIntervalSchedule {
  kind: 'interval'
  everyMinutes: number
}

export interface WorkflowCalendarSchedule {
  kind: 'calendar'
  /**
   * Local weekdays it may run on, 0 = Sunday … 6 = Saturday. Empty means every
   * day. Local, not UTC: "08:00 on weekdays" has to survive a DST change.
   */
  days: number[]
  /** Local wall-clock time, "HH:MM" (24-hour). */
  time: string
}

/**
 * Folder-watch trigger config (v42). `folderPath` always comes from the OS
 * folder picker — a user grant, never free text. Empty `glob` matches every
 * file; the enabled flag lives inside the config (no separate column).
 */
export interface WorkflowWatchConfig {
  enabled: boolean
  folderPath: string
  glob: string
  event: 'created' | 'changed'
  debounceMs?: number
}

export interface Workflow {
  id: string
  name: string
  graph: WorkflowGraph
  /** Recurring trigger; null = manual only. */
  schedule: WorkflowSchedule | null
  /** The schedule fires only while this is on. */
  scheduleEnabled: boolean
  /**
   * Whether the local trigger endpoint may start this workflow (v35). Opt-in
   * PER WORKFLOW so switching the endpoint on never exposes the whole library.
   */
  webhookEnabled: boolean
  /** Folder-watch trigger; null = none configured (v42). */
  watch: WorkflowWatchConfig | null
  /** Monthly spend cap in USD (v44): runs are skipped past it. Null = no cap. */
  budgetUsd?: number | null
  /** Last time a run started (any trigger), for the scheduler's due check. */
  lastRunAt: number | null
  /** Last time the schedule or its enabled state changed. */
  scheduleUpdatedAt: number
  createdAt: number
  updatedAt: number
}

export interface WorkflowInput {
  name: string
  graph: WorkflowGraph
  schedule?: WorkflowSchedule | null
  scheduleEnabled?: boolean
  webhookEnabled?: boolean
  watch?: WorkflowWatchConfig | null
  budgetUsd?: number | null
}

/**
 * How a run was started. 'webhook' = the local trigger endpoint (v35);
 * 'watch' = the folder watcher (v42).
 */
export type WorkflowRunTrigger = 'manual' | 'schedule' | 'webhook' | 'watch'

/** State of the local trigger endpoint, for the settings + builder UI. */
export interface WorkflowTriggerInfo {
  /** Whether the listener is actually bound (a taken port leaves this false). */
  running: boolean
  port: number
  /**
   * The full URL to POST to, token included — shown only in the desktop UI, so
   * the endpoint's key never has to be copied out of a settings file. Null
   * while the endpoint is off or unbound.
   */
  url: string | null
}

/** Live state of one workflow's folder watch, for the builder's Watch panel. */
export interface WorkflowWatchStatus {
  watching: boolean
  lastError: string | null
}

/** A persisted execution of a saved workflow. */
export interface WorkflowRun {
  id: string
  workflowId: string
  trigger: WorkflowRunTrigger
  status: 'ok' | 'error'
  /** The output node's text (or the last executed node's output). */
  output: string
  error: string | null
  startedAt: number
  finishedAt: number
}

export interface WorkflowRunResult {
  ok: boolean
  /** nodeId -> its string output (only for nodes that ran). */
  nodeOutputs: Record<string, string>
  /** Execution order (node ids). */
  order: string[]
  /** Nodes skipped by a condition branch that didn't fire. */
  skipped?: string[]
  /** Present when the run failed. */
  error?: string
  /** nodeId where it failed, when applicable. */
  failedNodeId?: string
}

/**
 * A run joined with its workflow's name, for cross-workflow list surfaces.
 * output/error are truncated to WORKFLOW_RUN_SNIPPET_MAX (workflow-status.ts);
 * the full text stays available via workflows.runs(id).
 */
export interface WorkflowRunListItem extends WorkflowRun {
  workflowName: string
}

/** A workflow that has a schedule, paired with its most recent persisted run. */
export interface ScheduledWorkflowStatus {
  workflow: Workflow
  /** null until the first run finishes; output/error truncated as above. */
  latestRun: WorkflowRun | null
}

/** One call that powers the Home overview and the sidebar Scheduled section. */
export interface WorkflowsOverview {
  /** Every workflow with a schedule (paused included), newest-updated first. */
  scheduled: ScheduledWorkflowStatus[]
  /** Latest persisted runs across ALL workflows, newest first. */
  recentRuns: WorkflowRunListItem[]
}

/** Push payload sent when a saved-workflow run is persisted (any trigger). */
export interface WorkflowRunFinishedEvent {
  run: WorkflowRunListItem
}

// ---------------------------------------------------------------------------
// Standalone scheduled tasks (independent from workflows)
// ---------------------------------------------------------------------------

export type ScheduledTaskRecurrence = 'once' | 'hourly' | 'daily' | 'weekly'
export type ScheduledTaskStatus = 'idle' | 'running' | 'ok' | 'error'

export interface ScheduledTask {
  id: string
  title: string
  prompt: string
  recurrence: ScheduledTaskRecurrence
  nextRunAt: number | null
  enabled: boolean
  /**
   * Tool ids pre-approved for this task's headless runs (consented once, in
   * the create approval/dialog). Everything else still auto-declines there.
   */
  approvedToolIds: string[]
  /** Working folder (code_projects row) for file/shell tools, or null. */
  projectId: string | null
  /**
   * Agent profile that owns this task: its persona, model, toolset and own
   * memories are used for the run. Null = the default model, no persona.
   */
  agentId: string | null
  /** Monthly spend cap in USD (v44): runs are skipped past it. Null = no cap. */
  budgetUsd?: number | null
  /**
   * Delivery target (v47, OpenClaw-style): when set, each run result is also
   * POSTed as JSON to this URL (https, or plain http on localhost only).
   */
  webhookUrl?: string | null
  lastRunAt: number | null
  lastStatus: ScheduledTaskStatus
  lastOutput: string
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface ScheduledTaskInput {
  title: string
  prompt: string
  recurrence: ScheduledTaskRecurrence
  runAt: number
  approvedToolIds?: string[]
  projectId?: string | null
  agentId?: string | null
  webhookUrl?: string | null
}

/**
 * One recorded execution of a scheduled task (migration v33). Kept so a task
 * that quietly started failing is visible without waiting for someone to catch
 * the inbox item — the last-status column on the task itself only ever shows
 * the most recent outcome.
 */
export interface ScheduledTaskRun {
  id: string
  taskId: string
  status: 'ok' | 'error'
  output: string
  error: string | null
  startedAt: number
  finishedAt: number
  /**
   * True when the run was overdue at launch — the app was closed (or busy)
   * when the slot came round. Grasberg runs a missed occurrence ONCE at the
   * next opportunity rather than replaying every slot it slept through, and
   * this flag is how the UI says so instead of quietly pretending it was on
   * time.
   */
  catchUp: boolean
}

/** Incremental renderer update for the standalone scheduled-task list. */
export type ScheduledTasksChangedEvent =
  | { type: 'upsert'; task: ScheduledTask }
  | { type: 'delete'; id: string }

// ---------------------------------------------------------------------------
// IM bridges
// ---------------------------------------------------------------------------

export interface ImBridgeStatus {
  telegramEnabled: boolean
  telegramConversationId: string | null
  /** Whether the poll loop is currently running. */
  telegramConnected: boolean
  /** Whether a bot token is stored (value never returned). */
  hasToken: boolean
  /**
   * One-time pairing code to send from Telegram to link the first chat, or null
   * when a chat is already paired (or the bridge is off). Shown in the UI.
   */
  telegramPairingCode: string | null
  webhookUrl: string | null
}

export interface SetTelegramBridgeInput {
  /** New bot token to store (omit/empty to keep the existing one). */
  token?: string
  conversationId: string | null
  enabled: boolean
}

// ---------------------------------------------------------------------------
// Remote access (phone tunnel via relay)
// ---------------------------------------------------------------------------

/** One phone (or other device) paired to this desktop. */
export interface RemoteDevice {
  id: string
  /** User-visible label chosen at pairing ("Magnus phone"). */
  name: string
  createdAt: number
  lastSeenAt: number | null
  /** Short hash of the device key, so the list can show which key is which. */
  keyFingerprint: string
  /** Set when revoked; revoked devices are kept for the list until deleted. */
  revokedAt: number | null
  /** Whether this device currently holds a live tunnel connection. */
  online: boolean
}

/** Settings → Bridges state for the remote access section. */
export interface RemoteStatus {
  enabled: boolean
  relayUrl: string | null
  clientUrl: string | null
  /** Whether the outbound tunnel to the relay is currently established. */
  connected: boolean
  /** Last connection error, redacted; null while healthy. */
  error: string | null
  desktopId: string | null
  /**
   * Pairing offer while "Pair a device" is open in the UI: the URL to encode
   * as a QR code and when it expires. The secret itself stays in the fragment
   * of that URL — it is shown, never stored.
   */
  pairing: { url: string; expiresAt: number } | null
  devices: RemoteDevice[]
}

export interface RemoteSetConfigInput {
  enabled: boolean
  /** Relay base URL (https:// or ws://localhost for local testing); null keeps the current one. */
  relayUrl?: string | null
  /** Trusted static mobile-client URL; must have a different origin from the relay. */
  clientUrl?: string | null
}

// ---------------------------------------------------------------------------
// Prompt library
// ---------------------------------------------------------------------------

export interface PromptTemplate {
  id: string
  title: string
  body: string
  /** Reserved for a later placeholder feature; null in v1. */
  variables?: string[] | null
  createdAt: number
  updatedAt: number
}

export interface PromptTemplateInput {
  title: string
  body: string
}

export interface PromptTemplatePatch {
  title?: string
  body?: string
}

// ---------------------------------------------------------------------------
// Skills (Agent Skills standard: SKILL.md with YAML frontmatter, optionally
// packaged in plugins with a .claude-plugin/plugin.json manifest)
// ---------------------------------------------------------------------------

export interface Skill {
  id: string
  /** Skill identifier the model passes to use_skill (frontmatter `name`). */
  name: string
  /** One-line summary listed in the system prompt (frontmatter `description`). */
  description: string
  /** Full Markdown instructions (the SKILL.md body). */
  content: string
  /** Plugin manifest name when imported from a plugin; null otherwise. */
  pluginName: string | null
  /** Folder the skill was imported from; null when created manually. */
  sourcePath: string | null
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface SkillInput {
  name: string
  description?: string
  content: string
  pluginName?: string | null
  sourcePath?: string | null
}

export interface SkillPatch {
  name?: string
  description?: string
  content?: string
  enabled?: boolean
}

// ---------------------------------------------------------------------------
// Memory (assistant memories persisted across conversations)
// ---------------------------------------------------------------------------

export interface Memory {
  id: string
  /** Short identifying slug; assistant upserts by title (case-insensitive). */
  title: string
  /** Markdown content of the memory. */
  content: string
  /** Conversation the assistant saved it from; null when user-created/edited. */
  sourceConversationId: string | null
  /**
   * Agent profile that owns this memory (migration v32). Null = a shared
   * memory every conversation sees. An agent-owned memory is visible ONLY to
   * that agent's runs, so "Watcher" and "Release notes" keep separate
   * recollections instead of one global pile. Titles are unique per owner,
   * so both can hold a memory called "last-seen".
   */
  agentId: string | null
  createdAt: number
  updatedAt: number
}

export interface MemoryInput {
  title: string
  content: string
  sourceConversationId?: string | null
  agentId?: string | null
}

export interface MemoryPatch {
  title?: string
  content?: string
}

// ---------------------------------------------------------------------------
// Notebooks (Home-level living Markdown documents, documents table revived in
// v43). Versions are written by the repository before every content change,
// capped at 20 per document — that is the undo story for model edits.
// ---------------------------------------------------------------------------

export interface NotebookDoc {
  id: string
  title: string
  /** Markdown content. */
  content: string
  /** Legacy conversation-scoped rows only; notebooks carry null. */
  conversationId: string | null
  /** 'doc' for notebooks; 'html' rows are legacy prototypes, never listed. */
  kind: 'doc' | 'html'
  createdAt: number
  updatedAt: number
}

/** List row without the content (Home card weight): length stands in. */
export interface NotebookDocSummary {
  id: string
  title: string
  contentLength: number
  createdAt: number
  updatedAt: number
}

export interface NotebookDocInput {
  title: string
  content?: string
}

export interface NotebookDocPatch {
  title?: string
  content?: string
}

/** One snapshot of a notebook's previous content (newest first by id). */
export interface NotebookDocVersion {
  id: number
  documentId: string
  content: string
  createdAt: number
}

/**
 * Version row without the content (the history panel only shows a length and
 * restores by id — shipping up to 20 full contents over IPC is dead weight).
 */
export interface NotebookDocVersionSummary {
  id: number
  documentId: string
  contentLength: number
  createdAt: number
}

/** Outcome of a memory-consolidation ("dreaming") run. */
export interface DreamResult {
  /** False when the run was skipped (disabled, too few memories, nothing new). */
  ran: boolean
  /** Memory count before/after (equal when the model changed nothing). */
  before: number
  after: number
  updated: number
  removed: number
  created: number
}

// ---------------------------------------------------------------------------
// Backup (export/import of settings, memories and skills)
// ---------------------------------------------------------------------------

export interface BackupSummary {
  /** Number of settings keys applied from the backup. */
  settingsApplied: number
  memoriesImported: number
  skillsImported: number
  /** Conversations inserted (existing ids are skipped, never overwritten). */
  conversationsImported: number
  promptsImported: number
  workflowsImported: number
  /** Malformed or already-present entries that were skipped. */
  skippedItems: number
}

// ---------------------------------------------------------------------------
// App info
// ---------------------------------------------------------------------------

export interface AppInfo {
  appVersion: string
  electronVersion: string
  platform: 'darwin' | 'win32' | 'linux'
  /** Whether OS-level encryption (safeStorage) is available for API keys. */
  encryptionAvailable: boolean
  userDataPath: string
}

/** A checkpoint without its file snapshots — what the checkpoint list renders. */
export interface CheckpointLite {
  id: string
  conversationId: string
  label: string
  /** Turn grouping: seq of the assistant message whose apply created it. */
  messageSeq: number
  createdAt: number
  filePaths: string[]
}
