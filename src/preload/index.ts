/**
 * Preload bridge: exposes the typed UldApi as window.uld. Pure forwarding —
 * every method maps 1:1 to an ipcRenderer.invoke on a CHANNELS entry, and the
 * two push channels get subscribe/unsubscribe wrappers. No logic lives here.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CHANNELS, type ChannelName, type UldApi } from '@shared/ipc'
import type { McpServerRuntime, StreamEventEnvelope, ToolApprovalRequest, UserQuestionRequest } from '@shared/types'

/** Subscribe wrapper for a push channel: `cb` gets the payload, returns unsubscribe. */
const subscribe =
  <T>(channel: ChannelName) =>
  (cb: (payload: T) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: T): void => {
      cb(payload)
    }
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }

const api: UldApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(CHANNELS.appGetInfo),
    pickFolder: () => ipcRenderer.invoke(CHANNELS.appPickFolder),
    pickFiles: () => ipcRenderer.invoke(CHANNELS.appPickFiles),
    readAttachment: (storageKey) => ipcRenderer.invoke(CHANNELS.appReadAttachment, storageKey),
  },
  settings: {
    get: () => ipcRenderer.invoke(CHANNELS.settingsGet),
    update: (patch) => ipcRenderer.invoke(CHANNELS.settingsUpdate, patch),
  },
  providers: {
    listTypes: () => ipcRenderer.invoke(CHANNELS.providersListTypes),
    list: () => ipcRenderer.invoke(CHANNELS.providersList),
    create: (input) => ipcRenderer.invoke(CHANNELS.providersCreate, input),
    update: (id, patch) => ipcRenderer.invoke(CHANNELS.providersUpdate, id, patch),
    delete: (id) => ipcRenderer.invoke(CHANNELS.providersDelete, id),
    setKey: (id, apiKey) => ipcRenderer.invoke(CHANNELS.providersSetKey, id, apiKey),
    deleteKey: (id) => ipcRenderer.invoke(CHANNELS.providersDeleteKey, id),
    test: (id) => ipcRenderer.invoke(CHANNELS.providersTest, id),
    listModels: (id) => ipcRenderer.invoke(CHANNELS.providersListModels, id),
    oauthStart: (id) => ipcRenderer.invoke(CHANNELS.providersOauthStart, id),
    oauthLogout: (id) => ipcRenderer.invoke(CHANNELS.providersOauthLogout, id),
    oauthStatus: (id) => ipcRenderer.invoke(CHANNELS.providersOauthStatus, id),
  },
  conversations: {
    list: (req) => ipcRenderer.invoke(CHANNELS.convList, req),
    create: (req) => ipcRenderer.invoke(CHANNELS.convCreate, req),
    get: (id) => ipcRenderer.invoke(CHANNELS.convGet, id),
    update: (req) => ipcRenderer.invoke(CHANNELS.convUpdate, req),
    delete: (id) => ipcRenderer.invoke(CHANNELS.convDelete, id),
    messages: (conversationId) => ipcRenderer.invoke(CHANNELS.convMessages, conversationId),
    export: (req) => ipcRenderer.invoke(CHANNELS.convExport, req),
  },
  chat: {
    send: (req) => ipcRenderer.invoke(CHANNELS.chatSend, req),
    stop: (streamId) => ipcRenderer.invoke(CHANNELS.chatStop, streamId),
    regenerate: (req) => ipcRenderer.invoke(CHANNELS.chatRegenerate, req),
    editAndRerun: (req) => ipcRenderer.invoke(CHANNELS.chatEditAndRerun, req),
    onStreamEvent: subscribe<StreamEventEnvelope>(CHANNELS.streamEvent),
  },
  workspaces: {
    list: () => ipcRenderer.invoke(CHANNELS.workspaceList),
    create: (input) => ipcRenderer.invoke(CHANNELS.workspaceCreate, input),
    get: (id) => ipcRenderer.invoke(CHANNELS.workspaceGet, id),
    update: (id, patch) => ipcRenderer.invoke(CHANNELS.workspaceUpdate, id, patch),
    delete: (id) => ipcRenderer.invoke(CHANNELS.workspaceDelete, id),
    itemsList: (workspaceId) => ipcRenderer.invoke(CHANNELS.workspaceItemsList, workspaceId),
    itemCreate: (input) => ipcRenderer.invoke(CHANNELS.workspaceItemCreate, input),
    itemUpdate: (id, patch) => ipcRenderer.invoke(CHANNELS.workspaceItemUpdate, id, patch),
    itemDelete: (id) => ipcRenderer.invoke(CHANNELS.workspaceItemDelete, id),
  },
  code: {
    projectsList: () => ipcRenderer.invoke(CHANNELS.codeProjectsList),
    projectOpen: (path) => ipcRenderer.invoke(CHANNELS.codeProjectOpen, path),
    projectForget: (id) => ipcRenderer.invoke(CHANNELS.codeProjectForget, id),
    fileTree: (projectId) => ipcRenderer.invoke(CHANNELS.codeFileTree, projectId),
    readFile: (req) => ipcRenderer.invoke(CHANNELS.codeReadFile, req),
    changesList: (projectId) => ipcRenderer.invoke(CHANNELS.codeChangesList, projectId),
    changeApply: (changeId) => ipcRenderer.invoke(CHANNELS.codeChangeApply, changeId),
    changeReject: (changeId) => ipcRenderer.invoke(CHANNELS.codeChangeReject, changeId),
  },
  tools: {
    list: () => ipcRenderer.invoke(CHANNELS.toolsList),
    setEnabled: (toolId, enabled) => ipcRenderer.invoke(CHANNELS.toolsSetEnabled, toolId, enabled),
    permissionsList: () => ipcRenderer.invoke(CHANNELS.toolsPermissionsList),
    permissionSet: (toolId, decision) =>
      ipcRenderer.invoke(CHANNELS.toolsPermissionSet, toolId, decision),
    approvalRespond: (requestId, approved) =>
      ipcRenderer.invoke(CHANNELS.toolsApprovalRespond, requestId, approved),
    customList: () => ipcRenderer.invoke(CHANNELS.toolsCustomList),
    customCreate: (input) => ipcRenderer.invoke(CHANNELS.toolsCustomCreate, input),
    customUpdate: (toolId, patch) => ipcRenderer.invoke(CHANNELS.toolsCustomUpdate, toolId, patch),
    customDelete: (toolId) => ipcRenderer.invoke(CHANNELS.toolsCustomDelete, toolId),
    onApprovalRequest: subscribe<ToolApprovalRequest>(CHANNELS.toolApprovalRequest),
    onApprovalSettled: subscribe<string>(CHANNELS.toolApprovalSettled),
    questionRespond: (requestId, answer) =>
      ipcRenderer.invoke(CHANNELS.toolsQuestionRespond, requestId, answer),
    onQuestionRequest: subscribe<UserQuestionRequest>(CHANNELS.userQuestionRequest),
    onQuestionSettled: subscribe<string>(CHANNELS.userQuestionSettled),
  },
  prompts: {
    list: () => ipcRenderer.invoke(CHANNELS.promptsList),
    create: (input) => ipcRenderer.invoke(CHANNELS.promptsCreate, input),
    update: (id, patch) => ipcRenderer.invoke(CHANNELS.promptsUpdate, id, patch),
    delete: (id) => ipcRenderer.invoke(CHANNELS.promptsDelete, id),
  },
  memories: {
    list: () => ipcRenderer.invoke(CHANNELS.memoriesList),
    create: (input) => ipcRenderer.invoke(CHANNELS.memoriesCreate, input),
    update: (id, patch) => ipcRenderer.invoke(CHANNELS.memoriesUpdate, id, patch),
    delete: (id) => ipcRenderer.invoke(CHANNELS.memoriesDelete, id),
  },
  skills: {
    list: () => ipcRenderer.invoke(CHANNELS.skillsList),
    create: (input) => ipcRenderer.invoke(CHANNELS.skillsCreate, input),
    update: (id, patch) => ipcRenderer.invoke(CHANNELS.skillsUpdate, id, patch),
    delete: (id) => ipcRenderer.invoke(CHANNELS.skillsDelete, id),
    importFolder: (path) => ipcRenderer.invoke(CHANNELS.skillsImportFolder, path),
  },
  backup: {
    export: () => ipcRenderer.invoke(CHANNELS.backupExport),
    import: () => ipcRenderer.invoke(CHANNELS.backupImport),
  },
  mcp: {
    list: () => ipcRenderer.invoke(CHANNELS.mcpList),
    create: (input) => ipcRenderer.invoke(CHANNELS.mcpCreate, input),
    update: (id, patch) => ipcRenderer.invoke(CHANNELS.mcpUpdate, id, patch),
    delete: (id) => ipcRenderer.invoke(CHANNELS.mcpDelete, id),
    setEnabled: (id, enabled) => ipcRenderer.invoke(CHANNELS.mcpSetEnabled, id, enabled),
    reconnect: (id) => ipcRenderer.invoke(CHANNELS.mcpReconnect, id),
    status: () => ipcRenderer.invoke(CHANNELS.mcpStatus),
    onServersChanged: subscribe<McpServerRuntime[]>(CHANNELS.mcpServersChanged),
  },
  im: {
    status: () => ipcRenderer.invoke(CHANNELS.imStatus),
    setTelegram: (input) => ipcRenderer.invoke(CHANNELS.imSetTelegram, input),
    setWebhook: (url) => ipcRenderer.invoke(CHANNELS.imSetWebhook, url),
  },
  documents: {
    get: (conversationId) => ipcRenderer.invoke(CHANNELS.documentsGet, conversationId),
    save: (conversationId, content) => ipcRenderer.invoke(CHANNELS.documentsSave, conversationId, content),
    listHtml: (conversationId) => ipcRenderer.invoke(CHANNELS.documentsListHtml, conversationId),
    export: (id, format) => ipcRenderer.invoke(CHANNELS.documentsExport, id, format),
  },
  workflows: {
    list: () => ipcRenderer.invoke(CHANNELS.workflowsList),
    get: (id) => ipcRenderer.invoke(CHANNELS.workflowsGet, id),
    create: (input) => ipcRenderer.invoke(CHANNELS.workflowsCreate, input),
    update: (id, input) => ipcRenderer.invoke(CHANNELS.workflowsUpdate, id, input),
    delete: (id) => ipcRenderer.invoke(CHANNELS.workflowsDelete, id),
    run: (graph) => ipcRenderer.invoke(CHANNELS.workflowsRun, graph),
  },
}

contextBridge.exposeInMainWorld('uld', api)
