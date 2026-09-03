/**
 * IPC contract between renderer and main.
 *
 * - Request/response calls use ipcRenderer.invoke(channel, payload) and every
 *   handler returns an IpcResult<T> (never throws across the boundary).
 * - Streaming uses a single push channel (CHANNELS.streamEvent) carrying
 *   StreamEventEnvelope objects.
 * - Preload exposes the typed `UldApi` below as `window.uld`.
 *
 * Channel names are namespaced strings; keep this file the single source of
 * truth — main handlers and preload must both import from here.
 */

import type {
  AgentProfile,
  AgentProfileInput,
  AgentProfilePatch,
  AgentRun,
  AppInfo,
  AppLockSetPassphraseInput,
  AppLockStatus,
  AppSettings,
  Attachment,
  AuthMode,
  BotBinding,
  BotGroup,
  BotGroupActivation,
  BotRoster,
  A2aOutboxEntry,
  ChatParams,
  CodeChange,
  CheckpointLite,
  CodeProject,
  GitStatus,
  GitHubPrInput,
  GitHubPrResult,
  Conversation,
  ConversationMode,
  ProviderType,
  ConversationSummary,
  CustomToolInfo,
  CustomToolInput,
  CustomToolPatch,
  FileTreeNode,
  ImBridgeStatus,
  KnowledgeBase,
  KnowledgeBaseInput,
  McpServerConfig,
  McpServerInput,
  McpServerPatch,
  McpServerRuntime,
  Memory,
  MemoryInput,
  MemoryPatch,
  MorningBrief,
  NotebookDoc,
  NotebookDocInput,
  NotebookDocPatch,
  NotebookDocSummary,
  NotebookDocVersionSummary,
  DreamResult,
  BackupSummary,
  SetTelegramBridgeInput,
  RemoteSetConfigInput,
  RemoteStatus,
  Skill,
  SkillInput,
  SkillPatch,
  Space,
  SpacePatch,
  Workflow,
  WorkflowGraph,
  WorkflowInput,
  WorkflowRun,
  WorkflowRunFinishedEvent,
  WorkflowRunResult,
  WorkflowsOverview,
  Message,
  ModelInfo,
  NormalizedError,
  OAuthStatus,
  Project,
  ProjectInput,
  ProjectPatch,
  ProviderConfig,
  ProviderConfigInput,
  ProviderConfigPatch,
  ProviderTypeMeta,
  QuickContext,
  QuickStreamEventEnvelope,
  ResearchDepth,
  ActivityCursor,
  ActivityEntry,
  ActivityQuery,
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTasksChangedEvent,
  WorkflowTriggerInfo,
  WorkflowWatchStatus,
  ScheduledTaskInput,
  PromptTemplate,
  PromptTemplateInput,
  PromptTemplatePatch,
  ChatSendResult,
  StartStreamResult,
  StreamEventEnvelope,
  ArenaStartRequest,
  ArenaState,
  ExperimentEntry,
  OptimizerRun,
  OptimizerStartInput,
  OptimizerVersion,
  InboxItem,
  InboxItemType,
  ConversationCostSummary,
  HeadlessUsageSummaryEntry,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSessionInfo,
  VoiceDownloadProgressEvent,
  VoiceModelId,
  VoiceStatus,
  UsageSummaryEntry,
  TestConnectionResult,
  ToolApprovalRequest,
  ToolApprovalScope,
  UserQuestionRequest,
  ToolDefinition,
  ToolPermission,
  ToolPermissionDecision,
  ToolRule,
  ToolRuleInput,
  Workspace,
  WorkspaceItem,
  WorkspaceItemKind,
  WorktreeInfo,
} from './types'

// ---------------------------------------------------------------------------
// Result wrapper — no exceptions across IPC
// ---------------------------------------------------------------------------

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: NormalizedError }

