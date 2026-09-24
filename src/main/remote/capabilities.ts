import { CHANNELS, type ChannelName } from '@shared/ipc'

/** Reviewed individually. New desktop IPC is never implicitly granted to a phone. */
export const FULL_REMOTE_CHANNELS: ReadonlySet<ChannelName> = new Set([
  CHANNELS.remoteUploadBegin, CHANNELS.remoteUploadChunk, CHANNELS.remoteUploadFinish,
  CHANNELS.remoteTransferCancel, CHANNELS.remoteDownloadRead, CHANNELS.remoteBrowse, CHANNELS.remoteFileInvoke,
  CHANNELS.appPickFolder, CHANNELS.appPickFiles, CHANNELS.appSaveAttachmentAs,
  CHANNELS.convExport, CHANNELS.documentsExport, CHANNELS.backupExport, CHANNELS.backupPreview, CHANNELS.backupCommit,
  CHANNELS.agentPackImport, CHANNELS.agentPackExport, CHANNELS.skillsImportFolder, CHANNELS.kbImportFiles,
  CHANNELS.voicePickBinary, CHANNELS.codeProjectReveal, CHANNELS.codeOpenInIde,
  CHANNELS.settingsGet, CHANNELS.settingsUpdate, CHANNELS.lockStatus,
  CHANNELS.providersListTypes, CHANNELS.providersList, CHANNELS.providersCreate,
  CHANNELS.providersUpdate, CHANNELS.providersDelete, CHANNELS.providersSetKey,
  CHANNELS.providersDeleteKey, CHANNELS.providersTest, CHANNELS.providersListModels,
  CHANNELS.providersPreviewModels, CHANNELS.providersDetectLocal,
  CHANNELS.providersOauthStart, CHANNELS.providersOauthLogout, CHANNELS.providersOauthStatus,
  CHANNELS.convDraftGet, CHANNELS.convDraftSave, CHANNELS.convForkLineage,
  CHANNELS.projectsCreate, CHANNELS.projectsUpdate, CHANNELS.projectsDelete,
  CHANNELS.workspaceList, CHANNELS.workspaceCreate, CHANNELS.workspaceGet,
  CHANNELS.workspaceUpdate, CHANNELS.workspaceDelete, CHANNELS.workspaceItemsList,
  CHANNELS.workspaceItemCreate, CHANNELS.workspaceItemUpdate, CHANNELS.workspaceItemDelete,
  CHANNELS.codeProjectsList, CHANNELS.codeProjectOpen, CHANNELS.codeProjectForget,
  CHANNELS.codeFileTree, CHANNELS.codeReadFile, CHANNELS.codeChangesList,
  CHANNELS.codeChangeApply, CHANNELS.codeChangeReject, CHANNELS.codeChangeRevert,
  CHANNELS.codeChangesListAll, CHANNELS.codeSuggestFiles,
  CHANNELS.codeGitStatus, CHANNELS.codeGitStage, CHANNELS.codeGitUnstage,
  CHANNELS.codeGitCommit, CHANNELS.codeGitCreateBranch, CHANNELS.codeGitFetch,
  CHANNELS.codeGitSetOrigin, CHANNELS.codeGitPull, CHANNELS.codeGitPush,
  CHANNELS.codeGithubPrCreate, CHANNELS.codeGitGenerateCommitMessage,
  CHANNELS.codeWorktreeCreate, CHANNELS.codeCheckpointsList, CHANNELS.codeCheckpointRestore,
  CHANNELS.codeTurnRevert,
  CHANNELS.toolsList, CHANNELS.toolsSetEnabled, CHANNELS.toolsPermissionsList,
  CHANNELS.toolsPermissionSet, CHANNELS.toolsCustomList, CHANNELS.toolsCustomCreate,
  CHANNELS.toolsCustomUpdate, CHANNELS.toolsCustomDelete, CHANNELS.toolsRulesList,
  CHANNELS.toolsRuleCreate, CHANNELS.toolsRuleDelete,
  CHANNELS.activityList, CHANNELS.activityClear,
  CHANNELS.promptsList, CHANNELS.promptsCreate, CHANNELS.promptsUpdate, CHANNELS.promptsDelete,
  CHANNELS.memoriesList, CHANNELS.memoriesCreate, CHANNELS.memoriesUpdate, CHANNELS.memoriesDelete, CHANNELS.memoriesDream,
  CHANNELS.documentsList, CHANNELS.documentsGet, CHANNELS.documentsCreate, CHANNELS.documentsUpdate,
  CHANNELS.documentsDelete, CHANNELS.documentsListVersions, CHANNELS.documentsRevert,
  CHANNELS.skillsList, CHANNELS.skillsCreate, CHANNELS.skillsUpdate, CHANNELS.skillsDelete,
  CHANNELS.mcpList, CHANNELS.mcpCreate, CHANNELS.mcpUpdate, CHANNELS.mcpDelete,
  CHANNELS.mcpSetEnabled, CHANNELS.mcpReconnect, CHANNELS.mcpStatus,
  CHANNELS.imSetTelegram, CHANNELS.imSetWebhook, CHANNELS.remoteStatus,
  CHANNELS.workflowsCreate, CHANNELS.workflowsUpdate, CHANNELS.workflowsDelete,
  CHANNELS.workflowsRun, CHANNELS.workflowsWatchInfo,
  CHANNELS.scheduledTasksList, CHANNELS.scheduledTasksCreate, CHANNELS.scheduledTasksSetEnabled,
  CHANNELS.scheduledTasksUpdate,
  CHANNELS.scheduledTasksSetBudget, CHANNELS.scheduledTasksDelete, CHANNELS.scheduledTaskRuns,
  CHANNELS.scheduledTasksRunNow,
  CHANNELS.agentsList, CHANNELS.agentsCreate, CHANNELS.agentsUpdate, CHANNELS.agentsDelete,
  CHANNELS.agentRunsList, CHANNELS.agentRunStop, CHANNELS.agentsWatchInfo, CHANNELS.agentsWake,
  CHANNELS.botsRoster, CHANNELS.botsOpenChat, CHANNELS.botGroupCreate,
  CHANNELS.botGroupUpdate, CHANNELS.botGroupDelete, CHANNELS.botGroupSend, CHANNELS.botGroupStop,
  CHANNELS.botGroupMarkSeen, CHANNELS.botGroupCreateFromMoa, CHANNELS.botsOutbox,
  CHANNELS.botsMarkSeen, CHANNELS.botsUsage, CHANNELS.botBindingGet,
  CHANNELS.botBindingSetToken, CHANNELS.botBindingSetEnabled, CHANNELS.botBindingClearToken,
  CHANNELS.botBindingUpdateGroup,
  CHANNELS.kbList, CHANNELS.kbProviders, CHANNELS.kbCreate, CHANNELS.kbDelete,
  CHANNELS.kbSources, CHANNELS.kbRemoveSource,
  CHANNELS.arenaStart, CHANNELS.arenaStatus, CHANNELS.arenaApply, CHANNELS.arenaStop, CHANNELS.arenaDiscard,
  CHANNELS.optimizerStart, CHANNELS.optimizerStop, CHANNELS.optimizerList, CHANNELS.optimizerVersions,
  CHANNELS.experimentsList, CHANNELS.briefList, CHANNELS.briefDismiss,
  CHANNELS.usageConversationCost, CHANNELS.usageHeadless,
  CHANNELS.terminalCreate, CHANNELS.terminalInput, CHANNELS.terminalDispose,
  CHANNELS.voiceStatus, CHANNELS.voiceDownload, CHANNELS.voiceDownloadCancel, CHANNELS.voiceRemove,
  CHANNELS.voiceSttBegin, CHANNELS.voiceSttChunk, CHANNELS.voiceSttEnd, CHANNELS.voiceSttCancel,
  CHANNELS.voiceTranscribeAttachment, CHANNELS.appReadAttachment,
  CHANNELS.appStorePastedImage, CHANNELS.appExtractAttachmentText,
])

export const FULL_REMOTE_PUSH_CHANNELS: ReadonlySet<string> = new Set([
  CHANNELS.terminalData, CHANNELS.terminalExit, CHANNELS.voiceDownloadProgress,
  CHANNELS.botsChanged, CHANNELS.kbProgress, CHANNELS.briefChanged, CHANNELS.documentsChanged,
])

/** These desktop-only values never cross a management response or push. */
export function remoteSafeData(channel: string, value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  if (channel === CHANNELS.settingsGet || channel === CHANNELS.settingsUpdate) {
    return { ...source, appLockHash: null, workflowWebhookToken: null, telegramBridgePairingCode: null, outboundWebhookUrl: null }
  }
  if (channel === CHANNELS.remoteStatus) return { ...source, pairing: null }
  if (channel === CHANNELS.imStatus || channel === CHANNELS.imSetTelegram || channel === CHANNELS.imSetWebhook) return { ...source, telegramPairingCode: null, webhookUrl: null, telegramBridgePairingCode: null }
  if ([CHANNELS.botBindingGet, CHANNELS.botBindingSetToken, CHANNELS.botBindingSetEnabled, CHANNELS.botBindingUpdateGroup].includes(channel as never)) return { ...source, pairingCode: null }
  return value
}
