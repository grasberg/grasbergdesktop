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
  AppSettings,
  Attachment,
  AuthMode,
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
  DreamResult,
  BackupSummary,
  SetTelegramBridgeInput,
  Skill,
  SkillInput,
  SkillPatch,
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
  ResearchDepth,
  ActivityEntry,
  ActivityQuery,
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTasksChangedEvent,
  WorkflowTriggerInfo,
  ScheduledTaskInput,
  PromptTemplate,
  PromptTemplateInput,
  PromptTemplatePatch,
  StartStreamResult,
  StreamEventEnvelope,
  ArenaStartRequest,
  ArenaState,
  InboxItem,
  InboxItemType,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSessionInfo,
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

  // Standalone scheduled tasks (clock menu; independent from workflows)
  scheduledTasksList: 'scheduledTasks:list',
  scheduledTasksCreate: 'scheduledTasks:create',
  scheduledTasksSetEnabled: 'scheduledTasks:setEnabled',
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

  // agent inbox (unified review queue for background results)
  inboxList: 'inbox:list',
  inboxMarkReviewed: 'inbox:markReviewed',

  // usage (local, estimate-only spend summary)
  usageSummary: 'usage:summary',

  // terminal (user-driven Work-view terminal; sessions are per conversation)
  terminalCreate: 'terminal:create',
  terminalInput: 'terminal:input',
  terminalDispose: 'terminal:dispose',

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
  /** Standing approval rules changed (an approval answer created one). */
  toolRulesChanged: 'push:toolRulesChanged',
  /** A main-side notice for the user (e.g. the trigger endpoint failed to bind). */
  mainNotice: 'push:mainNotice',
  /** Sent with { arena: ArenaState } on every arena/candidate state change. */
  arenaChanged: 'push:arenaChanged',
  /** Sent with TerminalDataEvent for every terminal output chunk. */
  terminalData: 'push:terminalData',
  /** Sent with TerminalExitEvent when a terminal session's shell exits. */
  terminalExit: 'push:terminalExit',
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
    fork(id: string, throughSeq?: number): Promise<IpcResult<Conversation>>
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
    send(req: ChatSendRequest): Promise<IpcResult<StartStreamResult>>
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
  }
  inbox: {
    /** Unified review queue: finished background results, newest first. */
    list(): Promise<IpcResult<InboxItem[]>>
    markReviewed(itemType: InboxItemType, itemId: string): Promise<IpcResult<void>>
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
    list(query?: ActivityQuery): Promise<IpcResult<{ entries: ActivityEntry[]; total: number }>>
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
  skills: {
    list(): Promise<IpcResult<Skill[]>>
    create(input: SkillInput): Promise<IpcResult<Skill>>
    update(id: string, patch: SkillPatch): Promise<IpcResult<Skill>>
    delete(id: string): Promise<IpcResult<void>>
    /** Imports every skill in a folder (skill / collection / plugin). */
    importFolder(path: string): Promise<IpcResult<Skill[]>>
  }
  backup: {
    /** Save-dialog export of settings + memories + skills (never secrets). */
    export(): Promise<IpcResult<{ canceled: true } | { canceled: false; path: string }>>
    /** Open-dialog import of a backup file; upserts, never duplicates. */
    import(): Promise<IpcResult<{ canceled: true } | ({ canceled: false } & BackupSummary)>>
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
  workflows: {
    list(): Promise<IpcResult<Workflow[]>>
    get(id: string): Promise<IpcResult<Workflow | null>>
    create(input: WorkflowInput): Promise<IpcResult<Workflow>>
    update(id: string, input: WorkflowInput): Promise<IpcResult<Workflow>>
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
  }
  scheduledTasks: {
    list(): Promise<IpcResult<ScheduledTask[]>>
    create(input: ScheduledTaskInput): Promise<IpcResult<ScheduledTask>>
    setEnabled(id: string, enabled: boolean): Promise<IpcResult<ScheduledTask>>
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