export const ok = <T>(data: T): IpcResult<T> => ({ ok: true, data })
export const err = <T = never>(error: NormalizedError): IpcResult<T> => ({ ok: false, error })

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export const CHANNELS = {
  // app
  appGetInfo: 'app:getInfo',
  appPickFolder: 'app:pickFolder',
  appPickFiles: 'app:pickFiles',
  appStorePastedImage: 'app:storePastedImage',
  appReadAttachment: 'app:readAttachment',
  /** Extract text from a stored PDF (text layer) or OCR a stored PDF/image. */
  appExtractAttachmentText: 'app:extractAttachmentText',
  /** Save a stored (generated) image to a user-chosen path. */
  appSaveAttachmentAs: 'app:saveAttachmentAs',

  // settings
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  // providers
  providersListTypes: 'providers:listTypes',
  providersList: 'providers:list',
  providersCreate: 'providers:create',
  providersUpdate: 'providers:update',
  providersDelete: 'providers:delete',
  providersSetKey: 'providers:setKey',
  providersDeleteKey: 'providers:deleteKey',
  providersTest: 'providers:test',
  providersListModels: 'providers:listModels',
  providersPreviewModels: 'providers:previewModels',
  providersDetectLocal: 'providers:detectLocal',
  providersOauthStart: 'providers:oauthStart',
  providersOauthLogout: 'providers:oauthLogout',
  providersOauthStatus: 'providers:oauthStatus',

  // conversations
  convList: 'conv:list',
  convCreate: 'conv:create',
  convGet: 'conv:get',
  convUpdate: 'conv:update',
  convDelete: 'conv:delete',
  convMessages: 'conv:messages',
  convExport: 'conv:export',
  convFork: 'conv:fork',
  convForkLineage: 'conv:forkLineage',

  // private spaces (v45; desktop-local, never exposed remotely)
  spacesList: 'spaces:list',
  spacesCreate: 'spaces:create',
  spacesUpdate: 'spaces:update',
  spacesDelete: 'spaces:delete',

  // app lock (lock:status and lock:unlock are the ONLY channels served while locked)
  lockStatus: 'lock:status',
  lockUnlock: 'lock:unlock',
  lockNow: 'lock:lockNow',
  lockSetPassphrase: 'lock:setPassphrase',

  // projects (per-mode organizational grouping of conversations)
  projectsList: 'projects:list',
  projectsCreate: 'projects:create',
  projectsUpdate: 'projects:update',
  projectsDelete: 'projects:delete',

  // data maintenance (destructive bulk operations)
  dataDeleteAllContent: 'data:deleteAllContent',

  // chat generation
  chatSend: 'chat:send',
  chatStop: 'chat:stop',
  chatRegenerate: 'chat:regenerate',
  chatEditAndRerun: 'chat:editAndRerun',
  chatPickCompareWinner: 'chat:pickCompareWinner',
  /** Manual context compaction (the /compact command). */
  chatCompact: 'chat:compact',

  // cowork
  workspaceList: 'workspace:list',
  workspaceCreate: 'workspace:create',
  workspaceGet: 'workspace:get',
  workspaceUpdate: 'workspace:update',
  workspaceDelete: 'workspace:delete',
  workspaceItemsList: 'workspace:items:list',
  workspaceItemCreate: 'workspace:items:create',
  workspaceItemUpdate: 'workspace:items:update',
  workspaceItemDelete: 'workspace:items:delete',

  // working folders + code pipeline (Work mode)
  codeProjectsList: 'code:projects:list',
  codeProjectOpen: 'code:projects:open',
  codeProjectForget: 'code:projects:forget',
  /** Opens the project's folder in the OS file explorer. */
  codeProjectReveal: 'code:projects:reveal',
  codeFileTree: 'code:fileTree',
  codeReadFile: 'code:readFile',
  codeChangesList: 'code:changes:list',
  codeChangeApply: 'code:changes:apply',
  codeChangeReject: 'code:changes:reject',
  codeChangeRevert: 'code:changes:revert',
  /** Project-wide change list with conversation titles (the review queue). */
  codeChangesListAll: 'code:changes:listAll',
  /** Path autocomplete for @-file mentions in the composer. */
  codeSuggestFiles: 'code:suggestFiles',
  // git (commit bar + git_write plumbing; every handler is click-consented)
  codeGitStatus: 'code:git:status',
  codeGitStage: 'code:git:stage',
  codeGitUnstage: 'code:git:unstage',
  codeGitCommit: 'code:git:commit',
  codeGitCreateBranch: 'code:git:createBranch',
  codeGitFetch: 'code:git:fetch',
  codeGitSetOrigin: 'code:git:setOrigin',
  codeGitPull: 'code:git:pull',
  codeGitPush: 'code:git:push',
  codeGithubPrCreate: 'code:github:pr:create',
  codeGitGenerateCommitMessage: 'code:git:generateCommitMessage',
  codeWorktreeCreate: 'code:worktree:create',
  codeOpenInIde: 'code:ide:open',
  codeCheckpointsList: 'code:checkpoints:list',
  codeCheckpointRestore: 'code:checkpoints:restore',
  codeTurnRevert: 'code:turn:revert',

  // tools
  toolsList: 'tools:list',
  toolsSetEnabled: 'tools:setEnabled',
  toolsPermissionsList: 'tools:permissions:list',
  toolsPermissionSet: 'tools:permissions:set',
  toolsApprovalRespond: 'tools:approval:respond',
  toolsQuestionRespond: 'tools:question:respond',
  toolsCustomList: 'tools:custom:list',
  toolsCustomCreate: 'tools:custom:create',
  toolsCustomUpdate: 'tools:custom:update',
  toolsCustomDelete: 'tools:custom:delete',
  toolsRulesList: 'tools:rules:list',
  toolsRuleCreate: 'tools:rules:create',
  toolsRuleDelete: 'tools:rules:delete',

  // activity log (every tool call, with why it was allowed)
  activityList: 'activity:list',
  activityClear: 'activity:clear',

  // prompt library
  promptsList: 'prompts:list',
  promptsCreate: 'prompts:create',
  promptsUpdate: 'prompts:update',
  promptsDelete: 'prompts:delete',

  // memories
  memoriesList: 'memories:list',
  memoriesCreate: 'memories:create',
  memoriesUpdate: 'memories:update',
  memoriesDelete: 'memories:delete',
  memoriesDream: 'memories:dream',

  // notebooks (Home-level living Markdown docs)
  documentsList: 'documents:list',
  documentsGet: 'documents:get',
  documentsCreate: 'documents:create',
  documentsUpdate: 'documents:update',
  documentsDelete: 'documents:delete',
  documentsListVersions: 'documents:listVersions',
  documentsRevert: 'documents:revert',
  documentsExport: 'documents:export',

  // skills
  skillsList: 'skills:list',
  skillsCreate: 'skills:create',
  skillsUpdate: 'skills:update',
  skillsDelete: 'skills:delete',
  skillsImportFolder: 'skills:importFolder',

  // backup (settings + memories + skills)
  backupExport: 'backup:export',
  backupImport: 'backup:import',

  // MCP servers
  mcpList: 'mcp:list',
  mcpCreate: 'mcp:create',
  mcpUpdate: 'mcp:update',
  mcpDelete: 'mcp:delete',
  mcpSetEnabled: 'mcp:setEnabled',
  mcpReconnect: 'mcp:reconnect',
  mcpStatus: 'mcp:status',

  // IM bridges
  imStatus: 'im:status',
  imSetTelegram: 'im:setTelegram',
  imSetWebhook: 'im:setWebhook',

  // Remote access (phone tunnel via relay)
  remoteStatus: 'remote:status',
  /** Enables/updates the tunnel config; (re)connects or disconnects. */
  remoteSetConfig: 'remote:setConfig',
  /** Opens a pairing offer (QR) for a new phone; cancels when called with false. */
  remotePair: 'remote:pair',
  remoteDeviceRevoke: 'remote:deviceRevoke',

  // Workflows
  workflowsList: 'workflows:list',
  workflowsGet: 'workflows:get',
  workflowsCreate: 'workflows:create',
  workflowsUpdate: 'workflows:update',
  workflowsDelete: 'workflows:delete',
  workflowsRun: 'workflows:run',
  workflowsRunById: 'workflows:runById',
  workflowsRuns: 'workflows:runs',
  /** Scheduled workflows with latest-run status + recent runs across all workflows. */
  workflowsOverview: 'workflows:overview',
  workflowsTriggerInfo: 'workflows:trigger:info',
  workflowsTriggerRegenerate: 'workflows:trigger:regenerate',
  workflowsWatchInfo: 'workflows:watch:info',

  // Standalone scheduled tasks (clock menu; independent from workflows)
  scheduledTasksList: 'scheduledTasks:list',
  scheduledTasksCreate: 'scheduledTasks:create',
  scheduledTasksSetEnabled: 'scheduledTasks:setEnabled',
  scheduledTasksSetBudget: 'scheduledTasks:setBudget',
  scheduledTasksDelete: 'scheduledTasks:delete',
  scheduledTaskRuns: 'scheduledTasks:runs',

  // agent profiles
  agentsList: 'agents:list',
  agentsCreate: 'agents:create',
  agentsUpdate: 'agents:update',
  agentsDelete: 'agents:delete',
  agentRunsList: 'agents:runs:list',
  agentRunStop: 'agents:runs:stop',
  agentPackExport: 'agents:pack:export',
  agentPackImport: 'agents:pack:import',

  // Bot Mode (v46): roster, canonical bot chats, group rooms
  botsRoster: 'bots:roster',
  botsOpenChat: 'bots:openChat',
  botGroupCreate: 'bots:groups:create',
  botGroupUpdate: 'bots:groups:update',
  botGroupDelete: 'bots:groups:delete',
  botGroupSend: 'bots:groups:send',
  botGroupStop: 'bots:groups:stop',
  botGroupMarkSeen: 'bots:groups:markSeen',
  // Durable deliveries (v48): recent outbox rows touching a bot
  botsOutbox: 'bots:outbox',
  // Bot gateway (v47): per-bot external Telegram presence
  botBindingGet: 'bots:binding:get',
  botBindingSetToken: 'bots:binding:setToken',
  botBindingSetEnabled: 'bots:binding:setEnabled',
  botBindingRepair: 'bots:binding:repair',
  botBindingClearToken: 'bots:binding:clearToken',
  botBindingUpdateGroup: 'bots:binding:updateGroup',

  // knowledge bases (RAG)
  kbList: 'kb:list',
  kbCreate: 'kb:create',
  kbDelete: 'kb:delete',
  kbImportFiles: 'kb:importFiles',
  kbSources: 'kb:sources',
  kbRemoveSource: 'kb:removeSource',

  // code arena (same task, N models, isolated worktrees)
  arenaStart: 'arena:start',
  arenaStatus: 'arena:status',
  arenaApply: 'arena:apply',
  arenaStop: 'arena:stop',
  arenaDiscard: 'arena:discard',

  // optimizer (autonomous benchmark-improve-commit loop per project)
  optimizerStart: 'optimizer:start',
  optimizerStop: 'optimizer:stop',
  optimizerList: 'optimizer:list',
  optimizerVersions: 'optimizer:versions',

  // per-project experiment log (AVO-style lineage memory)
  experimentsList: 'experiments:list',

  // agent inbox (unified review queue for background results)
  inboxList: 'inbox:list',
  inboxMarkReviewed: 'inbox:markReviewed',

  // morning brief (daily digest generated main-side)
  briefList: 'brief:list',
  briefDismiss: 'brief:dismiss',

  // usage (local, estimate-only spend summary)
  usageSummary: 'usage:summary',
  /** Month-to-date estimated cost of one conversation (header HUD). */
  usageConversationCost: 'usage:conversationCost',
  /** Headless-generation spend grouped by run kind (Settings → Usage). */
  usageHeadless: 'usage:headless',

  // terminal (user-driven Work-view terminal; sessions are per conversation)
  terminalCreate: 'terminal:create',
  terminalInput: 'terminal:input',
  terminalDispose: 'terminal:dispose',

  // voice (offline whisper.cpp STT; desktop-local, never exposed remotely)
  voiceStatus: 'voice:status',
  voiceDownload: 'voice:download',
  voiceDownloadCancel: 'voice:download:cancel',
  voiceRemove: 'voice:remove',
  /** Main-side native picker for a locally built whisper-cli binary. */
  voicePickBinary: 'voice:pickBinary',
  voiceSttBegin: 'voice:stt:begin',
  voiceSttChunk: 'voice:stt:chunk',
  voiceSttEnd: 'voice:stt:end',
  voiceSttCancel: 'voice:stt:cancel',
  voiceTranscribeAttachment: 'voice:transcribeAttachment',

  // quick assistant (global-shortcut clipboard mini window; desktop-local,
  // never exposed remotely)
  quickRun: 'quick:run',
  quickGetContext: 'quick:getContext',
  quickHide: 'quick:hide',
  quickPromote: 'quick:promote',

  // push channels (main -> renderer, via webContents.send)
  streamEvent: 'push:streamEvent',
  toolApprovalRequest: 'push:toolApprovalRequest',
  /** Sent when a pending approval was settled main-side (timeout, abort, respond). */
  toolApprovalSettled: 'push:toolApprovalSettled',
  userQuestionRequest: 'push:userQuestionRequest',
  /** Sent when a pending question was settled main-side (answer, timeout, abort). */
  userQuestionSettled: 'push:userQuestionSettled',
  conversationsChanged: 'push:conversationsChanged',
  /** Sent with McpServerRuntime[] whenever MCP connection state changes. */
  mcpServersChanged: 'push:mcpServersChanged',
  /**
   * Sent with { projectId } whenever a code change row is created or changes
   * status — lets every window's review queue refresh live, including for
   * changes proposed by OTHER conversations.
   */
  codeChangesChanged: 'push:codeChangesChanged',
  /**
   * Sent with WorkflowRunFinishedEvent whenever a saved-workflow run is
   * persisted (manual or scheduled) — keeps the Home overview and the
   * sidebar Scheduled section live in every window.
   */
  workflowRunFinished: 'push:workflowRunFinished',
  scheduledTasksChanged: 'push:scheduledTasksChanged',
  /** Sent with { brief } when a morning brief is generated or dismissed. */
  briefChanged: 'push:briefChanged',
  /** Sent (no payload) when a tool call created or edited a notebook. */
  documentsChanged: 'push:documentsChanged',
  /** Standing approval rules changed (an approval answer created one). */
  toolRulesChanged: 'push:toolRulesChanged',
  /** A main-side notice for the user (e.g. the trigger endpoint failed to bind). */
  mainNotice: 'push:mainNotice',
  /** Sent with { arena: ArenaState } on every arena/candidate state change. */
  arenaChanged: 'push:arenaChanged',
  /** Sent with { run: OptimizerRun } whenever an optimizer run row mutates. */
  optimizerChanged: 'push:optimizerChanged',
  /** Sent with TerminalDataEvent for every terminal output chunk. */
  terminalData: 'push:terminalData',
  /** Sent with TerminalExitEvent when a terminal session's shell exits. */
  terminalExit: 'push:terminalExit',
  /**
   * Sent (no payload) whenever remote-access state changes: tunnel up/down,
   * a device paired/revoked/seen. The Bridges tab refetches remote:status.
   */
  remoteChanged: 'push:remoteChanged',
  /** Sent with VoiceDownloadProgressEvent while a whisper binary/model downloads. */
  voiceDownloadProgress: 'push:voiceDownloadProgress',
  /**
   * Sent with QuickContext on a re-summon of the quick window. TARGETED at the
   * quick window's webContents only — never the main event bus, so ephemeral
   * quick content can't leak to other windows or the phone tunnel.
   */
  quickContext: 'push:quickContext',
  /** Sent with QuickStreamEventEnvelope; TARGETED at the quick window only. */
  quickStreamEvent: 'push:quickStreamEvent',
  /**
   * Sent with { conversationId } when a quick exchange was promoted into a
   * real conversation (broadcast: the main window navigates to it).
   */
  quickPromoted: 'push:quickPromoted',
  /**
   * Sent with { locked: boolean } when the app lock engages or releases.
   * The ONLY push forwarded to windows while locked.
   */
  appLockChanged: 'push:appLockChanged',
  /**
   * Bot Mode (v46): sent with { agentId?, groupId? } whenever the roster
   * should refresh — a bot chat progressed, a delivery landed, a group turn
   * persisted, membership changed. Coarse by design; the store refetches.
   */
  botsChanged: 'push:botsChanged',
} as const

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS]

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

