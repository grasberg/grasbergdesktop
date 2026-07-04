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
  AppInfo,
  AppSettings,
  Attachment,
  ChatParams,
  CodeChange,
  CodeProject,
  Conversation,
  ConversationMode,
  ConversationSummary,
  CustomToolInfo,
  CustomToolInput,
  CustomToolPatch,
  Document,
  DocumentExportFormat,
  FileTreeNode,
  ImBridgeStatus,
  McpServerConfig,
  McpServerInput,
  McpServerPatch,
  McpServerRuntime,
  SetTelegramBridgeInput,
  Workflow,
  WorkflowGraph,
  WorkflowInput,
  WorkflowRunResult,
  Message,
  ModelInfo,
  NormalizedError,
  ProviderConfig,
  ProviderConfigInput,
  ProviderConfigPatch,
  ProviderTypeMeta,
  PromptTemplate,
  PromptTemplateInput,
  PromptTemplatePatch,
  StartStreamResult,
  StreamEventEnvelope,
  TestConnectionResult,
  ToolApprovalRequest,
  ToolDefinition,
  ToolPermission,
  ToolPermissionDecision,
  Workspace,
  WorkspaceItem,
  WorkspaceItemKind,
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
  appReadAttachment: 'app:readAttachment',

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

  // conversations
  convList: 'conv:list',
  convCreate: 'conv:create',
  convGet: 'conv:get',
  convUpdate: 'conv:update',
  convDelete: 'conv:delete',
  convMessages: 'conv:messages',
  convExport: 'conv:export',

  // chat generation
  chatSend: 'chat:send',
  chatStop: 'chat:stop',
  chatRegenerate: 'chat:regenerate',
  chatEditAndRerun: 'chat:editAndRerun',

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

  // code mode
  codeProjectsList: 'code:projects:list',
  codeProjectOpen: 'code:projects:open',
  codeProjectForget: 'code:projects:forget',
  codeFileTree: 'code:fileTree',
  codeReadFile: 'code:readFile',
  codeChangesList: 'code:changes:list',
  codeChangeApply: 'code:changes:apply',
  codeChangeReject: 'code:changes:reject',

  // tools
  toolsList: 'tools:list',
  toolsSetEnabled: 'tools:setEnabled',
  toolsPermissionsList: 'tools:permissions:list',
  toolsPermissionSet: 'tools:permissions:set',
  toolsApprovalRespond: 'tools:approval:respond',
  toolsCustomList: 'tools:custom:list',
  toolsCustomCreate: 'tools:custom:create',
  toolsCustomUpdate: 'tools:custom:update',
  toolsCustomDelete: 'tools:custom:delete',

  // prompt library
  promptsList: 'prompts:list',
  promptsCreate: 'prompts:create',
  promptsUpdate: 'prompts:update',
  promptsDelete: 'prompts:delete',

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

  // Write / Design documents
  documentsGet: 'documents:get',
  documentsSave: 'documents:save',
  documentsListHtml: 'documents:listHtml',
  documentsExport: 'documents:export',

  // Workflows
  workflowsList: 'workflows:list',
  workflowsGet: 'workflows:get',
  workflowsCreate: 'workflows:create',
  workflowsUpdate: 'workflows:update',
  workflowsDelete: 'workflows:delete',
  workflowsRun: 'workflows:run',

  // push channels (main -> renderer, via webContents.send)
  streamEvent: 'push:streamEvent',
  toolApprovalRequest: 'push:toolApprovalRequest',
  /** Sent when a pending approval was settled main-side (timeout, abort, respond). */
  toolApprovalSettled: 'push:toolApprovalSettled',
  conversationsChanged: 'push:conversationsChanged',
  /** Sent with McpServerRuntime[] whenever MCP connection state changes. */
  mcpServersChanged: 'push:mcpServersChanged',
} as const

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS]

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

export interface ConvListRequest {
  mode?: ConversationMode
  /** Case-insensitive search over title and message content. */
  search?: string
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
}

export interface ConvUpdateRequest {
  id: string
  patch: Partial<{
    title: string
    providerId: string | null
    modelId: string | null
    systemPrompt: string | null
    params: ChatParams
    /** Link/unlink a cowork workspace (cowork mode). */
    workspaceId: string | null
    /** Link/unlink a code project (code mode). */
    projectId: string | null
  }>
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
  overrides?: { providerId?: string; modelId?: string; params?: ChatParams }
}

