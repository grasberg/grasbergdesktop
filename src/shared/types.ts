/**
 * Shared domain types for Grasberg Desktop.
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
}

export interface TokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
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
  /** Monotonic order within the conversation. */
  seq: number
  createdAt: number
}

/** Sampling parameters; all optional — provider defaults apply when unset. */
export interface ChatParams {
  temperature?: number
  maxTokens?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
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
  /** Code project this conversation belongs to (code mode). */
  projectId: string | null
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
}

// ---------------------------------------------------------------------------
// Streaming (main -> renderer)
// ---------------------------------------------------------------------------

/** Events for one in-flight generation, delivered over the stream channel. */
export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; toolCall: ToolCallRecord }
  | { type: 'usage'; usage: TokenUsage }
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

export interface AppSettings {
  theme: ThemeSetting
  /** Global default provider/model used by new conversations. */
  defaultProviderId: string | null
  defaultModelId: string | null
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
   * Opt-in: allow the run_shell_command tool to actually execute commands
   * (still gated by per-call approval). Off by default — the app otherwise
   * only ever *suggests* shell commands.
   */
  shellExecutionEnabled: boolean
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
  /** Generic outbound webhook posted on each assistant completion (opt-in). */
  outboundWebhookUrl: string | null
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  defaultProviderId: null,
  defaultModelId: null,
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
  shellExecutionEnabled: false,
  browserToolsEnabled: false,
  telegramBridgeEnabled: false,
  telegramBridgeConversationId: null,
  outboundWebhookUrl: null,
}

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
export type CodeChangeStatus = 'proposed' | 'applied' | 'rejected'

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
// Workflows (visual node graph)
// ---------------------------------------------------------------------------

export type WorkflowNodeKind = 'manual' | 'ai_agent' | 'http_request' | 'template' | 'output'

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
}

export interface WorkflowGraph {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface Workflow {
  id: string
  name: string
  graph: WorkflowGraph
  createdAt: number
  updatedAt: number
}

export interface WorkflowInput {
  name: string
  graph: WorkflowGraph
}

export interface WorkflowRunResult {
  ok: boolean
  /** nodeId -> its string output (only for nodes that ran). */
  nodeOutputs: Record<string, string>
  /** Execution order (node ids). */
  order: string[]
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