/**
 * Ad-hoc "list the provider's models" for the Add-provider form, before the
 * provider exists. The apiKey travels to main once, is used transiently for the
 * /models call and is never stored or returned. Falls back to the static
 * catalog when listing isn't supported or the call fails.
 */
export interface PreviewModelsRequest {
  type: ProviderType
  baseUrl?: string
  apiKey?: string
  presetId?: string | null
  authMode?: AuthMode
}

export interface ConvListRequest {
  mode?: ConversationMode
  /** Case-insensitive search over title and message content. */
  search?: string
  /** Restrict to tasks filed under this organizational Project. */
  projectRef?: string
  limit?: number
  /** List this private space; omit for the default space. Stripped for remote callers. */
  spaceId?: string
}

export interface ConvCreateRequest {
  mode: ConversationMode
  title?: string
  providerId?: string | null
  modelId?: string | null
  systemPrompt?: string | null
  workspaceId?: string | null
  projectId?: string | null
  /** File the new task under this organizational Project (same mode). */
  projectRef?: string | null
  /** Generate this conversation through a Mixture-of-Agents preset. */
  moaPresetId?: string | null
  /** Create in this private space; null/omit = the default space. Stripped for remote callers. */
  spaceId?: string | null
}

export interface ConvUpdateRequest {
  id: string
  patch: Partial<{
    title: string
    providerId: string | null
    modelId: string | null
    systemPrompt: string | null
    params: ChatParams
    /** Link/unlink the task's workspace (work mode). */
    workspaceId: string | null
    /** Link/unlink the working folder (work mode). */
    projectId: string | null
    /** File/unfile the task under an organizational Project (any mode). */
    projectRef: string | null
    /** Select/clear the Mixture-of-Agents preset this conversation runs through. */
    moaPresetId: string | null
    /** Attach/detach a knowledge base (retrieval via knowledge_search). */
    knowledgeBaseId: string | null
    /** Monthly spend cap in USD; null clears (stripped on remote requests). */
    budgetUsd: number | null
  }>
}