export interface ChatRegenerateRequest {
  conversationId: string
  /** The assistant message to regenerate (it is replaced). */
  messageId: string
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

export interface CodeReadFileResult {
  relPath: string
  content: string
  truncated: boolean
  sizeBytes: number
}

export interface PickFilesResult {
  attachments: Attachment[]
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
    /** Reads a stored image attachment as a data URL (null when missing). */
    readAttachment(storageKey: string): Promise<IpcResult<{ dataUrl: string } | null>>
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
  }
  chat: {
    send(req: ChatSendRequest): Promise<IpcResult<StartStreamResult>>
    stop(streamId: string): Promise<IpcResult<void>>
    regenerate(req: ChatRegenerateRequest): Promise<IpcResult<StartStreamResult>>
    editAndRerun(req: ChatEditAndRerunRequest): Promise<IpcResult<StartStreamResult>>
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
    fileTree(projectId: string): Promise<IpcResult<FileTreeNode>>
    readFile(req: CodeReadFileRequest): Promise<IpcResult<CodeReadFileResult>>
    changesList(projectId: string): Promise<IpcResult<CodeChange[]>>
    /** Applies a proposed change to disk — only ever called from an explicit user click. */
    changeApply(changeId: string): Promise<IpcResult<CodeChange>>
    changeReject(changeId: string): Promise<IpcResult<CodeChange>>
  }
  tools: {
    list(): Promise<IpcResult<ToolDefinition[]>>
    setEnabled(toolId: string, enabled: boolean): Promise<IpcResult<void>>
    permissionsList(): Promise<IpcResult<ToolPermission[]>>
    permissionSet(toolId: string, decision: ToolPermissionDecision): Promise<IpcResult<void>>
    approvalRespond(requestId: string, approved: boolean): Promise<IpcResult<void>>
    onApprovalRequest(cb: (req: ToolApprovalRequest) => void): () => void
    /** Fires with the requestId whenever main settles an approval (respond/timeout/abort). */
    onApprovalSettled(cb: (requestId: string) => void): () => void
    /** Custom HTTP tools: full details for the edit form (values excluded). */
    customList(): Promise<IpcResult<CustomToolInfo[]>>
    /** Secret header values are encrypted in main and never returned. */
    customCreate(input: CustomToolInput): Promise<IpcResult<CustomToolInfo[]>>
    customUpdate(toolId: string, patch: CustomToolPatch): Promise<IpcResult<CustomToolInfo[]>>
    customDelete(toolId: string): Promise<IpcResult<CustomToolInfo[]>>
  }
  prompts: {
    list(): Promise<IpcResult<PromptTemplate[]>>
    create(input: PromptTemplateInput): Promise<IpcResult<PromptTemplate>>
    update(id: string, patch: PromptTemplatePatch): Promise<IpcResult<PromptTemplate>>
    delete(id: string): Promise<IpcResult<void>>
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
  documents: {
    /** The Write-mode document for a conversation (null if none yet). */
    get(conversationId: string): Promise<IpcResult<Document | null>>
    /** Create/replace the Write document's content. */
    save(conversationId: string, content: string): Promise<IpcResult<Document>>
    /** Design-mode HTML prototypes for a conversation, newest first. */
    listHtml(conversationId: string): Promise<IpcResult<Document[]>>
    export(
      id: string,
      format: DocumentExportFormat
    ): Promise<IpcResult<{ canceled: boolean; path?: string }>>
  }
  workflows: {
    list(): Promise<IpcResult<Workflow[]>>
    get(id: string): Promise<IpcResult<Workflow | null>>
    create(input: WorkflowInput): Promise<IpcResult<Workflow>>
    update(id: string, input: WorkflowInput): Promise<IpcResult<Workflow>>
    delete(id: string): Promise<IpcResult<void>>
    /** Runs the given graph (the live editor state) and returns per-node output. */
    run(graph: WorkflowGraph): Promise<IpcResult<WorkflowRunResult>>
  }
}

declare global {
  interface Window {
    uld: UldApi
  }
}
