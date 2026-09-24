/**
 * Preload bridge: exposes the typed UldApi as window.uld. Pure forwarding —
 * every method maps 1:1 to an ipcRenderer.invoke on a CHANNELS entry, and the
 * two push channels get subscribe/unsubscribe wrappers. No logic lives here.
 */

import type { IpcResult } from '@shared/ipc'
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

export interface UldTransport {
  invoke<T>(channel: ChannelName, ...args: unknown[]): Promise<IpcResult<T>>
  subscribe<T>(channel: ChannelName, callback: (payload: T) => void): () => void
}

/** One API contract for Electron, encrypted browser tunnels and native hosts. */
export function createUldApi(transport: UldTransport): UldApi {
  const subscribe = <T>(channel: ChannelName) => (callback: (payload: T) => void) => transport.subscribe(channel, callback)
  return {
  app: {
    getInfo: () => transport.invoke(CHANNELS.appGetInfo),
    pickFolder: () => transport.invoke(CHANNELS.appPickFolder),
    pickFiles: () => transport.invoke(CHANNELS.appPickFiles),
    storePastedImage: (input) => transport.invoke(CHANNELS.appStorePastedImage, input),
    readAttachment: (storageKey) => transport.invoke(CHANNELS.appReadAttachment, storageKey),
    extractAttachmentText: (input) =>
      transport.invoke(CHANNELS.appExtractAttachmentText, input),
    saveAttachmentAs: (storageKey, suggestedName) =>
      transport.invoke(CHANNELS.appSaveAttachmentAs, { storageKey, suggestedName }),
  },
  settings: {
    get: () => transport.invoke(CHANNELS.settingsGet),
    update: (patch) => transport.invoke(CHANNELS.settingsUpdate, patch),
  },
  providers: {
    listTypes: () => transport.invoke(CHANNELS.providersListTypes),
    list: () => transport.invoke(CHANNELS.providersList),
    create: (input) => transport.invoke(CHANNELS.providersCreate, input),
    update: (id, patch) => transport.invoke(CHANNELS.providersUpdate, id, patch),
    delete: (id) => transport.invoke(CHANNELS.providersDelete, id),
    setKey: (id, apiKey) => transport.invoke(CHANNELS.providersSetKey, id, apiKey),
    deleteKey: (id) => transport.invoke(CHANNELS.providersDeleteKey, id),
    test: (id) => transport.invoke(CHANNELS.providersTest, id),
    listModels: (id) => transport.invoke(CHANNELS.providersListModels, id),
    previewModels: (input) => transport.invoke(CHANNELS.providersPreviewModels, input),
    detectLocal: () => transport.invoke(CHANNELS.providersDetectLocal),
    oauthStart: (id) => transport.invoke(CHANNELS.providersOauthStart, id),
    oauthLogout: (id) => transport.invoke(CHANNELS.providersOauthLogout, id),
    oauthStatus: (id) => transport.invoke(CHANNELS.providersOauthStatus, id),
  },
  conversations: {
    list: (req) => transport.invoke(CHANNELS.convList, req),
    create: (req) => transport.invoke(CHANNELS.convCreate, req),
    get: (id) => transport.invoke(CHANNELS.convGet, id),
    update: (req) => transport.invoke(CHANNELS.convUpdate, req),
    delete: (id) => transport.invoke(CHANNELS.convDelete, id),
    messages: (conversationId) => transport.invoke(CHANNELS.convMessages, conversationId),
    getDraft: (conversationId) => transport.invoke(CHANNELS.convDraftGet, conversationId),
    saveDraft: (conversationId, draft) => transport.invoke(CHANNELS.convDraftSave, { conversationId, draft }),
    export: (req) => transport.invoke(CHANNELS.convExport, req),
    fork: (id, messageId) => transport.invoke(CHANNELS.convFork, { id, messageId }),
    forkLineage: (id) => transport.invoke(CHANNELS.convForkLineage, id),
    onConversationsChanged: subscribe<{ conversationId: string }>(CHANNELS.conversationsChanged),
  },
  projects: {
    list: (req) => transport.invoke(CHANNELS.projectsList, req),
    create: (input) => transport.invoke(CHANNELS.projectsCreate, input),
    update: (id, patch) => transport.invoke(CHANNELS.projectsUpdate, id, patch),
    delete: (id) => transport.invoke(CHANNELS.projectsDelete, id),
  },
  data: {
    deleteAllContent: () => transport.invoke(CHANNELS.dataDeleteAllContent),
  },
  chat: {
    send: (req) => transport.invoke(CHANNELS.chatSend, req),
    stop: (streamId) => transport.invoke(CHANNELS.chatStop, streamId),
    regenerate: (req) => transport.invoke(CHANNELS.chatRegenerate, req),
    editAndRerun: (req) => transport.invoke(CHANNELS.chatEditAndRerun, req),
    compact: (conversationId) => transport.invoke(CHANNELS.chatCompact, conversationId),
    pickCompareWinner: (req) => transport.invoke(CHANNELS.chatPickCompareWinner, req),
    onStreamEvent: subscribe<StreamEventEnvelope>(CHANNELS.streamEvent),
  },
  workspaces: {
    list: () => transport.invoke(CHANNELS.workspaceList),
    create: (input) => transport.invoke(CHANNELS.workspaceCreate, input),
    get: (id) => transport.invoke(CHANNELS.workspaceGet, id),
    update: (id, patch) => transport.invoke(CHANNELS.workspaceUpdate, id, patch),
    delete: (id) => transport.invoke(CHANNELS.workspaceDelete, id),
    itemsList: (workspaceId) => transport.invoke(CHANNELS.workspaceItemsList, workspaceId),
    itemCreate: (input) => transport.invoke(CHANNELS.workspaceItemCreate, input),
    itemUpdate: (id, patch) => transport.invoke(CHANNELS.workspaceItemUpdate, id, patch),
    itemDelete: (id) => transport.invoke(CHANNELS.workspaceItemDelete, id),
  },
  code: {
    projectsList: () => transport.invoke(CHANNELS.codeProjectsList),
    projectOpen: (path) => transport.invoke(CHANNELS.codeProjectOpen, path),
    projectForget: (id) => transport.invoke(CHANNELS.codeProjectForget, id),
    projectReveal: (id) => transport.invoke(CHANNELS.codeProjectReveal, id),
    fileTree: (projectId) => transport.invoke(CHANNELS.codeFileTree, projectId),
    readFile: (req) => transport.invoke(CHANNELS.codeReadFile, req),
    changesList: (projectId) => transport.invoke(CHANNELS.codeChangesList, projectId),
    changeApply: (changeId) => transport.invoke(CHANNELS.codeChangeApply, changeId),
    changeReject: (changeId) => transport.invoke(CHANNELS.codeChangeReject, changeId),
    changeRevert: (changeId) => transport.invoke(CHANNELS.codeChangeRevert, changeId),
    changesListAll: (projectId) => transport.invoke(CHANNELS.codeChangesListAll, projectId),
    suggestFiles: (req) => transport.invoke(CHANNELS.codeSuggestFiles, req),
    onChangesChanged: subscribe(CHANNELS.codeChangesChanged),
    gitStatus: (projectId) => transport.invoke(CHANNELS.codeGitStatus, projectId),
    gitStage: (projectId, paths) =>
      transport.invoke(CHANNELS.codeGitStage, { projectId, paths }),
    gitUnstage: (projectId, paths) =>
      transport.invoke(CHANNELS.codeGitUnstage, { projectId, paths }),
    gitCommit: (projectId, message) =>
      transport.invoke(CHANNELS.codeGitCommit, { projectId, message }),
    gitCreateBranch: (projectId, name) =>
      transport.invoke(CHANNELS.codeGitCreateBranch, { projectId, name }),
    gitFetch: (projectId) => transport.invoke(CHANNELS.codeGitFetch, projectId),
    gitSetOrigin: (projectId, url) =>
      transport.invoke(CHANNELS.codeGitSetOrigin, { projectId, url }),
    gitPull: (projectId) => transport.invoke(CHANNELS.codeGitPull, projectId),
    gitPush: (projectId, confirmDefaultBranch) =>
      transport.invoke(CHANNELS.codeGitPush, { projectId, confirmDefaultBranch }),
    githubPrCreate: (projectId, input) =>
      transport.invoke(CHANNELS.codeGithubPrCreate, { projectId, input }),
    gitGenerateCommitMessage: (projectId) =>
      transport.invoke(CHANNELS.codeGitGenerateCommitMessage, projectId),
    worktreeCreate: (projectId, name) =>
      transport.invoke(CHANNELS.codeWorktreeCreate, { projectId, name }),
    openInIde: (projectId) => transport.invoke(CHANNELS.codeOpenInIde, projectId),
    checkpointsList: (conversationId) =>
      transport.invoke(CHANNELS.codeCheckpointsList, conversationId),
    checkpointRestore: (checkpointId) =>
      transport.invoke(CHANNELS.codeCheckpointRestore, checkpointId),
    revertTurn: (req) => transport.invoke(CHANNELS.codeTurnRevert, req),
  },
  usage: {
    summary: (days) => transport.invoke(CHANNELS.usageSummary, days),
    conversationCost: (conversationId) =>
      transport.invoke(CHANNELS.usageConversationCost, conversationId),
    headlessSummary: (days) => transport.invoke(CHANNELS.usageHeadless, days),
  },
  inbox: {
    list: () => transport.invoke(CHANNELS.inboxList),
    markReviewed: (itemType, itemId) =>
      transport.invoke(CHANNELS.inboxMarkReviewed, { itemType, itemId }),
  },
  brief: {
    list: () => transport.invoke(CHANNELS.briefList),
    dismiss: (id) => transport.invoke(CHANNELS.briefDismiss, id),
    onChanged: subscribe<{ brief: MorningBrief }>(CHANNELS.briefChanged),
  },
  arena: {
    start: (req) => transport.invoke(CHANNELS.arenaStart, req),
    status: (conversationId) => transport.invoke(CHANNELS.arenaStatus, conversationId),
    apply: (conversationId, runId) =>
      transport.invoke(CHANNELS.arenaApply, { conversationId, runId }),
    stop: (conversationId) => transport.invoke(CHANNELS.arenaStop, conversationId),
    discard: (conversationId) => transport.invoke(CHANNELS.arenaDiscard, conversationId),
    onChanged: subscribe<{ arena: ArenaState }>(CHANNELS.arenaChanged),
  },
  optimizer: {
    start: (input) => transport.invoke(CHANNELS.optimizerStart, input),
    stop: (runId) => transport.invoke(CHANNELS.optimizerStop, runId),
    list: () => transport.invoke(CHANNELS.optimizerList),
    versions: (runId) => transport.invoke(CHANNELS.optimizerVersions, runId),
    onChanged: subscribe<{ run: OptimizerRun }>(CHANNELS.optimizerChanged),
  },
  experiments: {
    list: (projectId) => transport.invoke(CHANNELS.experimentsList, projectId),
  },
  terminal: {
    create: (conversationId) => transport.invoke(CHANNELS.terminalCreate, conversationId),
    input: (sessionId, data) => transport.invoke(CHANNELS.terminalInput, { sessionId, data }),
    dispose: (sessionId) => transport.invoke(CHANNELS.terminalDispose, sessionId),
    onData: subscribe<TerminalDataEvent>(CHANNELS.terminalData),
    onExit: subscribe<TerminalExitEvent>(CHANNELS.terminalExit),
  },
  voice: {
    status: () => transport.invoke(CHANNELS.voiceStatus),
    download: (modelId) => transport.invoke(CHANNELS.voiceDownload, { modelId }),
    cancelDownload: () => transport.invoke(CHANNELS.voiceDownloadCancel),
    remove: (modelId) => transport.invoke(CHANNELS.voiceRemove, { modelId }),
    pickBinary: (clear) => transport.invoke(CHANNELS.voicePickBinary, clear),
    sttBegin: () => transport.invoke(CHANNELS.voiceSttBegin),
    sttChunk: (sessionId, chunk) =>
      transport.invoke(CHANNELS.voiceSttChunk, { sessionId, chunk }),
    sttEnd: (sessionId) => transport.invoke(CHANNELS.voiceSttEnd, { sessionId }),
    sttCancel: (sessionId) => transport.invoke(CHANNELS.voiceSttCancel, { sessionId }),
    transcribeAttachment: (req) => transport.invoke(CHANNELS.voiceTranscribeAttachment, req),
    onDownloadProgress: subscribe<VoiceDownloadProgressEvent>(CHANNELS.voiceDownloadProgress),
  },
  quick: {
    run: (req) => transport.invoke(CHANNELS.quickRun, req),
    getContext: () => transport.invoke(CHANNELS.quickGetContext),
    hide: () => transport.invoke(CHANNELS.quickHide),
    promote: (req) => transport.invoke(CHANNELS.quickPromote, req),
    onContext: subscribe<QuickContext>(CHANNELS.quickContext),
    onStreamEvent: subscribe<QuickStreamEventEnvelope>(CHANNELS.quickStreamEvent),
    onPromoted: subscribe<{ conversationId: string }>(CHANNELS.quickPromoted),
  },
  tools: {
    pending: () => transport.invoke(CHANNELS.toolsPending),
    list: () => transport.invoke(CHANNELS.toolsList),
    setEnabled: (toolId, enabled) => transport.invoke(CHANNELS.toolsSetEnabled, toolId, enabled),
    permissionsList: () => transport.invoke(CHANNELS.toolsPermissionsList),
    permissionSet: (toolId, decision) =>
      transport.invoke(CHANNELS.toolsPermissionSet, toolId, decision),
    approvalRespond: (requestId, approved, scope) =>
      transport.invoke(CHANNELS.toolsApprovalRespond, requestId, approved, scope),
    customList: () => transport.invoke(CHANNELS.toolsCustomList),
    customCreate: (input) => transport.invoke(CHANNELS.toolsCustomCreate, input),
    customUpdate: (toolId, patch) => transport.invoke(CHANNELS.toolsCustomUpdate, toolId, patch),
    customDelete: (toolId) => transport.invoke(CHANNELS.toolsCustomDelete, toolId),
    rulesList: () => transport.invoke(CHANNELS.toolsRulesList),
    ruleCreate: (input) => transport.invoke(CHANNELS.toolsRuleCreate, input),
    ruleDelete: (ruleId) => transport.invoke(CHANNELS.toolsRuleDelete, ruleId),
    onRulesChanged: subscribe<void>(CHANNELS.toolRulesChanged),
    onApprovalRequest: subscribe<ToolApprovalRequest>(CHANNELS.toolApprovalRequest),
    onApprovalSettled: subscribe<string>(CHANNELS.toolApprovalSettled),
    questionRespond: (requestId, answer) =>
      transport.invoke(CHANNELS.toolsQuestionRespond, requestId, answer),
    onQuestionRequest: subscribe<UserQuestionRequest>(CHANNELS.userQuestionRequest),
    onQuestionSettled: subscribe<string>(CHANNELS.userQuestionSettled),
  },
  notices: {
    onNotice: subscribe<{ message: string; level: 'info' | 'error' }>(CHANNELS.mainNotice),
    onNavigate: subscribe<NavigateTarget>(CHANNELS.navigate),
  },
  activity: {
    list: (query) => transport.invoke(CHANNELS.activityList, query),
    clear: () => transport.invoke(CHANNELS.activityClear),
  },
  prompts: {
    list: () => transport.invoke(CHANNELS.promptsList),
    create: (input) => transport.invoke(CHANNELS.promptsCreate, input),
    update: (id, patch) => transport.invoke(CHANNELS.promptsUpdate, id, patch),
    delete: (id) => transport.invoke(CHANNELS.promptsDelete, id),
  },
  memories: {
    list: () => transport.invoke(CHANNELS.memoriesList),
    create: (input) => transport.invoke(CHANNELS.memoriesCreate, input),
    update: (id, patch) => transport.invoke(CHANNELS.memoriesUpdate, id, patch),
    delete: (id) => transport.invoke(CHANNELS.memoriesDelete, id),
    dream: (agentId) => transport.invoke(CHANNELS.memoriesDream, agentId),
  },
  documents: {
    list: () => transport.invoke(CHANNELS.documentsList),
    get: (id) => transport.invoke(CHANNELS.documentsGet, id),
    create: (input) => transport.invoke(CHANNELS.documentsCreate, input),
    update: (id, patch) => transport.invoke(CHANNELS.documentsUpdate, id, patch),
    delete: (id) => transport.invoke(CHANNELS.documentsDelete, id),
    listVersions: (id) => transport.invoke(CHANNELS.documentsListVersions, id),
    revert: (id, versionId) => transport.invoke(CHANNELS.documentsRevert, { id, versionId }),
    export: (id) => transport.invoke(CHANNELS.documentsExport, id),
    onChanged: subscribe(CHANNELS.documentsChanged),
  },
  skills: {
    list: () => transport.invoke(CHANNELS.skillsList),
    create: (input) => transport.invoke(CHANNELS.skillsCreate, input),
    update: (id, patch) => transport.invoke(CHANNELS.skillsUpdate, id, patch),
    delete: (id) => transport.invoke(CHANNELS.skillsDelete, id),
    importFolder: (path) => transport.invoke(CHANNELS.skillsImportFolder, path),
  },
  backup: {
    preview: () => transport.invoke(CHANNELS.backupPreview),
    commit: (id) => transport.invoke(CHANNELS.backupCommit, id),
    export: (opts) => transport.invoke(CHANNELS.backupExport, opts),
    import: () => transport.invoke(CHANNELS.backupImport),
  },
  spaces: {
    list: () => transport.invoke(CHANNELS.spacesList),
    create: (name) => transport.invoke(CHANNELS.spacesCreate, { name }),
    update: (id, patch) => transport.invoke(CHANNELS.spacesUpdate, { id, patch }),
    delete: (id) => transport.invoke(CHANNELS.spacesDelete, id),
  },
  lock: {
    status: () => transport.invoke(CHANNELS.lockStatus),
    unlock: (passphrase) => transport.invoke(CHANNELS.lockUnlock, { passphrase }),
    lockNow: () => transport.invoke(CHANNELS.lockNow),
    setPassphrase: (input) => transport.invoke(CHANNELS.lockSetPassphrase, input),
    onChanged: subscribe<{ locked: boolean }>(CHANNELS.appLockChanged),
  },
  mcp: {
    list: () => transport.invoke(CHANNELS.mcpList),
    create: (input) => transport.invoke(CHANNELS.mcpCreate, input),
    update: (id, patch) => transport.invoke(CHANNELS.mcpUpdate, id, patch),
    delete: (id) => transport.invoke(CHANNELS.mcpDelete, id),
    setEnabled: (id, enabled) => transport.invoke(CHANNELS.mcpSetEnabled, id, enabled),
    reconnect: (id) => transport.invoke(CHANNELS.mcpReconnect, id),
    status: () => transport.invoke(CHANNELS.mcpStatus),
    onServersChanged: subscribe<McpServerRuntime[]>(CHANNELS.mcpServersChanged),
  },
  im: {
    status: () => transport.invoke(CHANNELS.imStatus),
    setTelegram: (input) => transport.invoke(CHANNELS.imSetTelegram, input),
    setWebhook: (url) => transport.invoke(CHANNELS.imSetWebhook, url),
  },
  remote: {
    setAccess: (deviceId, access) => transport.invoke(CHANNELS.remoteDeviceAccess, { deviceId, access }),
    capabilities: () => transport.invoke(CHANNELS.remoteCapabilities),
    status: () => transport.invoke(CHANNELS.remoteStatus),
    setConfig: (input) => transport.invoke(CHANNELS.remoteSetConfig, input),
    pair: (open) => transport.invoke(CHANNELS.remotePair, open),
    revoke: (deviceId) => transport.invoke(CHANNELS.remoteDeviceRevoke, deviceId),
    onChanged: subscribe<void>(CHANNELS.remoteChanged),
  },
  workflows: {
    list: () => transport.invoke(CHANNELS.workflowsList),
    get: (id) => transport.invoke(CHANNELS.workflowsGet, id),
    create: (input) => transport.invoke(CHANNELS.workflowsCreate, input),
    update: (id, patch) => transport.invoke(CHANNELS.workflowsUpdate, id, patch),
    delete: (id) => transport.invoke(CHANNELS.workflowsDelete, id),
    run: (graph, opts) => transport.invoke(CHANNELS.workflowsRun, graph, opts),
    runById: (id) => transport.invoke(CHANNELS.workflowsRunById, id),
    runs: (id) => transport.invoke(CHANNELS.workflowsRuns, id),
    overview: () => transport.invoke(CHANNELS.workflowsOverview),
    onRunFinished: subscribe<WorkflowRunFinishedEvent>(CHANNELS.workflowRunFinished),
    triggerInfo: (workflowId) => transport.invoke(CHANNELS.workflowsTriggerInfo, workflowId),
    triggerRegenerate: () => transport.invoke(CHANNELS.workflowsTriggerRegenerate),
    watchInfo: (workflowId) => transport.invoke(CHANNELS.workflowsWatchInfo, workflowId),
  },
  scheduledTasks: {
    list: () => transport.invoke(CHANNELS.scheduledTasksList),
    create: (input) => transport.invoke(CHANNELS.scheduledTasksCreate, input),
    update: (id, input) => transport.invoke(CHANNELS.scheduledTasksUpdate, id, input),
    setEnabled: (id, enabled) =>
      transport.invoke(CHANNELS.scheduledTasksSetEnabled, id, enabled),
    setBudget: (id, budgetUsd) =>
      transport.invoke(CHANNELS.scheduledTasksSetBudget, id, budgetUsd),
    delete: (id) => transport.invoke(CHANNELS.scheduledTasksDelete, id),
      onChanged: subscribe(CHANNELS.scheduledTasksChanged),
    runs: (taskId) => transport.invoke(CHANNELS.scheduledTaskRuns, taskId),
    runNow: (id) => transport.invoke(CHANNELS.scheduledTasksRunNow, id),
  },
  agents: {
    list: () => transport.invoke(CHANNELS.agentsList),
    create: (input) => transport.invoke(CHANNELS.agentsCreate, input),
    update: (id, patch) => transport.invoke(CHANNELS.agentsUpdate, id, patch),
    delete: (id) => transport.invoke(CHANNELS.agentsDelete, id),
    runs: (conversationId) => transport.invoke(CHANNELS.agentRunsList, conversationId),
    stopRun: (runId) => transport.invoke(CHANNELS.agentRunStop, runId),
    packExport: () => transport.invoke(CHANNELS.agentPackExport),
    triggerInfo: (agentId) => transport.invoke(CHANNELS.agentsTriggerInfo, agentId),
    watchInfo: (agentId) => transport.invoke(CHANNELS.agentsWatchInfo, agentId),
    wake: (agentId, payload) => transport.invoke(CHANNELS.agentsWake, agentId, payload),
    packImport: () => transport.invoke(CHANNELS.agentPackImport),
  },
  bots: {
    roster: () => transport.invoke(CHANNELS.botsRoster),
    openChat: (agentId) => transport.invoke(CHANNELS.botsOpenChat, agentId),
    outbox: (agentId) => transport.invoke(CHANNELS.botsOutbox, agentId),
    markSeen: (agentId) => transport.invoke(CHANNELS.botsMarkSeen, agentId),
    usage: (agentId) => transport.invoke(CHANNELS.botsUsage, agentId),
    createGroup: (input) => transport.invoke(CHANNELS.botGroupCreate, input),
    createGroupFromMoaPreset: (presetId) =>
      transport.invoke(CHANNELS.botGroupCreateFromMoa, presetId),
    updateGroup: (id, patch) => transport.invoke(CHANNELS.botGroupUpdate, id, patch),
    deleteGroup: (id) => transport.invoke(CHANNELS.botGroupDelete, id),
    groupSend: (groupId, content, requestId) => transport.invoke(CHANNELS.botGroupSend, groupId, content, requestId),
    groupStop: (groupId) => transport.invoke(CHANNELS.botGroupStop, groupId),
    groupMarkSeen: (groupId) => transport.invoke(CHANNELS.botGroupMarkSeen, groupId),
    binding: (agentId) => transport.invoke(CHANNELS.botBindingGet, agentId),
    bindingSetToken: (agentId, token) =>
      transport.invoke(CHANNELS.botBindingSetToken, agentId, token),
    bindingSetEnabled: (agentId, enabled) =>
      transport.invoke(CHANNELS.botBindingSetEnabled, agentId, enabled),
    bindingRepair: (agentId) => transport.invoke(CHANNELS.botBindingRepair, agentId),
    bindingClearToken: (agentId) => transport.invoke(CHANNELS.botBindingClearToken, agentId),
    bindingUpdateGroup: (agentId, groupId, patch) =>
      transport.invoke(CHANNELS.botBindingUpdateGroup, agentId, groupId, patch),
    onChanged: subscribe(CHANNELS.botsChanged),
  },
  knowledge: {
    providers: () => transport.invoke(CHANNELS.kbProviders),
    onProgress: subscribe(CHANNELS.kbProgress),
    list: () => transport.invoke(CHANNELS.kbList),
    create: (input) => transport.invoke(CHANNELS.kbCreate, input),
    delete: (id) => transport.invoke(CHANNELS.kbDelete, id),
    importFiles: (id) => transport.invoke(CHANNELS.kbImportFiles, id),
    sources: (id) => transport.invoke(CHANNELS.kbSources, id),
    removeSource: (id, source) => transport.invoke(CHANNELS.kbRemoveSource, id, source),
  },
}

}