export interface ProjectListRequest {
  /** List projects for this mode (omit to list every mode's projects). */
  mode?: ConversationMode
}

export type ConvExportFormat = 'markdown' | 'json'

export interface ConvExportRequest {
  conversationId: string
  format: ConvExportFormat
}

export interface ConvExportResult {
  /** True when the user dismissed the save dialog. */
  canceled: boolean
  /** Absolute path written to, when not canceled. */
  path?: string
}

export interface ConvForkLineage {
  /**
   * The conversation this one was forked from, or null — either not a fork or
   * the parent was deleted (the caller distinguishes via
   * `conversation.parentConversationId`).
   */
  parent: { id: string; title: string } | null
  /** The parent's other forks (the asking conversation excluded), oldest first. */
  siblings: Array<{ id: string; title: string; createdAt: number }>
}

export interface ChatSendRequest {
  conversationId: string
  content: string
  attachments?: Attachment[]
  /** One-off overrides for this generation only. */
  overrides?: {
    providerId?: string
    modelId?: string
    params?: ChatParams
    /** One-shot Mixture-of-Agents run (the `/moa` command) without changing the model. */
    moaPresetId?: string | null
    /**
     * Compare run: fan the preset's advisor models out in parallel and show
     * them side by side instead of aggregating. Requires a resolvable MoA
     * preset (via `moaPresetId` or the conversation's stored preset).
     */
    compare?: boolean
    /**
     * Deep Research run (the /research command or composer toggle): plan →
     * parallel web workers → synthesized report with cited sources. Presence
     * of the object activates it; depth defaults to settings. Wins over MoA
     * and compare for this send.
     */
    research?: { depth?: ResearchDepth }
  }
}

/** Starts an ephemeral quick-assistant generation (nothing is persisted). */
export interface QuickRunRequest {
  /** Id of the QuickAction in AppSettings.quickActions. */
  actionId: string
  /** The captured clipboard text (already truncated renderer-side display-wise). */
  selection: string
}

export interface QuickRunResult {
  streamId: string
  /** The composed prompt ({selection} substituted) — what promote records. */
  prompt: string
  /** The resolved acting model, so promote can stamp exactly what ran. */
  providerId: string
  modelId: string
}

/** Promotes a finished quick exchange into a real conversation. */
export interface QuickPromoteRequest {
  userText: string
  answer: string
  providerId: string
  modelId: string
  title?: string
}

export interface ChatRegenerateRequest {
  conversationId: string
  /** The assistant message to regenerate (it is replaced). */
  messageId: string
  /**
   * One-off provider/model for THIS regeneration only ("try again with…").
   * The conversation's own model choice is untouched, and a MoA preset is
   * bypassed — the user explicitly asked this one model to retry.
   */
  overrides?: {
    providerId?: string
    modelId?: string
  }
  /**
   * 'replace' (default) deletes the answer and re-runs. 'second-opinion'
   * keeps it: the message becomes a compare message with the original answer
   * as block 0 and the override model streaming beside it as block 1
   * (requires `overrides`; resolved via the existing pickCompareWinner).
   */
  mode?: 'replace' | 'second-opinion'
}

export interface ChatEditAndRerunRequest {
  conversationId: string
  /** The user message being edited; all later messages are removed. */
  messageId: string
  newContent: string
}

export interface CodeReadFileRequest {
  projectId: string
  relPath: string
}

export interface CodeSuggestFilesRequest {
  projectId: string
  /** Case-insensitive substring matched against relative paths. */
  query: string
  /** Max paths returned (default 12, capped in main). */
  limit?: number
}

/** Result of a manual /compact run. */
export interface ChatCompactResult {
  /** False when there was nothing (or too little) to summarize. */
  compacted: boolean
}

/** Promote one advisor of a compare run to the message's answer. */
export interface ChatPickCompareWinnerRequest {
  conversationId: string
  messageId: string
  /** Index into the message's moaReferences. */
  referenceIndex: number
}

export interface ChatPickCompareWinnerResult {
  /** The message with the winner's text as its content. */
  message: Message
  /** The conversation, now switched to the winning provider/model. */
  conversation: Conversation
}

export interface CodeReadFileResult {
  relPath: string
  content: string
  truncated: boolean
  sizeBytes: number
}

/** An OpenAI-compatible model server found running on localhost. */
export interface LocalServerInfo {
  kind: 'ollama' | 'lmstudio' | 'jan' | 'llamacpp'
  /** Display name, e.g. "Ollama". */
  name: string
  /** Loopback base URL including /v1, e.g. "http://localhost:11434/v1". */
  baseUrl: string
  /** Model ids the server reported (may be empty). */
  models: string[]
}

/** A code change joined with its conversation's title (the review queue). */
export interface CodeChangeWithContext extends CodeChange {
  conversationTitle: string | null
}

export interface CodeTurnRevertRequest {
  conversationId: string
  /** The turn to undo: the message seq stamped on the turn's checkpoints. */
  messageSeq: number
}

/** Bulk-undo outcome: reverts that succeeded plus honest per-file refusals. */
export interface CodeTurnRevertResult {
  reverted: CodeChange[]
  skipped: { filePath: string; reason: string }[]
}

export interface PickFilesResult {
  attachments: Attachment[]
}

export interface StorePastedImageInput {
  mimeType: string
  dataBase64: string
}

export interface ExtractAttachmentTextInput {
  storageKey: string
  /** 'text' = PDF text layer (pdf keys only); 'ocr' = OCR a PDF or image. */
  method: 'text' | 'ocr'
}

export interface AttachmentExtractionResult {
  extractedText: string
  /** 'none' = a text-layer pass found no real text (scanned PDF) — offer OCR. */
  extraction: 'text' | 'ocr' | 'none'
  pageCount?: number
  truncated: boolean
}

// ---------------------------------------------------------------------------
// The API preload exposes as window.uld
// ---------------------------------------------------------------------------

