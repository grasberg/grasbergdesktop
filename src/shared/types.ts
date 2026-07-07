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

export type ConversationMode = 'chat' | 'cowork' | 'code' | 'write' | 'design'

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

/** Sampling parameters; all optional — provider defaults apply when unset. */
export interface ChatParams {
  temperature?: number
  maxTokens?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
  /** Code mode: read-only investigation + plan first (mutating tools blocked). */
  planMode?: boolean
  /**
   * Auto-accept file edits: edit_file/write_file run without the per-call
   * approval dialog (all other tools still ask). Off unless explicitly set.
   */
  autoAcceptEdits?: boolean
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
  /** Cowork workspace this conversation belongs to (cowork mode). */
  workspaceId: string | null
  /** Code project (folder) this conversation belongs to (code mode). */
  projectId: string | null
  /**
   * Organizational Project (see the `Project` type / `projects` table) this
   * task belongs to, or null = unfiled. Available in every mode and always of
   * the same mode as the conversation. Distinct from `projectId`, which is the
   * Code-mode granted folder.
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
 * (conversations) within one mode. Every mode (chat/cowork/code/write/design)
 * has its own project list. Orthogonal to Cowork workspaces and Code folders —
 * a project just organizes the sidebar; it holds no working state of its own.
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
   * yet paired": the first chat that messages the bot is pinned here (trust on
   * first use) and every other sender is refused thereafter. Reset to null when
   * a new bot token is set.
   */
  telegramBridgeAllowedChatId: number | null
  /** Generic outbound webhook posted on each assistant completion (opt-in). */
  outboundWebhookUrl: string | null
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  defaultProviderId: null,
  defaultModelId: null,
  perModeModelsEnabled: false,
  modeModels: {
    chat: { providerId: null, modelId: null },
    cowork: { providerId: null, modelId: null },
    code: { providerId: null, modelId: null },
    write: { providerId: null, modelId: null },
    design: { providerId: null, modelId: null },
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
  outboundWebhookUrl: null,
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
] satisfies readonly (keyof AppSettings)[])

// ---------------------------------------------------------------------------
// Cowork
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
// Code mode
// ---------------------------------------------------------------------------

export interface CodeProject {
  id: string
  /** Absolute path, granted explicitly by the user via folder picker. */
  path: string
  name: string
  approvedAt: number
  lastOpenedAt: number | null
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
}

/**
 * How far an approval reaches. 'once' approves this single call;
 * 'conversation' also auto-approves future calls of the same tool in the same
 * conversation (in-memory only — resets on app restart).
 */
export type ToolApprovalScope = 'once' | 'conversation'

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
// Write / Design documents
// ---------------------------------------------------------------------------

export type DocumentKind = 'doc' | 'html'

export interface Document {
  id: string
  conversationId: string
  /** 'doc' = Write-mode Markdown document; 'html' = Design-mode prototype. */
  kind: DocumentKind
  title: string
  content: string
  createdAt: number
  updatedAt: number
}

export type DocumentExportFormat = 'markdown' | 'html'

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

/** Recurring trigger for a workflow (interval-based). */
export interface WorkflowSchedule {
  everyMinutes: number
}

export interface Workflow {
  id: string
  name: string
  graph: WorkflowGraph
  /** Recurring trigger; null = manual only. */
  schedule: WorkflowSchedule | null
  /** The schedule fires only while this is on. */
  scheduleEnabled: boolean
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
}

/** A persisted execution of a saved workflow. */
export interface WorkflowRun {
  id: string
  workflowId: string
  trigger: 'manual' | 'schedule'
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
  createdAt: number
  updatedAt: number
}

export interface MemoryInput {
  title: string
  content: string
  sourceConversationId?: string | null
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
