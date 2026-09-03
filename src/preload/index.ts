/**
 * Preload bridge: exposes the typed UldApi as window.uld. Pure forwarding —
 * every method maps 1:1 to an ipcRenderer.invoke on a CHANNELS entry, and the
 * two push channels get subscribe/unsubscribe wrappers. No logic lives here.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CHANNELS, type ChannelName, type NavigateTarget, type UldApi } from '@shared/ipc'
import type {
  ArenaState,
  McpServerRuntime,
  MorningBrief,
  OptimizerRun,
  QuickContext,
  QuickStreamEventEnvelope,
  StreamEventEnvelope,
  TerminalDataEvent,
  TerminalExitEvent,
  ToolApprovalRequest,
  VoiceDownloadProgressEvent,
  UserQuestionRequest,
  WorkflowRunFinishedEvent,
} from '@shared/types'

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
    storePastedImage: (input) => ipcRenderer.invoke(CHANNELS.appStorePastedImage, input),
    readAttachment: (storageKey) => ipcRenderer.invoke(CHANNELS.appReadAttachment, storageKey),
    extractAttachmentText: (input) =>
      ipcRenderer.invoke(CHANNELS.appExtractAttachmentText, input),
    saveAttachmentAs: (storageKey, suggestedName) =>
      ipcRenderer.invoke(CHANNELS.appSaveAttachmentAs, { storageKey, suggestedName }),
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
    previewModels: (input) => ipcRenderer.invoke(CHANNELS.providersPreviewModels, input),
    detectLocal: () => ipcRenderer.invoke(CHANNELS.providersDetectLocal),
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
    fork: (id, messageId) => ipcRenderer.invoke(CHANNELS.convFork, { id, messageId }),
    forkLineage: (id) => ipcRenderer.invoke(CHANNELS.convForkLineage, id),
    onConversationsChanged: subscribe<{ conversationId: string }>(CHANNELS.conversationsChanged),
  },
  projects: {
    list: (req) => ipcRenderer.invoke(CHANNELS.projectsList, req),
    create: (input) => ipcRenderer.invoke(CHANNELS.projectsCreate, input),
    update: (id, patch) => ipcRenderer.invoke(CHANNELS.projectsUpdate, id, patch),
    delete: (id) => ipcRenderer.invoke(CHANNELS.projectsDelete, id),
  },
  data: {
    deleteAllContent: () => ipcRenderer.invoke(CHANNELS.dataDeleteAllContent),
  },
  chat: {
    send: (req) => ipcRenderer.invoke(CHANNELS.chatSend, req),
    stop: (streamId) => ipcRenderer.invoke(CHANNELS.chatStop, streamId),
    regenerate: (req) => ipcRenderer.invoke(CHANNELS.chatRegenerate, req),
    editAndRerun: (req) => ipcRenderer.invoke(CHANNELS.chatEditAndRerun, req),
    compact: (conversationId) => ipcRenderer.invoke(CHANNELS.chatCompact, conversationId),
    pickCompareWinner: (req) => ipcRenderer.invoke(CHANNELS.chatPickCompareWinner, req),
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
    projectReveal: (id) => ipcRenderer.invoke(CHANNELS.codeProjectReveal, id),
    fileTree: (projectId) => ipcRenderer.invoke(CHANNELS.codeFileTree, projectId),
    readFile: (req) => ipcRenderer.invoke(CHANNELS.codeReadFile, req),
    changesList: (projectId) => ipcRenderer.invoke(CHANNELS.codeChangesList, projectId),
    changeApply: (changeId) => ipcRenderer.invoke(CHANNELS.codeChangeApply, changeId),
    changeReject: (changeId) => ipcRenderer.invoke(CHANNELS.codeChangeReject, changeId),
    changeRevert: (changeId) => ipcRenderer.invoke(CHANNELS.codeChangeRevert, changeId),
    changesListAll: (projectId) => ipcRenderer.invoke(CHANNELS.codeChangesListAll, projectId),
    suggestFiles: (req) => ipcRenderer.invoke(CHANNELS.codeSuggestFiles, req),
    onChangesChanged: subscribe(CHANNELS.codeChangesChanged),
    gitStatus: (projectId) => ipcRenderer.invoke(CHANNELS.codeGitStatus, projectId),
    gitStage: (projectId, paths) =>
      ipcRenderer.invoke(CHANNELS.codeGitStage, { projectId, paths }),
    gitUnstage: (projectId, paths) =>
      ipcRenderer.invoke(CHANNELS.codeGitUnstage, { projectId, paths }),
    gitCommit: (projectId, message) =>
      ipcRenderer.invoke(CHANNELS.codeGitCommit, { projectId, message }),
    gitCreateBranch: (projectId, name) =>
      ipcRenderer.invoke(CHANNELS.codeGitCreateBranch, { projectId, name }),
    gitFetch: (projectId) => ipcRenderer.invoke(CHANNELS.codeGitFetch, projectId),
    gitSetOrigin: (projectId, url) =>
      ipcRenderer.invoke(CHANNELS.codeGitSetOrigin, { projectId, url }),
    gitPull: (projectId) => ipcRenderer.invoke(CHANNELS.codeGitPull, projectId),
    gitPush: (projectId, confirmDefaultBranch) =>
      ipcRenderer.invoke(CHANNELS.codeGitPush, { projectId, confirmDefaultBranch }),
    githubPrCreate: (projectId, input) =>
      ipcRenderer.invoke(CHANNELS.codeGithubPrCreate, { projectId, input }),
    gitGenerateCommitMessage: (projectId) =>
      ipcRenderer.invoke(CHANNELS.codeGitGenerateCommitMessage, projectId),
    worktreeCreate: (projectId, name) =>
      ipcRenderer.invoke(CHANNELS.codeWorktreeCreate, { projectId, name }),
    openInIde: (projectId) => ipcRenderer.invoke(CHANNELS.codeOpenInIde, projectId),
    checkpointsList: (conversationId) =>
      ipcRenderer.invoke(CHANNELS.codeCheckpointsList, conversationId),
    checkpointRestore: (checkpointId) =>
      ipcRenderer.invoke(CHANNELS.codeCheckpointRestore, checkpointId),
    revertTurn: (req) => ipcRenderer.invoke(CHANNELS.codeTurnRevert, req),
  },
  usage: {
    summary: (days) => ipcRenderer.invoke(CHANNELS.usageSummary, days),
    conversationCost: (conversationId) =>
      ipcRenderer.invoke(CHANNELS.usageConversationCost, conversationId),
    headlessSummary: (days) => ipcRenderer.invoke(CHANNELS.usageHeadless, days),
  },
  inbox: {
    list: () => ipcRenderer.invoke(CHANNELS.inboxList),
    markReviewed: (itemType, itemId) =>
      ipcRenderer.invoke(CHANNELS.inboxMarkReviewed, { itemType, itemId }),
  },
  brief: {
    list: () => ipcRenderer.invoke(CHANNELS.briefList),
    dismiss: (id) => ipcRenderer.invoke(CHANNELS.briefDismiss, id),
    onChanged: subscribe<{ brief: MorningBrief }>(CHANNELS.briefChanged),
  },
  arena: {
    start: (req) => ipcRenderer.invoke(CHANNELS.arenaStart, req),
    status: (conversationId) => ipcRenderer.invoke(CHANNELS.arenaStatus, conversationId),
    apply: (conversationId, runId) =>
      ipcRenderer.invoke(CHANNELS.arenaApply, { conversationId, runId }),
    stop: (conversationId) => ipcRenderer.invoke(CHANNELS.arenaStop, conversationId),
    discard: (conversationId) => ipcRenderer.invoke(CHANNELS.arenaDiscard, conversationId),
    onChanged: subscribe<{ arena: ArenaState }>(CHANNELS.arenaChanged),
  },
  optimizer: {
    start: (input) => ipcRenderer.invoke(CHANNELS.optimizerStart, input),
    stop: (runId) => ipcRenderer.invoke(CHANNELS.optimizerStop, runId),
    list: () => ipcRenderer.invoke(CHANNELS.optimizerList),
    versions: (runId) => ipcRenderer.invoke(CHANNELS.optimizerVersions, runId),
    onChanged: subscribe<{ run: OptimizerRun }>(CHANNELS.optimizerChanged),
  },
  experiments: {
    list: (projectId) => ipcRenderer.invoke(CHANNELS.experimentsList, projectId),
  },
  terminal: {
    create: (conversationId) => ipcRenderer.invoke(CHANNELS.terminalCreate, conversationId),
    input: (sessionId, data) => ipcRenderer.invoke(CHANNELS.terminalInput, { sessionId, data }),
    dispose: (sessionId) => ipcRenderer.invoke(CHANNELS.terminalDispose, sessionId),
    onData: subscribe<TerminalDataEvent>(CHANNELS.terminalData),
    onExit: subscribe<TerminalExitEvent>(CHANNELS.terminalExit),
  },
  voice: {
    status: () => ipcRenderer.invoke(CHANNELS.voiceStatus),
    download: (modelId) => ipcRenderer.invoke(CHANNELS.voiceDownload, { modelId }),
    cancelDownload: () => ipcRenderer.invoke(CHANNELS.voiceDownloadCancel),
    remove: (modelId) => ipcRenderer.invoke(CHANNELS.voiceRemove, { modelId }),
    pickBinary: (clear) => ipcRenderer.invoke(CHANNELS.voicePickBinary, clear),
    sttBegin: () => ipcRenderer.invoke(CHANNELS.voiceSttBegin),
    sttChunk: (sessionId, chunk) =>
      ipcRenderer.invoke(CHANNELS.voiceSttChunk, { sessionId, chunk }),
    sttEnd: (sessionId) => ipcRenderer.invoke(CHANNELS.voiceSttEnd, { sessionId }),
    sttCancel: (sessionId) => ipcRenderer.invoke(CHANNELS.voiceSttCancel, { sessionId }),
    transcribeAttachment: (req) => ipcRenderer.invoke(CHANNELS.voiceTranscribeAttachment, req),
    onDownloadProgress: subscribe<VoiceDownloadProgressEvent>(CHANNELS.voiceDownloadProgress),
  },
  quick: {
    run: (req) => ipcRenderer.invoke(CHANNELS.quickRun, req),
    getContext: () => ipcRenderer.invoke(CHANNELS.quickGetContext),
    hide: () => ipcRenderer.invoke(CHANNELS.quickHide),
    promote: (req) => ipcRenderer.invoke(CHANNELS.quickPromote, req),
    onContext: subscribe<QuickContext>(CHANNELS.quickContext),
    onStreamEvent: subscribe<QuickStreamEventEnvelope>(CHANNELS.quickStreamEvent),
    onPromoted: subscribe<{ conversationId: string }>(CHANNELS.quickPromoted),
  },
  tools: {
    list: () => ipcRenderer.invoke(CHANNELS.toolsList),
    setEnabled: (toolId, enabled) => ipcRenderer.invoke(CHANNELS.toolsSetEnabled, toolId, enabled),
    permissionsList: () => ipcRenderer.invoke(CHANNELS.toolsPermissionsList),
    permissionSet: (toolId, decision) =>
      ipcRenderer.invoke(CHANNELS.toolsPermissionSet, toolId, decision),
    approvalRespond: (requestId, approved, scope) =>
      ipcRenderer.invoke(CHANNELS.toolsApprovalRespond, requestId, approved, scope),
    customList: () => ipcRenderer.invoke(CHANNELS.toolsCustomList),
    customCreate: (input) => ipcRenderer.invoke(CHANNELS.toolsCustomCreate, input),
    customUpdate: (toolId, patch) => ipcRenderer.invoke(CHANNELS.toolsCustomUpdate, toolId, patch),
    customDelete: (toolId) => ipcRenderer.invoke(CHANNELS.toolsCustomDelete, toolId),
    rulesList: () => ipcRenderer.invoke(CHANNELS.toolsRulesList),
    ruleCreate: (input) => ipcRenderer.invoke(CHANNELS.toolsRuleCreate, input),
    ruleDelete: (ruleId) => ipcRenderer.invoke(CHANNELS.toolsRuleDelete, ruleId),
    onRulesChanged: subscribe<void>(CHANNELS.toolRulesChanged),
    onApprovalRequest: subscribe<ToolApprovalRequest>(CHANNELS.toolApprovalRequest),
    onApprovalSettled: subscribe<string>(CHANNELS.toolApprovalSettled),
    questionRespond: (requestId, answer) =>
      ipcRenderer.invoke(CHANNELS.toolsQuestionRespond, requestId, answer),
    onQuestionRequest: subscribe<UserQuestionRequest>(CHANNELS.userQuestionRequest),
    onQuestionSettled: subscribe<string>(CHANNELS.userQuestionSettled),
  },
  notices: {
    onNotice: subscribe<{ message: string; level: 'info' | 'error' }>(CHANNELS.mainNotice),
    onNavigate: subscribe<NavigateTarget>(CHANNELS.navigate),
  },
  activity: {
    list: (query) => ipcRenderer.invoke(CHANNELS.activityList, query),
    clear: () => ipcRenderer.invoke(CHANNELS.activityClear),
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
    dream: (agentId) => ipcRenderer.invoke(CHANNELS.memoriesDream, agentId),
  },
  documents: {
    list: () => ipcRenderer.invoke(CHANNELS.documentsList),
    get: (id) => ipcRenderer.invoke(CHANNELS.documentsGet, id),
    create: (input) => ipcRenderer.invoke(CHANNELS.documentsCreate, input),
    update: (id, patch) => ipcRenderer.invoke(CHANNELS.documentsUpdate, id, patch),
    delete: (id) => ipcRenderer.invoke(CHANNELS.documentsDelete, id),
    listVersions: (id) => ipcRenderer.invoke(CHANNELS.documentsListVersions, id),
    revert: (id, versionId) => ipcRenderer.invoke(CHANNELS.documentsRevert, { id, versionId }),
    export: (id) => ipcRenderer.invoke(CHANNELS.documentsExport, id),
    onChanged: subscribe(CHANNELS.documentsChanged),
  },
  skills: {
    list: () => ipcRenderer.invoke(CHANNELS.skillsList),
    create: (input) => ipcRenderer.invoke(CHANNELS.skillsCreate, input),
    update: (id, patch) => ipcRenderer.invoke(CHANNELS.skillsUpdate, id, patch),
    delete: (id) => ipcRenderer.invoke(CHANNELS.skillsDelete, id),
    importFolder: (path) => ipcRenderer.invoke(CHANNELS.skillsImportFolder, path),
  },
  backup: {
    export: (opts) => ipcRenderer.invoke(CHANNELS.backupExport, opts),
    import: () => ipcRenderer.invoke(CHANNELS.backupImport),
  },
  spaces: {
    list: () => ipcRenderer.invoke(CHANNELS.spacesList),
    create: (name) => ipcRenderer.invoke(CHANNELS.spacesCreate, { name }),
    update: (id, patch) => ipcRenderer.invoke(CHANNELS.spacesUpdate, { id, patch }),
    delete: (id) => ipcRenderer.invoke(CHANNELS.spacesDelete, id),
  },
  lock: {
    status: () => ipcRenderer.invoke(CHANNELS.lockStatus),
    unlock: (passphrase) => ipcRenderer.invoke(CHANNELS.lockUnlock, { passphrase }),
    lockNow: () => ipcRenderer.invoke(CHANNELS.lockNow),
    setPassphrase: (input) => ipcRenderer.invoke(CHANNELS.lockSetPassphrase, input),
    onChanged: subscribe<{ locked: boolean }>(CHANNELS.appLockChanged),
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
  remote: {
    status: () => ipcRenderer.invoke(CHANNELS.remoteStatus),
    setConfig: (input) => ipcRenderer.invoke(CHANNELS.remoteSetConfig, input),
    pair: (open) => ipcRenderer.invoke(CHANNELS.remotePair, open),
    revoke: (deviceId) => ipcRenderer.invoke(CHANNELS.remoteDeviceRevoke, deviceId),
    onChanged: subscribe<void>(CHANNELS.remoteChanged),
  },
  workflows: {
    list: () => ipcRenderer.invoke(CHANNELS.workflowsList),
    get: (id) => ipcRenderer.invoke(CHANNELS.workflowsGet, id),
    create: (input) => ipcRenderer.invoke(CHANNELS.workflowsCreate, input),
    update: (id, patch) => ipcRenderer.invoke(CHANNELS.workflowsUpdate, id, patch),
    delete: (id) => ipcRenderer.invoke(CHANNELS.workflowsDelete, id),
    run: (graph, opts) => ipcRenderer.invoke(CHANNELS.workflowsRun, graph, opts),
    runById: (id) => ipcRenderer.invoke(CHANNELS.workflowsRunById, id),
    runs: (id) => ipcRenderer.invoke(CHANNELS.workflowsRuns, id),
    overview: () => ipcRenderer.invoke(CHANNELS.workflowsOverview),
    onRunFinished: subscribe<WorkflowRunFinishedEvent>(CHANNELS.workflowRunFinished),
    triggerInfo: (workflowId) => ipcRenderer.invoke(CHANNELS.workflowsTriggerInfo, workflowId),
    triggerRegenerate: () => ipcRenderer.invoke(CHANNELS.workflowsTriggerRegenerate),
    watchInfo: (workflowId) => ipcRenderer.invoke(CHANNELS.workflowsWatchInfo, workflowId),
  },
  scheduledTasks: {
    list: () => ipcRenderer.invoke(CHANNELS.scheduledTasksList),
    create: (input) => ipcRenderer.invoke(CHANNELS.scheduledTasksCreate, input),
    setEnabled: (id, enabled) =>
      ipcRenderer.invoke(CHANNELS.scheduledTasksSetEnabled, id, enabled),
    setBudget: (id, budgetUsd) =>
      ipcRenderer.invoke(CHANNELS.scheduledTasksSetBudget, id, budgetUsd),
    delete: (id) => ipcRenderer.invoke(CHANNELS.scheduledTasksDelete, id),
      onChanged: subscribe(CHANNELS.scheduledTasksChanged),
    runs: (taskId) => ipcRenderer.invoke(CHANNELS.scheduledTaskRuns, taskId),
  },
  agents: {
    list: () => ipcRenderer.invoke(CHANNELS.agentsList),
    create: (input) => ipcRenderer.invoke(CHANNELS.agentsCreate, input),
    update: (id, patch) => ipcRenderer.invoke(CHANNELS.agentsUpdate, id, patch),
    delete: (id) => ipcRenderer.invoke(CHANNELS.agentsDelete, id),
    runs: (conversationId) => ipcRenderer.invoke(CHANNELS.agentRunsList, conversationId),
    stopRun: (runId) => ipcRenderer.invoke(CHANNELS.agentRunStop, runId),
    packExport: () => ipcRenderer.invoke(CHANNELS.agentPackExport),
    packImport: () => ipcRenderer.invoke(CHANNELS.agentPackImport),
  },
  bots: {
    roster: () => ipcRenderer.invoke(CHANNELS.botsRoster),
    openChat: (agentId) => ipcRenderer.invoke(CHANNELS.botsOpenChat, agentId),
    outbox: (agentId) => ipcRenderer.invoke(CHANNELS.botsOutbox, agentId),
    markSeen: (agentId) => ipcRenderer.invoke(CHANNELS.botsMarkSeen, agentId),
    createGroup: (input) => ipcRenderer.invoke(CHANNELS.botGroupCreate, input),
    updateGroup: (id, patch) => ipcRenderer.invoke(CHANNELS.botGroupUpdate, id, patch),
    deleteGroup: (id) => ipcRenderer.invoke(CHANNELS.botGroupDelete, id),
    groupSend: (groupId, content) => ipcRenderer.invoke(CHANNELS.botGroupSend, groupId, content),
    groupStop: (groupId) => ipcRenderer.invoke(CHANNELS.botGroupStop, groupId),
    groupMarkSeen: (groupId) => ipcRenderer.invoke(CHANNELS.botGroupMarkSeen, groupId),
    binding: (agentId) => ipcRenderer.invoke(CHANNELS.botBindingGet, agentId),
    bindingSetToken: (agentId, token) =>
      ipcRenderer.invoke(CHANNELS.botBindingSetToken, agentId, token),
    bindingSetEnabled: (agentId, enabled) =>
      ipcRenderer.invoke(CHANNELS.botBindingSetEnabled, agentId, enabled),
    bindingRepair: (agentId) => ipcRenderer.invoke(CHANNELS.botBindingRepair, agentId),
    bindingClearToken: (agentId) => ipcRenderer.invoke(CHANNELS.botBindingClearToken, agentId),
    bindingUpdateGroup: (agentId, groupId, patch) =>
      ipcRenderer.invoke(CHANNELS.botBindingUpdateGroup, agentId, groupId, patch),
    onChanged: subscribe(CHANNELS.botsChanged),
  },
  knowledge: {
    list: () => ipcRenderer.invoke(CHANNELS.kbList),
    create: (input) => ipcRenderer.invoke(CHANNELS.kbCreate, input),
    delete: (id) => ipcRenderer.invoke(CHANNELS.kbDelete, id),
    importFiles: (id) => ipcRenderer.invoke(CHANNELS.kbImportFiles, id),
    sources: (id) => ipcRenderer.invoke(CHANNELS.kbSources, id),
    removeSource: (id, source) => ipcRenderer.invoke(CHANNELS.kbRemoveSource, id, source),
  },
}

contextBridge.exposeInMainWorld('uld', api)