export interface UldApi {
  app: {
    getInfo(): Promise<IpcResult<AppInfo>>
    /** Native folder picker; returns null when cancelled. */
    pickFolder(): Promise<IpcResult<string | null>>
    /** Native file picker; reads text content, enforces size limits. */
    pickFiles(): Promise<IpcResult<PickFilesResult>>
    /** Persists an image pasted from the renderer clipboard as an attachment. */
    storePastedImage(input: StorePastedImageInput): Promise<IpcResult<Attachment>>
    /** Reads a stored image attachment as a data URL (null when missing). */
    readAttachment(storageKey: string): Promise<IpcResult<{ dataUrl: string } | null>>
    /**
     * Extracts text from a stored PDF (method 'text') or OCRs a stored
     * PDF/image (method 'ocr'). Heavy deps load lazily in main.
     */
    extractAttachmentText(
      input: ExtractAttachmentTextInput
    ): Promise<IpcResult<AttachmentExtractionResult>>
    /** Copies a stored image attachment to a user-picked path (save dialog). */
    saveAttachmentAs(
      storageKey: string,
      suggestedName?: string
    ): Promise<IpcResult<{ canceled: boolean; path?: string }>>
  }
  settings: {
    get(): Promise<IpcResult<AppSettings>>
    update(patch: Partial<AppSettings>): Promise<IpcResult<AppSettings>>
  }
  providers: {
    listTypes(): Promise<IpcResult<ProviderTypeMeta[]>>
    list(): Promise<IpcResult<ProviderConfig[]>>
    create(input: ProviderConfigInput): Promise<IpcResult<ProviderConfig>>
    update(id: string, patch: ProviderConfigPatch): Promise<IpcResult<ProviderConfig>>
    delete(id: string): Promise<IpcResult<void>>
    /** Key travels renderer->main once, is encrypted immediately, never returned. */
    setKey(id: string, apiKey: string): Promise<IpcResult<ProviderConfig>>
    deleteKey(id: string): Promise<IpcResult<ProviderConfig>>
    test(id: string): Promise<IpcResult<TestConnectionResult>>
    listModels(id: string): Promise<IpcResult<ModelInfo[]>>
    /** Live model list for a not-yet-created provider (Add form). Key not stored. */
    previewModels(input: PreviewModelsRequest): Promise<IpcResult<ModelInfo[]>>
    /** Probes localhost for running model servers (Ollama, LM Studio, …). */
    detectLocal(): Promise<IpcResult<LocalServerInfo[]>>
    /** Start the "Sign in with ChatGPT" OAuth flow (opens the system browser). */
    oauthStart(id: string): Promise<IpcResult<OAuthStatus>>
    /** Sign out / forget the stored OAuth session. */
    oauthLogout(id: string): Promise<IpcResult<OAuthStatus>>
    /** Token-free status of the provider's OAuth session. */
    oauthStatus(id: string): Promise<IpcResult<OAuthStatus>>
  }
  conversations: {
    list(req?: ConvListRequest): Promise<IpcResult<ConversationSummary[]>>
    create(req: ConvCreateRequest): Promise<IpcResult<Conversation>>
    get(id: string): Promise<IpcResult<Conversation>>
    update(req: ConvUpdateRequest): Promise<IpcResult<Conversation>>
    delete(id: string): Promise<IpcResult<void>>
    messages(conversationId: string): Promise<IpcResult<Message[]>>
    /** Serializes a conversation to a file via a native save dialog (main). */
    export(req: ConvExportRequest): Promise<IpcResult<ConvExportResult>>
    /**
     * Copies the conversation and its transcript up to and including
     * `messageId` (the whole transcript when omitted) into a new conversation.
     */
    fork(id: string, messageId?: string): Promise<IpcResult<Conversation>>
    /** Fork provenance for the backlink chip: parent + sibling forks. */
    forkLineage(id: string): Promise<IpcResult<ConvForkLineage>>
    /**
     * Fires when main writes messages outside a stream (IM-bridge replies,
     * compaction) — the renderer refreshes the list and the open conversation.
     */
    onConversationsChanged(cb: (payload: { conversationId: string }) => void): () => void
  }
  projects: {
    /** Organizational projects, newest first; scoped by mode when given. */
    list(req?: ProjectListRequest): Promise<IpcResult<Project[]>>
    create(input: ProjectInput): Promise<IpcResult<Project>>
    update(id: string, patch: ProjectPatch): Promise<IpcResult<Project>>
    /** Deletes the project; its tasks are unfiled (projectRef set to null). */
    delete(id: string): Promise<IpcResult<void>>
  }
  data: {
    /**
     * Permanently deletes ALL conversations (every mode, with their messages and
     * documents), ALL organizational projects, and ALL cowork workspaces. Keys,
     * providers, settings, memories, skills and granted code folders are kept.
     */
    deleteAllContent(): Promise<IpcResult<void>>
  }
  chat: {
    send(req: ChatSendRequest): Promise<IpcResult<ChatSendResult>>
    stop(streamId: string): Promise<IpcResult<void>>
    regenerate(req: ChatRegenerateRequest): Promise<IpcResult<StartStreamResult>>
    editAndRerun(req: ChatEditAndRerunRequest): Promise<IpcResult<StartStreamResult>>
    /** Summarize older messages now (the /compact command). */
    compact(conversationId: string): Promise<IpcResult<ChatCompactResult>>
    /** Promote one advisor of a compare run to the message's answer. */
    pickCompareWinner(
      req: ChatPickCompareWinnerRequest
    ): Promise<IpcResult<ChatPickCompareWinnerResult>>
    /** Subscribe to stream events; returns unsubscribe. */
    onStreamEvent(cb: (envelope: StreamEventEnvelope) => void): () => void
  }
  workspaces: {
    list(): Promise<IpcResult<Workspace[]>>
    create(input: { name: string; goal?: string }): Promise<IpcResult<Workspace>>
    get(id: string): Promise<IpcResult<Workspace>>
    update(
      id: string,
      patch: Partial<Pick<Workspace, 'name' | 'goal' | 'status'>>
    ): Promise<IpcResult<Workspace>>
    delete(id: string): Promise<IpcResult<void>>
    itemsList(workspaceId: string): Promise<IpcResult<WorkspaceItem[]>>
    itemCreate(input: {
      workspaceId: string
      kind: WorkspaceItemKind
      title: string
      content?: string
      origin: 'user' | 'assistant'
    }): Promise<IpcResult<WorkspaceItem>>
    itemUpdate(
      id: string,
      patch: Partial<Pick<WorkspaceItem, 'title' | 'content' | 'status' | 'sort' | 'kind'>>
    ): Promise<IpcResult<WorkspaceItem>>
    itemDelete(id: string): Promise<IpcResult<void>>
  }
  code: {
    projectsList(): Promise<IpcResult<CodeProject[]>>
    /** Registers a folder the user explicitly picked. */
    projectOpen(path: string): Promise<IpcResult<CodeProject>>
    projectForget(id: string): Promise<IpcResult<void>>
    /** Opens the project's folder in the OS file explorer. */
    projectReveal(id: string): Promise<IpcResult<void>>
    fileTree(projectId: string): Promise<IpcResult<FileTreeNode>>
    readFile(req: CodeReadFileRequest): Promise<IpcResult<CodeReadFileResult>>
    changesList(projectId: string): Promise<IpcResult<CodeChange[]>>
    /** Applies a proposed change to disk — only ever called from an explicit user click. */
    changeApply(changeId: string): Promise<IpcResult<CodeChange>>
    changeReject(changeId: string): Promise<IpcResult<CodeChange>>
    /** Restores the pre-change content of an APPLIED change (explicit click). */
    changeRevert(changeId: string): Promise<IpcResult<CodeChange>>
    /** Project-wide changes with conversation titles (the review queue). */
    changesListAll(projectId: string): Promise<IpcResult<CodeChangeWithContext[]>>
    /** Relative-path suggestions for @-file mentions in the composer. */
    suggestFiles(req: CodeSuggestFilesRequest): Promise<IpcResult<string[]>>
    /** Live review-queue refresh: fires whenever any change row mutates. */
    onChangesChanged(cb: (payload: { projectId: string }) => void): () => void
    // git — every call below is an explicit user click (the click IS the consent)
    gitStatus(projectId: string): Promise<IpcResult<GitStatus>>
    gitStage(projectId: string, paths: string[]): Promise<IpcResult<GitStatus>>
    gitUnstage(projectId: string, paths: string[]): Promise<IpcResult<GitStatus>>
    gitCommit(
      projectId: string,
      message: string
    ): Promise<IpcResult<{ sha: string; branch: string | null }>>
    gitCreateBranch(projectId: string, name: string): Promise<IpcResult<GitStatus>>
    gitFetch(projectId: string): Promise<IpcResult<GitStatus>>
    gitSetOrigin(projectId: string, url: string): Promise<IpcResult<GitStatus>>
    gitPull(projectId: string): Promise<IpcResult<GitStatus>>
    gitPush(projectId: string, confirmDefaultBranch: boolean): Promise<IpcResult<GitStatus>>
    githubPrCreate(projectId: string, input: GitHubPrInput): Promise<IpcResult<GitHubPrResult>>
    /** Suggests a commit message from the staged diff (default model). */
    gitGenerateCommitMessage(projectId: string): Promise<IpcResult<{ message: string }>>
    worktreeCreate(projectId: string, name?: string): Promise<IpcResult<WorktreeInfo>>
    openInIde(projectId: string): Promise<IpcResult<{ command: string }>>
    /** Metadata only — the file snapshots stay in main until a restore. */
    checkpointsList(conversationId: string): Promise<IpcResult<CheckpointLite[]>>
    checkpointRestore(checkpointId: string): Promise<IpcResult<CodeChange>>
    /** Reverts every change applied during one assistant turn (explicit click). */
    revertTurn(req: CodeTurnRevertRequest): Promise<IpcResult<CodeTurnRevertResult>>
  }
  usage: {
    /** Local, estimate-only usage summary over the last `days` days (default 30). */
    summary(days?: number): Promise<IpcResult<UsageSummaryEntry[]>>
    /** Month-to-date estimated cost of one conversation (header HUD). */
    conversationCost(conversationId: string): Promise<IpcResult<ConversationCostSummary>>
    /** Headless spend by run kind over the last `days` days (default 30). */
    headlessSummary(days?: number): Promise<IpcResult<HeadlessUsageSummaryEntry[]>>
  }
  inbox: {
    /** Unified review queue: finished background results, newest first. */
    list(): Promise<IpcResult<InboxItem[]>>
    markReviewed(itemType: InboxItemType, itemId: string): Promise<IpcResult<void>>
  }
  brief: {
    /** Stored morning briefs, newest first (last 7). */
    list(): Promise<IpcResult<MorningBrief[]>>
    /** Dismisses one brief's Home card (persisted). Unknown id is a no-op. */
    dismiss(id: string): Promise<IpcResult<void>>
    onChanged(cb: (payload: { brief: MorningBrief }) => void): () => void
  }
  arena: {
    /** Race 2–4 models on the same task in isolated worktrees. */
    start(req: ArenaStartRequest): Promise<IpcResult<ArenaState>>
    /** The conversation's current arena, or null. */
    status(conversationId: string): Promise<IpcResult<ArenaState | null>>
    /** Apply the winning candidate's files through the change pipeline. */
    apply(conversationId: string, runId: string): Promise<IpcResult<ArenaState>>
    /** Abort every still-running candidate. */
    stop(conversationId: string): Promise<IpcResult<ArenaState | null>>
    /** Remove the arena's worktrees and forget it. */
    discard(conversationId: string): Promise<IpcResult<void>>
    onChanged(cb: (event: { arena: ArenaState }) => void): () => void
  }
  optimizer: {
    /** Starts an autonomous optimize-evaluate-commit loop for a project. */
    start(input: OptimizerStartInput): Promise<IpcResult<OptimizerRun>>
    /** Stops a running loop; the row keeps its state and versions. */
    stop(runId: string): Promise<IpcResult<OptimizerRun | null>>
    /** All runs, newest first. */
    list(): Promise<IpcResult<OptimizerRun[]>>
    /** Accepted + rejected attempts of one run, in seq order. */
    versions(runId: string): Promise<IpcResult<OptimizerVersion[]>>
    onChanged(cb: (event: { run: OptimizerRun }) => void): () => void
  }
  experiments: {
    /** Per-project experiment log (AVO-style lineage memory), newest first. */
    list(projectId: string): Promise<IpcResult<ExperimentEntry[]>>
  }
  terminal: {
    /**
     * Returns the conversation's live terminal session (with scrollback for
     * replay) or spawns one in the granted folder. User-driven only — the
     * model has no tool that reaches these sessions.
     */
    create(conversationId: string): Promise<IpcResult<TerminalSessionInfo>>
    /** Writes user input (typically one line ending in \n) to the session. */
    input(sessionId: string, data: string): Promise<IpcResult<void>>
    /** Kills the session's shell. */
    dispose(sessionId: string): Promise<IpcResult<void>>
    onData(cb: (event: TerminalDataEvent) => void): () => void
    onExit(cb: (event: TerminalExitEvent) => void): () => void
  }
  voice: {
    status(): Promise<IpcResult<VoiceStatus>>
    /** Starts a binary+model download; progress/completion arrive on the push channel. */
    download(modelId: VoiceModelId): Promise<IpcResult<VoiceStatus>>
    cancelDownload(): Promise<IpcResult<VoiceStatus>>
    /** Deletes a downloaded model file (only ever under {userData}/audio). */
    remove(modelId: VoiceModelId): Promise<IpcResult<VoiceStatus>>
    /** Opens the native picker for a local whisper-cli binary (clear = unset). */
    pickBinary(clear: boolean): Promise<IpcResult<VoiceStatus>>
    /** Push-to-talk: begin a chunked WAV upload session. */
    sttBegin(): Promise<IpcResult<{ sessionId: string }>>
    /** One chunk (≤ 8 MB per call, 64 MB per session). */
    sttChunk(sessionId: string, chunk: Uint8Array): Promise<IpcResult<void>>
    /** Assembles the WAV and transcribes it with the local whisper binary. */
    sttEnd(sessionId: string): Promise<IpcResult<{ text: string }>>
    sttCancel(sessionId: string): Promise<IpcResult<void>>
    /**
     * Transcribes a stored audio attachment. With messageId+attachmentId the
     * transcript is persisted onto that message's attachment (extractedText)
     * and push:conversationsChanged fires.
     */
    transcribeAttachment(req: {
      storageKey: string
      messageId?: string
      attachmentId?: string
    }): Promise<IpcResult<{ text: string }>>
    onDownloadProgress(cb: (e: VoiceDownloadProgressEvent) => void): () => void
  }
  quick: {
    /**
     * Runs one quick action on the captured clipboard text. Events arrive on
     * the targeted quick push channel; stopping reuses chat.stop(streamId).
     */
    run(req: QuickRunRequest): Promise<IpcResult<QuickRunResult>>
    /** Last clipboard capture from summon (pulled on mount — no push race). */
    getContext(): Promise<IpcResult<QuickContext>>
    /** Hides the quick window and aborts the in-flight quick stream. */
    hide(): Promise<IpcResult<void>>
    /** Creates a real conversation from the exchange and focuses the main window. */
    promote(req: QuickPromoteRequest): Promise<IpcResult<{ conversationId: string }>>
    onContext(cb: (ctx: QuickContext) => void): () => void
    onStreamEvent(cb: (envelope: QuickStreamEventEnvelope) => void): () => void
    onPromoted(cb: (payload: { conversationId: string }) => void): () => void
  }
  tools: {
    list(): Promise<IpcResult<ToolDefinition[]>>
    setEnabled(toolId: string, enabled: boolean): Promise<IpcResult<void>>
    permissionsList(): Promise<IpcResult<ToolPermission[]>>
    permissionSet(toolId: string, decision: ToolPermissionDecision): Promise<IpcResult<void>>
    /** scope 'conversation' also auto-approves the tool's future calls there. */
    approvalRespond(
      requestId: string,
      approved: boolean,
      scope?: ToolApprovalScope
    ): Promise<IpcResult<void>>
    onApprovalRequest(cb: (req: ToolApprovalRequest) => void): () => void
    /** Fires with the requestId whenever main settles an approval (respond/timeout/abort). */
    onApprovalSettled(cb: (requestId: string) => void): () => void
    /** Answer an ask_user_question dialog; null means the user dismissed it. */
    questionRespond(requestId: string, answer: string | null): Promise<IpcResult<void>>
    onQuestionRequest(cb: (req: UserQuestionRequest) => void): () => void
    onQuestionSettled(cb: (requestId: string) => void): () => void
    /** Custom HTTP tools: full details for the edit form (values excluded). */
    customList(): Promise<IpcResult<CustomToolInfo[]>>
    /** Secret header values are encrypted in main and never returned. */
    customCreate(input: CustomToolInput): Promise<IpcResult<CustomToolInfo[]>>
    customUpdate(toolId: string, patch: CustomToolPatch): Promise<IpcResult<CustomToolInfo[]>>
    customDelete(toolId: string): Promise<IpcResult<CustomToolInfo[]>>
    /** Standing approval rules ("always allow" / "always ask"), newest first. */
    rulesList(): Promise<IpcResult<ToolRule[]>>
    ruleCreate(input: ToolRuleInput): Promise<IpcResult<ToolRule[]>>
    ruleDelete(ruleId: string): Promise<IpcResult<ToolRule[]>>
    /** Fires when an approval answer (or another window) changed the rules. */
    onRulesChanged(cb: () => void): () => void
  }
  /** Notices raised by main itself (no request in flight), shown as a toast. */
  notices: {
    onNotice(cb: (notice: { message: string; level: 'info' | 'error' }) => void): () => void
  }
  /** The audit trail: every tool call, newest first. */
  activity: {
    list(
      query?: ActivityQuery
    ): Promise<
      IpcResult<{ entries: ActivityEntry[]; total: number; cursor: ActivityCursor | null }>
    >
    clear(): Promise<IpcResult<void>>
  }
  prompts: {
    list(): Promise<IpcResult<PromptTemplate[]>>
    create(input: PromptTemplateInput): Promise<IpcResult<PromptTemplate>>
    update(id: string, patch: PromptTemplatePatch): Promise<IpcResult<PromptTemplate>>
    delete(id: string): Promise<IpcResult<void>>
  }
  memories: {
    list(): Promise<IpcResult<Memory[]>>
    create(input: MemoryInput): Promise<IpcResult<Memory>>
    update(id: string, patch: MemoryPatch): Promise<IpcResult<Memory>>
    delete(id: string): Promise<IpcResult<void>>
    /** Manual "Consolidate now": runs a dream regardless of the auto toggle. */
    dream(): Promise<IpcResult<DreamResult>>
  }
  documents: {
    /** Notebook summaries (kind 'doc' only), updated_at DESC, no content. */
    list(): Promise<IpcResult<NotebookDocSummary[]>>
    get(id: string): Promise<IpcResult<NotebookDoc>>
    create(input: NotebookDocInput): Promise<IpcResult<NotebookDoc>>
    /** A content change snapshots the previous content as a version first. */
    update(id: string, patch: NotebookDocPatch): Promise<IpcResult<NotebookDoc>>
    delete(id: string): Promise<IpcResult<void>>
    /** Version summaries, newest first (capped at 20 per document). */
    listVersions(id: string): Promise<IpcResult<NotebookDocVersionSummary[]>>
    /** Restores a version; the pre-revert content is snapshotted first. */
    revert(id: string, versionId: number): Promise<IpcResult<NotebookDoc>>
    /** Save-dialog export of the notebook's Markdown. */
    export(id: string): Promise<IpcResult<{ canceled: true } | { canceled: false; path: string }>>
    /** Fired when a tool call created or edited a notebook. */
    onChanged(cb: () => void): () => void
  }
  skills: {
    list(): Promise<IpcResult<Skill[]>>
    create(input: SkillInput): Promise<IpcResult<Skill>>
    update(id: string, patch: SkillPatch): Promise<IpcResult<Skill>>
    delete(id: string): Promise<IpcResult<void>>
    /** Imports every skill in a folder (skill / collection / plugin). */
    importFolder(path: string): Promise<IpcResult<Skill[]>>
  }
  backup: {
    /**
     * Save-dialog export of settings + memories + skills (never secrets).
     * Private-space conversations are excluded unless `includePrivateSpaces`
     * is explicitly set.
     */
    export(opts?: {
      includePrivateSpaces?: boolean
    }): Promise<IpcResult<{ canceled: true } | { canceled: false; path: string }>>
    /** Open-dialog import of a backup file; upserts, never duplicates. */
    import(): Promise<IpcResult<{ canceled: true } | ({ canceled: false } & BackupSummary)>>
  }
  spaces: {
    list(): Promise<IpcResult<Space[]>>
    create(name: string): Promise<IpcResult<Space>>
    update(id: string, patch: SpacePatch): Promise<IpcResult<Space>>
    /** Refused (invalid_request) while the space still contains conversations. */
    delete(id: string): Promise<IpcResult<void>>
  }
  lock: {
    /** Exempt from the lock gate (the lock screen needs it while locked). */
    status(): Promise<IpcResult<AppLockStatus>>
    /** Exempt from the lock gate; 'auth' error on a wrong passphrase. */
    unlock(passphrase: string): Promise<IpcResult<AppLockStatus>>
    lockNow(): Promise<IpcResult<AppLockStatus>>
    /** Set/change/remove the passphrase (current required once configured). */
    setPassphrase(input: AppLockSetPassphraseInput): Promise<IpcResult<AppLockStatus>>
    /** Fires when the lock engages or releases; returns unsubscribe. */
    onChanged(cb: (evt: { locked: boolean }) => void): () => void
  }
  mcp: {
    list(): Promise<IpcResult<McpServerConfig[]>>
    /** Secret env/headers are encrypted in main and never returned. */
    create(input: McpServerInput): Promise<IpcResult<McpServerConfig[]>>
    update(id: string, patch: McpServerPatch): Promise<IpcResult<McpServerConfig[]>>
    delete(id: string): Promise<IpcResult<McpServerConfig[]>>
    setEnabled(id: string, enabled: boolean): Promise<IpcResult<McpServerConfig[]>>
    reconnect(id: string): Promise<IpcResult<McpServerRuntime[]>>
    status(): Promise<IpcResult<McpServerRuntime[]>>
    onServersChanged(cb: (runtime: McpServerRuntime[]) => void): () => void
  }
  im: {
    status(): Promise<IpcResult<ImBridgeStatus>>
    /** Token travels to main once, is encrypted immediately, never returned. */
    setTelegram(input: SetTelegramBridgeInput): Promise<IpcResult<ImBridgeStatus>>
    setWebhook(url: string | null): Promise<IpcResult<ImBridgeStatus>>
  }
  remote: {
    status(): Promise<IpcResult<RemoteStatus>>
    setConfig(input: RemoteSetConfigInput): Promise<IpcResult<RemoteStatus>>
    /**
     * Opens a pairing offer (returns the QR URL + expiry) or cancels the
     * current one (false). The pairing secret is minted main-side and lives
     * only in that URL and in memory — never stored.
     */
    pair(open: boolean): Promise<IpcResult<RemoteStatus>>
    revoke(deviceId: string): Promise<IpcResult<RemoteStatus>>
    /** Fires whenever tunnel/device state changes; returns unsubscribe. */
    onChanged(cb: () => void): () => void
  }
  workflows: {
    list(): Promise<IpcResult<Workflow[]>>
    get(id: string): Promise<IpcResult<Workflow | null>>
    create(input: WorkflowInput): Promise<IpcResult<Workflow>>
    /**
     * True patch: only the keys present are written, the rest keep their
     * stored values. Send just what you mean to change — echoing fields back
     * from a cached snapshot risks writing a stale name or graph over the
     * stored one. The builder sends a whole WorkflowInput, which is still a
     * valid patch.
     */
    update(id: string, patch: Partial<WorkflowInput>): Promise<IpcResult<Workflow>>
    delete(id: string): Promise<IpcResult<void>>
    /**
     * Runs the given graph (the live editor state) and returns per-node
     * output. `dryRun` stubs side effects: HTTP requests report what they
     * would send, notifications are swallowed, AI routes to the economy model.
     */
    run(graph: WorkflowGraph, opts?: { dryRun?: boolean }): Promise<IpcResult<WorkflowRunResult>>
    /** Runs a SAVED workflow and records the execution in its run history. */
    runById(id: string): Promise<IpcResult<WorkflowRunResult>>
    /** Recent persisted executions, newest first. */
    runs(id: string): Promise<IpcResult<WorkflowRun[]>>
    /** Scheduled workflows with latest-run status + recent runs (Home/sidebar). */
    overview(): Promise<IpcResult<WorkflowsOverview>>
    /** Fires whenever a saved-workflow run is persisted; returns unsubscribe. */
    onRunFinished(cb: (evt: WorkflowRunFinishedEvent) => void): () => void
    /** State of the local trigger endpoint and the URL to point a hook at. */
    triggerInfo(workflowId?: string): Promise<IpcResult<WorkflowTriggerInfo>>
    /** Mints a fresh endpoint token, invalidating the previous one. */
    triggerRegenerate(): Promise<IpcResult<WorkflowTriggerInfo>>
    /** Live state of this workflow's folder watch (running, or its last error). */
    watchInfo(workflowId: string): Promise<IpcResult<WorkflowWatchStatus>>
  }
  scheduledTasks: {
    list(): Promise<IpcResult<ScheduledTask[]>>
    create(input: ScheduledTaskInput): Promise<IpcResult<ScheduledTask>>
    setEnabled(id: string, enabled: boolean): Promise<IpcResult<ScheduledTask>>
    /** Sets/clears the task's monthly spend cap (USD). */
    setBudget(id: string, budgetUsd: number | null): Promise<IpcResult<ScheduledTask>>
    delete(id: string): Promise<IpcResult<void>>
      onChanged(cb: (event: ScheduledTasksChangedEvent) => void): () => void
    /** Recorded runs for one task, newest first. */
    runs(taskId: string): Promise<IpcResult<ScheduledTaskRun[]>>
  }
  agents: {
    list(): Promise<IpcResult<AgentProfile[]>>
    create(input: AgentProfileInput): Promise<IpcResult<AgentProfile>>
    update(id: string, patch: AgentProfilePatch): Promise<IpcResult<AgentProfile>>
    delete(id: string): Promise<IpcResult<void>>
    runs(conversationId?: string): Promise<IpcResult<AgentRun[]>>
    stopRun(runId: string): Promise<IpcResult<boolean>>
    packExport(): Promise<IpcResult<{ canceled: boolean; path?: string }>>
    packImport(): Promise<IpcResult<{ canceled: boolean; agents?: number; skills?: number; hooks?: number }>>
  }
  /** Bot Mode (v46): the Bots pane roster, canonical chats and group rooms. */
  bots: {
    roster(): Promise<IpcResult<BotRoster>>
    /** Get-or-create the bot's canonical chat; returns its conversation id. */
    openChat(agentId: string): Promise<IpcResult<{ conversationId: string }>>
    /** Recent bot-to-bot deliveries touching a bot, newest first (v48). */
    outbox(agentId: string): Promise<IpcResult<A2aOutboxEntry[]>>
    createGroup(input: {
      name: string
      memberIds: string[]
      activation?: BotGroupActivation
      observerIds?: string[]
    }): Promise<IpcResult<BotGroup>>
    updateGroup(
      id: string,
      patch: {
        name?: string
        memberIds?: string[]
        activation?: BotGroupActivation
        observerIds?: string[]
      }
    ): Promise<IpcResult<BotGroup>>
    deleteGroup(id: string): Promise<IpcResult<void>>
    /** Post a user message into a room; rounds run detached (push events). */
    groupSend(groupId: string, content: string): Promise<IpcResult<void>>
    groupStop(groupId: string): Promise<IpcResult<void>>
    /** Clears the room's needs-you badge. */
    groupMarkSeen(groupId: string): Promise<IpcResult<void>>
    /** External Telegram presence (v47). Null = the bot has no binding yet. */
    binding(agentId: string): Promise<IpcResult<BotBinding | null>>
    /** Stores the bot token (encrypted main-side) and arms a pairing code. */
    bindingSetToken(agentId: string, token: string): Promise<IpcResult<BotBinding>>
    bindingSetEnabled(agentId: string, enabled: boolean): Promise<IpcResult<BotBinding>>
    /** Unpairs and arms a fresh one-time pairing code. */
    bindingRepair(agentId: string): Promise<IpcResult<BotBinding>>
    /** Removes the binding and its stored token. */
    bindingClearToken(agentId: string): Promise<IpcResult<void>>
    bindingUpdateGroup(
      agentId: string,
      groupId: string,
      patch: { activation?: BotGroupActivation; remove?: boolean }
    ): Promise<IpcResult<BotBinding>>
    onChanged(
      cb: (event: { agentId?: string | null; groupId?: string | null }) => void
    ): () => void
  }
  knowledge: {
    list(): Promise<IpcResult<KnowledgeBase[]>>
    create(input: KnowledgeBaseInput): Promise<IpcResult<KnowledgeBase>>
    delete(id: string): Promise<IpcResult<void>>
    /** Opens a file picker and imports the chosen files' text into the base. */
    importFiles(
      id: string
    ): Promise<IpcResult<{ canceled: boolean; imported: number; chunks: number; skipped: number }>>
    sources(id: string): Promise<IpcResult<Array<{ source: string; chunks: number }>>>
    removeSource(id: string, source: string): Promise<IpcResult<void>>
  }
}

declare global {
  interface Window {
    uld: UldApi
  }
}
