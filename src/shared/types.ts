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
  /** 'image' for images sent to vision models; otherwise text (default). */
  kind?: 'text' | 'image'
  /** Extracted text content that gets sent to the provider (text files). */
  textContent?: string
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
  /** Monotonic order within the conversation. */
  seq: number
  createdAt: number
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
 * - 'workspace-write' (the default when unset): today's behavior — writes are
 *   path-jailed to the granted folder and shell commands run in it.
 * - 'full': additionally allows run_shell_command to target an absolute cwd
 *   outside the project folder. Every shell call still requires approval.
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

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ThemeSetting = 'system' | 'light' | 'dark'

/** A per-mode default provider/model for new conversations (null = global default). */
export interface ModeModelDefault {
  providerId: string | null
  modelId: string | null
}

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
   * Opt-in: allow the run_shell_command tool to actually execute commands
   * (still gated by per-call approval). Off by default — the app otherwise
   * only ever *suggests* shell commands.
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
}

export interface ArenaStartRequest {
  conversationId: string
  task: string
  /** 2–4 models to race on identical worktree copies of the repo. */
  candidates: MoaModelRef[]
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

export interface ActivityQuery {
  /** Newest first; defaults to a page of 100. */
  limit?: number
  /** Only entries at or before this timestamp (cursor for "load older"). */
  before?: number
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
  createdAt: number
  updatedAt: number
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
}

export type AgentProfilePatch = Partial<AgentProfileInput>

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
  /** Last time a run started (any trigger), for the scheduler's due check. */
  lastRunAt: number | null
  createdAt: number
  updatedAt: number
}

export interface WorkflowInput {
  name: string
  graph: WorkflowGraph
  schedule?: WorkflowSchedule | null
  scheduleEnabled?: boolean
  webhookEnabled?: boolean
}

/** How a run was started. 'webhook' = the local trigger endpoint (v35). */
export type WorkflowRunTrigger = 'manual' | 'schedule' | 'webhook'

/** State of the local trigger endpoint, for the settings + builder UI. */
export interface WorkflowTriggerInfo {
  /** The user's switch. */
  enabled: boolean
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
