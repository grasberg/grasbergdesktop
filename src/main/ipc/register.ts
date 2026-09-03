/**
 * Registers every request/response IPC channel. Each handler validates its
 * input, calls through to the service/repository layer, and always resolves
 * to an IpcResult — errors are normalized, never thrown across the boundary.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  shell,
  type FileFilter,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type SaveDialogOptions,
  type SaveDialogReturnValue,
} from 'electron'
import { z } from 'zod'
import { CHANNELS, err, ok, type ChannelName, type PickFilesResult } from '@shared/ipc'
import type {
  AppInfo,
  AppSettings,
  Attachment,
  ConversationMode,
  QuickContext,
  ScheduledTaskInput,
  ScheduledTasksChangedEvent,
  ToolPermissionDecision,
  WorkflowGraph,
  WorkflowInput,
  WorkflowSchedule,
  WorkflowsOverview,
  WorkflowTriggerInfo,
  WorkflowWatchConfig,
  WorkflowWatchStatus,
  WorkspaceItemKind,
} from '@shared/types'
import { makeDryRunDeps, runWorkflow } from '../workflows/engine'
import type { WorkflowRunner } from '../workflows/runner'
import type { WorkspaceRootService } from '../code/workspace-root'
import type { TerminalService } from '../terminal/terminal-service'
import type { VoiceService } from '../audio/voice-service'
import type { KnowledgeService } from '../services/knowledge'
import type { BotChannelService } from '../im/bot-channels'
import type { BotService } from '../services/bots'
import type { DreamingService } from '../services/dreaming'
import { isAllowedWebhookUrl } from '../services/task-webhook'
import type { BriefService } from '../services/brief'
import {
  CHATGPT_OAUTH_DEFAULT_MODEL,
  PROVIDER_TYPES,
  PROVIDER_TYPE_LIST,
  providerAuthModes,
  resolveModelCatalog,
} from '@shared/catalog'
import { presetMeta } from '@shared/presets'
import { buildUsageSummary } from '@shared/usage-summary'
import { collectInboxItems } from '../services/inbox'
import { conversationCostSummary } from '../services/budget'
import type { ArenaService } from '../services/arena'
import type { OptimizerService } from '../services/optimizer'
import { modeModelDefault } from '@shared/mode-models'
import { QUICK_SELECTION_MAX_CHARS } from '@shared/quick-actions'
import {
  apiKeySchema,
  chatParamsSchema,
  customToolInputSchema,
  customToolPatchSchema,
  isAllowedHttpUrl,
  mcpServerInputSchema,
  mcpServerPatchSchema,
  memoryInputSchema,
  memoryPatchSchema,
  notebookDocInputSchema,
  notebookDocPatchSchema,
  outboundWebhookUrlSchema,
  promptTemplateInputSchema,
  promptTemplatePatchSchema,
  skillInputSchema,
  skillPatchSchema,
  toolRuleInputSchema,
  providerConfigInputSchema,
  providerConfigPatchSchema,
  providerTypeSchema,
  authModeSchema,
  researchDepthSchema,
  settingsPatchSchema,
  workflowGraphSchema,
  voiceModelIdSchema,
  voiceSttChunkSchema,
  voiceSttSessionSchema,
  voiceTranscribeAttachmentSchema,
  spaceCreateSchema,
  spaceUpdateSchema,
  appLockUnlockSchema,
  appLockSetPassphraseSchema,
  backupExportOptionsSchema,
  KEYLESS_API_KEY,
  isLoopbackBaseUrl,
  isValidStorageKey,
} from '@shared/schemas'
import { detectLocalServers } from '../providers/local-detect'
import type { AppDatabase } from '../db/database'
import type { ChatService } from '../services/chat-service'
import type { CodeService } from '../code/code-service'
import type { GitService } from '../code/git-service'
import type { Keystore } from '../keys/keystore'
import { customToolDbId, type ToolSystem } from '../tools'
import type { McpManager } from '../tools/mcp/manager'
import type { ImBridgeManager } from '../im/manager'
import type { RemoteService } from '../remote/service'
import type { AppLockService } from '../services/app-lock'
import type { ApprovalBroker } from '../services/approval-broker'
import {
  generateTriggerToken,
  type WorkflowTriggerServer,
} from '../workflows/trigger-server'
import type { WorkflowWatcherService } from '../workflows/watcher'
import type { QuestionBroker } from '../services/question-broker'
import { getAdapter, resolveAdapter } from '../providers/registry'
import type { OpenAiOAuthManager } from '../providers/openai-oauth'
import { ProviderError, toNormalizedError } from '../providers/errors'
import { toJson, toMarkdown, exportFileBase } from '../services/export'
import { readSkillsFromFolder } from '../services/skills'
import { applyBackup, buildBackup } from '../services/backup'
import type { IpcHandler, IpcHandlerMap } from './handler-map'
import {
  MAX_IMAGE_BASE64_CHARS,
  PASTED_IMAGE_MIME_TYPES,
  readAttachment,
  readStoredImage,
  storePastedImage,
} from './attachments'
import { extractAttachment } from '../attachments/extract'
import { setOcrCacheDir } from '../attachments/ocr'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export interface RegisterIpcDeps {
  db: AppDatabase
  chatService: ChatService
  codeService: CodeService
  gitService: GitService
  keystore: Keystore
  toolSystem: ToolSystem
  approvalBroker: ApprovalBroker
  /** Desktop notifier — the unread badge follows inbox review state. */
  notifier?: { refreshBadge(): void }
  /** Local trigger endpoint, for its status/URL and token rotation. */
  triggerServer?: WorkflowTriggerServer
  /** Folder-watch triggers — re-synced after every workflow save/delete. */
  workflowWatcher?: WorkflowWatcherService
  questionBroker: QuestionBroker
  mcpManager: McpManager
  imBridgeManager: ImBridgeManager
  oauthManager: OpenAiOAuthManager
  /** Runs saved workflows and records their run history. */
  workflowRunner: WorkflowRunner
  /** Re-arm one-shot schedulers after persisted schedule mutations. */
  wakeWorkflowScheduler?: () => void
  wakeScheduledTaskScheduler?: () => void
  /** Per-task workspace folders (auto-created working dirs for Work tasks). */
  workspaceRoots: WorkspaceRootService
  /** Memory consolidation ("dreaming") — the manual Consolidate-now action. */
  dreamingService: DreamingService
  /** Bot Mode (v46): roster, canonical bot chats, group rooms. */
  botService?: BotService
  /** Bot gateway (v47): per-bot Telegram bindings. */
  botChannels?: BotChannelService
  /** Morning brief: stored digests + dismissal (state lives in settings, main-owned). */
  briefService: Pick<BriefService, 'list' | 'dismiss'>
  /** Knowledge-base chunking/embedding/retrieval. */
  knowledgeService: KnowledgeService
  /** Directory where image attachments are stored on disk. */
  attachmentsDir: string
  /** App-owned directory for isolated Git worktrees. */
  worktreesDir: string
  /** User-driven Work-view terminal sessions (pipes-based, per conversation). */
  terminalService: TerminalService
  /** Offline voice: whisper download/management + STT sessions. */
  voiceService: VoiceService
  /** Code Arena: N models racing the same task in isolated worktrees. */
  arenaService: ArenaService
  /** Autonomous optimize-evaluate-commit loops per project. */
  optimizerService: OptimizerService
  /**
   * Quick-assistant mini window (structural type, not the class — unit tests
   * register with partial deps and no Electron).
   */
  quickWindow?: {
    getContext(): QuickContext
    hide(): void
    sendToQuick(channel: string, payload: unknown): void
  }
  /** Restores + focuses the main window (quick promote navigates there). */
  summonMainWindow?: () => void
  /** Re-registers the quick-assistant accelerator after a settings change. */
  syncQuickShortcut?: () => void
  /**
   * Remote access (phone tunnel). Resolved lazily: the service needs this
   * function's RETURN VALUE (the handler map), so it is constructed after
   * registerIpc returns and reached through this getter ever after.
   */
  getRemoteService: () => RemoteService | null
  getWindows: () => BrowserWindow[]
  /**
   * App lock (optional so partial-deps tests keep working). While locked, the
   * wiring loop below refuses every channel outside LOCK_EXEMPT_CHANNELS.
   */
  appLock?: Pick<AppLockService, 'isLocked' | 'status' | 'lock' | 'unlock' | 'setPassphrase'>
}

const TEST_CONNECTION_TIMEOUT_MS = 15_000

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function invalid(message: string): ProviderError {
  return new ProviderError('invalid_request', message)
}

/** Zod issue messages never echo raw values for the schemas used here. */
function parseInput<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value)
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ')
    throw invalid(detail || 'Invalid input.')
  }
  return result.data
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(`${label} is required.`)
  }
  return value
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalid(`${label} must be a boolean.`)
  return value
}

/** Narrows a lookup/update result, throwing the uniform '<Label> not found.' error. */
function found<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw invalid(`${label} not found.`)
  return value
}

/** Runs `fn`, rethrowing anything it throws as invalid_request (Error message, else `fallback`). */
function asInvalid<T>(fn: () => T, fallback: string): T {
  try {
    return fn()
  } catch (e) {
    throw invalid(e instanceof Error ? e.message : fallback)
  }
}

/** Async variant of `asInvalid` (also converts rejections). */
async function asInvalidAsync<T>(fn: () => Promise<T>, fallback: string): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw invalid(e instanceof Error ? e.message : fallback)
  }
}

// ---------------------------------------------------------------------------
// Schemas without a shared counterpart (hand-rolled, minimal)
// ---------------------------------------------------------------------------

const conversationModeSchema = z.enum(['chat', 'work']) satisfies z.ZodType<ConversationMode>

const previewModelsSchema = z.object({
  type: providerTypeSchema,
  baseUrl: z.string().trim().max(2000).optional(),
  // Same cap as apiKeySchema; used transiently, never stored.
  apiKey: z.string().max(4096).optional(),
  presetId: z.string().max(100).nullable().optional(),
  authMode: authModeSchema.optional(),
})

const convListSchema = z
  .object({
    mode: conversationModeSchema.optional(),
    search: z.string().max(500).optional(),
    projectRef: z.string().min(1).max(200).optional(),
    limit: z.number().int().positive().max(1000).optional(),
    // Private space to list; omitted = the default space. `allSpaces` is a
    // repository-only option this schema deliberately never accepts.
    spaceId: z.string().min(1).max(100).optional(),
  })
  .optional()

const convCreateSchema = z.object({
  mode: conversationModeSchema,
  title: z.string().trim().min(1).max(200).optional(),
  providerId: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  systemPrompt: z.string().max(100_000).nullable().optional(),
  workspaceId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  projectRef: z.string().min(1).nullable().optional(),
  moaPresetId: z.string().min(1).nullable().optional(),
  spaceId: z.string().min(1).max(100).nullable().optional(),
})

const convUpdateSchema = z.object({
  id: z.string().min(1),
  patch: z.object({
    title: z.string().trim().min(1).max(200).optional(),
    providerId: z.string().nullable().optional(),
    modelId: z.string().nullable().optional(),
    systemPrompt: z.string().max(100_000).nullable().optional(),
    params: chatParamsSchema.optional(),
    workspaceId: z.string().min(1).nullable().optional(),
    projectId: z.string().min(1).nullable().optional(),
    projectRef: z.string().min(1).nullable().optional(),
    moaPresetId: z.string().min(1).nullable().optional(),
    knowledgeBaseId: z.string().min(1).nullable().optional(),
    budgetUsd: z.number().positive().max(100_000).nullable().optional(),
  }),
})

const projectListSchema = z
  .object({
    mode: conversationModeSchema.optional(),
  })
  .optional()

const projectCreateSchema = z.object({
  mode: conversationModeSchema,
  name: z.string().trim().min(1).max(200),
})

const projectPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
})

// A non-strict object: unknown keys (e.g. the transient `dataUrl`) are dropped,
// so image previews never get persisted into messages.attachments_json.
const attachmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(500),
  mimeType: z.string().max(200),
  sizeBytes: z.number().int().nonnegative(),
  kind: z.enum(['text', 'image', 'pdf', 'audio']).optional(),
  textContent: z.string().max(2_000_000).optional(),
  // 200k extraction cap + truncation-note margin.
  extractedText: z.string().max(220_000).optional(),
  extraction: z.enum(['text', 'ocr', 'transcript', 'none']).optional(),
  rawAttach: z.boolean().optional(),
  // Only the app-generated '<uuid>.<ext>' shape is a valid key; enforcing it
  // here keeps traversal-shaped keys out of the persisted message row.
  storageKey: z
    .string()
    .max(300)
    .refine(isValidStorageKey, { message: 'Invalid attachment storage key' })
    .optional(),
})

const chatSendSchema = z.object({
  conversationId: z.string().min(1),
  content: z.string().max(1_000_000),
  attachments: z.array(attachmentSchema).max(20).optional(),
  overrides: z
    .object({
      providerId: z.string().optional(),
      modelId: z.string().optional(),
      params: chatParamsSchema.optional(),
      moaPresetId: z.string().min(1).nullable().optional(),
      compare: z.boolean().optional(),
      research: z.object({ depth: researchDepthSchema.optional() }).strict().optional(),
    })
    .optional(),
})

const chatPickCompareWinnerSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  referenceIndex: z.number().int().min(0).max(7),
})

const chatRegenerateSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  overrides: z
    .object({
      providerId: z.string().optional(),
      modelId: z.string().optional(),
    })
    .optional(),
  mode: z.enum(['replace', 'second-opinion']).optional(),
})

const chatEditAndRerunSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  newContent: z.string().max(1_000_000),
})

const quickRunSchema = z
  .object({
    actionId: z.string().min(1).max(100),
    selection: z.string().max(QUICK_SELECTION_MAX_CHARS),
  })
  .strict()

const quickPromoteSchema = z
  .object({
    userText: z.string().min(1).max(100_000),
    answer: z.string().min(1).max(1_000_000),
    providerId: z.string().min(1).max(200),
    modelId: z.string().min(1).max(200),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict()

const workspaceCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  goal: z.string().max(10_000).optional(),
})

const workspacePatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  goal: z.string().max(10_000).nullable().optional(),
  status: z.enum(['active', 'done', 'archived']).optional(),
})

const workspaceItemKindSchema = z.enum([
  'note',
  'plan',
  'checklist',
  'doc',
  'task',
]) satisfies z.ZodType<WorkspaceItemKind>

const workspaceItemCreateSchema = z.object({
  workspaceId: z.string().min(1),
  kind: workspaceItemKindSchema,
  title: z.string().trim().min(1).max(300),
  content: z.string().max(200_000).optional(),
  origin: z.enum(['user', 'assistant']),
})

const workspaceItemPatchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  content: z.string().max(200_000).optional(),
  status: z.enum(['todo', 'doing', 'done']).nullable().optional(),
  sort: z.number().int().optional(),
  kind: workspaceItemKindSchema.optional(),
})

const toolPermissionDecisionSchema = z.enum([
  'always_allow',
  'ask',
  'deny',
]) satisfies z.ZodType<ToolPermissionDecision>

const codeReadFileSchema = z.object({
  projectId: z.string().min(1),
  relPath: z.string().min(1).max(2000),
})

const codeSuggestFilesSchema = z.object({
  projectId: z.string().min(1),
  query: z.string().max(500),
  limit: z.number().int().positive().max(50).optional(),
})

const approvalScopeSchema = z.enum(['once', 'conversation'])

const convExportSchema = z.object({
  conversationId: z.string().min(1),
  format: z.enum(['markdown', 'json']),
})

const imTelegramSchema = z
  .object({
    token: z.string().max(4096).optional(),
    conversationId: z.string().nullable(),
    enabled: z.boolean(),
  })
  .strict()

// Handler-input schemas, hoisted to module level: building them inline would
// reconstruct identical parser objects on every IPC call (terminalInput runs
// per keystroke; activityList per page scroll).

const appStorePastedImageSchema = z.object({
  mimeType: z.enum(PASTED_IMAGE_MIME_TYPES),
  dataBase64: z
    .string()
    .min(1)
    .max(MAX_IMAGE_BASE64_CHARS)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Invalid base64 image data'),
})

const appSaveAttachmentAsSchema = z.object({
  storageKey: z
    .string()
    .max(300)
    .refine(isValidStorageKey, { message: 'Invalid attachment storage key' }),
  suggestedName: z.string().max(200).optional(),
})

const appExtractAttachmentSchema = z.object({
  storageKey: z
    .string()
    .max(300)
    .refine(isValidStorageKey, { message: 'Invalid attachment storage key' }),
  method: z.enum(['text', 'ocr']),
})

const convForkSchema = z.object({
  id: z.string().min(1),
  /** Fork point: copy messages up to and including this one (omit = whole transcript). */
  messageId: z.string().min(1).optional(),
})

const documentsRevertSchema = z.object({
  id: z.string().min(1),
  versionId: z.number().int().positive(),
})

const gitCommitSchema = z.object({ projectId: z.string().min(1), message: z.string().min(1).max(5000) })

const gitBranchSchema = z.object({ projectId: z.string().min(1), name: z.string().min(1).max(200) })

const gitSetOriginSchema = z.object({
  projectId: z.string().min(1),
  url: z.string().trim().min(1).max(2_000),
})

const gitPushSchema = z.object({ projectId: z.string().min(1), confirmDefaultBranch: z.boolean() })

const githubPrCreateSchema = z.object({
  projectId: z.string().min(1),
  input: z.object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(20_000).optional(),
    base: z.string().trim().min(1).max(200).optional(),
    draft: z.boolean().optional(),
  }),
})

const worktreeCreateSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().max(100).optional(),
})

const turnRevertSchema = z.object({
  conversationId: z.string().min(1),
  messageSeq: z.number().int().min(0),
})

const arenaStartSchema = z.object({
  conversationId: z.string().min(1),
  task: z.string().trim().min(1).max(20_000),
  candidates: z
    .array(z.object({ providerId: z.string().min(1), modelId: z.string().min(1).max(200) }))
    .min(2)
    .max(4),
  // Evolutionary rounds (LLM-judged; the winner seeds the next round).
  rounds: z.number().int().min(1).max(5).optional(),
})

const arenaApplySchema = z.object({ conversationId: z.string().min(1), runId: z.string().min(1) })

const inboxMarkReviewedSchema = z.object({
  itemType: z.enum(['agent_run', 'workflow_run', 'scheduled_task_run']),
  itemId: z.string().min(1).max(200),
})

const terminalInputSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string().min(1).max(8_192),
})

const activityListSchema = z
  .object({
    limit: z.number().int().min(1).max(500).optional(),
    // The whole cursor, not just the timestamp: entries that share a
    // millisecond are ordered by insertion, and paging has to follow.
    before: z
      .object({ at: z.number().int().positive(), seq: z.number().int().positive() })
      .strict()
      .optional(),
    decision: z.enum(['auto', 'rule', 'approved', 'declined', 'blocked']).optional(),
    search: z.string().max(200).optional(),
  })
  .strict()
  .optional()

const workflowsRunOptsSchema = z.object({ dryRun: z.boolean().optional() }).optional()

const optimizerStartSchema = z.object({
  projectId: z.string().min(1),
  goal: z.string().trim().min(1).max(4_000),
  evalCommand: z.string().trim().min(1).max(2_000),
  testCommand: z.string().trim().max(2_000).optional(),
  providerId: z.string().min(1).nullable().optional(),
  modelId: z.string().min(1).max(200).nullable().optional(),
  maxRounds: z.number().int().min(1).max(40).optional(),
  direction: z.enum(['maximize', 'minimize']).optional(),
  allowShell: z.boolean().optional(),
})

// ---------------------------------------------------------------------------
// Settings cleanup
// ---------------------------------------------------------------------------

/**
 * The settings patch that removes every reference to a deleted provider: the
 * global/per-mode/research/image defaults are cleared, and a MoA preset that
 * routed through it is disabled (its advisors on the provider are dropped, but
 * never the last one — the schema requires at least one reference model).
 * Without this, new conversations keep getting stamped with a provider that no
 * longer exists and every send fails.
 */
function providerRefsCleared(settings: AppSettings, providerId: string): Partial<AppSettings> {
  const patch: Partial<AppSettings> = {}
  if (settings.defaultProviderId === providerId) {
    patch.defaultProviderId = null
    patch.defaultModelId = null
  }
  if (settings.researchWorkerProviderId === providerId) {
    patch.researchWorkerProviderId = null
    patch.researchWorkerModelId = null
  }
  if (settings.defaultImageProviderId === providerId) {
    patch.defaultImageProviderId = null
    patch.defaultImageModelId = null
  }
  const modeModels = { ...settings.modeModels }
  let modeChanged = false
  for (const mode of conversationModeSchema.options) {
    if (modeModels[mode]?.providerId === providerId) {
      modeModels[mode] = { providerId: null, modelId: null }
      modeChanged = true
    }
  }
  if (modeChanged) patch.modeModels = modeModels
  let presetsChanged = false
  const moaPresets = settings.moaPresets.map((preset) => {
    const references = preset.referenceModels.filter((m) => m.providerId !== providerId)
    const broken =
      references.length !== preset.referenceModels.length ||
      preset.aggregator.providerId === providerId
    if (!broken) return preset
    presetsChanged = true
    return {
      ...preset,
      referenceModels: references.length > 0 ? references : preset.referenceModels,
      enabled: false,
    }
  })
  if (presetsChanged) patch.moaPresets = moaPresets
  return patch
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerIpc(deps: RegisterIpcDeps): IpcHandlerMap {
  const { db, chatService, codeService, gitService, keystore, toolSystem, approvalBroker, questionBroker, oauthManager } = deps

  // Handlers collect here first, then wire to ipcMain in one loop at the end.
  // Returning the map lets the remote service (phone tunnel) invoke the exact
  // same functions under its own allowlist — one implementation, two transports.
  const handlers: IpcHandlerMap = new Map()

  const register = (channel: ChannelName, fn: IpcHandler): void => {
    // Restore the loud guard the old ipcMain.handle path gave for free: a
    // duplicate registration is a copy-paste bug, and last-write-wins would
    // silently drop one handler's logic. Fail at startup instead.
    if (handlers.has(channel)) {
      throw new Error(`IPC channel registered twice: ${channel}`)
    }
    handlers.set(channel, fn)
  }

  const dialogParent = (): BrowserWindow | undefined =>
    BrowserWindow.getFocusedWindow() ?? deps.getWindows()[0]

  const showOpen = (options: OpenDialogOptions): Promise<OpenDialogReturnValue> => {
    const parent = dialogParent()
    return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)
  }

  const showSave = (options: SaveDialogOptions): Promise<SaveDialogReturnValue> => {
    const parent = dialogParent()
    return parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options)
  }

  /** Shared save-dialog → write flow used by the export handlers. */
  const saveTextFile = async (
    defaultPath: string,
    filters: FileFilter[],
    content: string
  ): Promise<{ canceled: boolean; path?: string }> => {
    const result = await showSave({ defaultPath, filters })
    if (result.canceled || !result.filePath) return { canceled: true }
    await writeFile(result.filePath, content, 'utf8')
    return { canceled: false, path: result.filePath }
  }

  const requireProvider = (id: unknown) => {
    const provider = db.providers.getById(requireString(id, 'Provider id'))
    if (!provider) throw invalid('Provider not found.')
    return provider
  }

  // -- app --------------------------------------------------------------------

  register(CHANNELS.appGetInfo, (): AppInfo => {
    const platform: AppInfo['platform'] =
      process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '',
      platform,
      encryptionAvailable: keystore.encryptionAvailable(),
      userDataPath: app.getPath('userData'),
    }
  })

  register(CHANNELS.appPickFolder, async (): Promise<string | null> => {
    const result = await showOpen({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  register(CHANNELS.appPickFiles, async (): Promise<PickFilesResult> => {
    const result = await showOpen({ properties: ['openFile', 'multiSelections'] })
    if (result.canceled) return { attachments: [] }
    const attachments: Attachment[] = []
    for (const filePath of result.filePaths) {
      const attachment = await readAttachment(filePath, deps.attachmentsDir)
      if (attachment) attachments.push(attachment)
    }
    return { attachments }
  })

  register(CHANNELS.appStorePastedImage, async (req) => {
    const parsed = parseInput(appStorePastedImageSchema, req)
    return storePastedImage(deps.attachmentsDir, parsed.mimeType, parsed.dataBase64)
  })

  register(CHANNELS.appReadAttachment, (storageKey) =>
    readStoredImage(deps.attachmentsDir, requireString(storageKey, 'Attachment key'))
  )

  // Guarded: unit tests register with partial deps and no attachments dir.
  if (deps.attachmentsDir) setOcrCacheDir(join(deps.attachmentsDir, '.ocr-cache'))
  register(CHANNELS.appExtractAttachmentText, async (req) => {
    const parsed = parseInput(appExtractAttachmentSchema, req)
    return extractAttachment(deps.attachmentsDir, parsed.storageKey, parsed.method)
  })

  register(CHANNELS.appSaveAttachmentAs, async (req) => {
    const parsed = parseInput(appSaveAttachmentAsSchema, req)
    // Same gate as readStoredImage: only app-shaped keys, only image mimes.
    const stored = await readStoredImage(deps.attachmentsDir, parsed.storageKey)
    if (!stored) throw invalid('That image is no longer available.')
    const defaultName =
      parsed.suggestedName && /^[^\\/:*?"<>|]+$/.test(parsed.suggestedName)
        ? parsed.suggestedName
        : parsed.storageKey
    const result = await showSave({
      defaultPath: defaultName,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    await copyFile(join(deps.attachmentsDir, parsed.storageKey), result.filePath)
    return { canceled: false, path: result.filePath }
  })

  // -- settings -----------------------------------------------------------------

  register(CHANNELS.settingsGet, () => db.settings.get())

  register(CHANNELS.settingsUpdate, (patch) => {
    const parsed = parseInput(settingsPatchSchema, patch)
    let updated = db.settings.update(parsed)
    // Switching the trigger endpoint on for the first time mints its secret.
    // The token is not part of the patch surface at all (see settingsPatchSchema),
    // so it is written here on its own and no IPC payload can choose one.
    if (parsed.workflowWebhookEnabled === true && !updated.workflowWebhookToken) {
      updated = db.settings.update({ workflowWebhookToken: generateTriggerToken() })
    }
    if (parsed.workflowWebhookEnabled !== undefined || parsed.workflowWebhookPort !== undefined) {
      deps.triggerServer?.sync()
    }
    // Re-register the quick-assistant accelerator the moment it changes.
    if (parsed.quickAssistantShortcut !== undefined) deps.syncQuickShortcut?.()
    return updated
  })

  // -- providers ----------------------------------------------------------------

  register(CHANNELS.providersListTypes, () => PROVIDER_TYPE_LIST)

  register(CHANNELS.providersList, () => db.providers.list())

  register(CHANNELS.providersCreate, (input) => {
    const parsed = parseInput(providerConfigInputSchema, input)
    // A preset always maps onto the openai-compatible adapter; its base URL /
    // default model come from the generated catalog when not overridden.
    let preset
    let type = parsed.type
    if (parsed.presetId) {
      preset = presetMeta(parsed.presetId)
      if (!preset) throw invalid('Unknown provider preset.')
      type = 'openai-compatible'
    }
    const meta = PROVIDER_TYPES[type]
    const baseUrl = (parsed.baseUrl ?? '').trim() || preset?.baseUrl || meta.defaultBaseUrl
    if (type === 'openai-compatible' && baseUrl.length === 0) {
      throw invalid('A base URL is required for custom OpenAI-compatible providers.')
    }
    // Only permit an auth mode the family actually supports (the UI enforces
    // this too; the guard keeps a malformed provider out of the DB).
    if (parsed.authMode && !providerAuthModes(type).includes(parsed.authMode)) {
      throw invalid(`${meta.label} does not support that authentication method.`)
    }
    // ChatGPT-login providers default to a Codex-backend model, not the family
    // API default (gpt-4o), which that backend rejects.
    const familyDefault =
      parsed.authMode === 'chatgpt_oauth'
        ? CHATGPT_OAUTH_DEFAULT_MODEL
        : preset?.defaultModelId || meta.defaultModelId
    const defaultModelId = (parsed.defaultModelId ?? '').trim() || familyDefault
    return db.providers.create({ ...parsed, type, id: randomUUID(), baseUrl, defaultModelId })
  })

  register(CHANNELS.providersUpdate, (id, patch) => {
    const providerId = requireString(id, 'Provider id')
    const parsed = parseInput(providerConfigPatchSchema, patch)
    return found(db.providers.update(providerId, parsed), 'Provider')
  })

  register(CHANNELS.providersDelete, (id) => {
    const providerId = requireString(id, 'Provider id')
    // Delete the provider and clear every reference to it in one transaction so
    // no dangling settings id or conversation.provider_id survives.
    db.driver.transaction(() => {
      const patch = providerRefsCleared(db.settings.get(), providerId)
      if (Object.keys(patch).length > 0) db.settings.update(patch)
      db.conversations.clearProvider(providerId)
      // A space allowlist naming only this provider collapses to null (= all
      // providers) rather than leaving a space that can never generate.
      db.spaces.removeProviderFromAllowlists(providerId)
      db.providers.remove(providerId)
    })
    return undefined
  })

  register(CHANNELS.providersSetKey, (id, apiKey) => {
    const provider = requireProvider(id)
    const key = parseInput(apiKeySchema, apiKey)
    const { encryptedBase64, preview } = keystore.encryptKey(key)
    db.providers.setKeyRow(provider.id, encryptedBase64, preview)
    return found(db.providers.getById(provider.id), 'Provider')
  })

  register(CHANNELS.providersDeleteKey, (id) => {
    const provider = requireProvider(id)
    db.providers.deleteKeyRow(provider.id)
    return found(db.providers.getById(provider.id), 'Provider')
  })

  register(CHANNELS.providersTest, async (id) => {
    const provider = requireProvider(id)
    // Resolve the credential per auth mode: OAuth token or decrypted key.
    let apiKey: string
    let accountId: string | null = null
    if (provider.authMode === 'chatgpt_oauth') {
      const token = await oauthManager.getAccessToken(provider.id)
      apiKey = token.accessToken
      accountId = token.accountId
    } else {
      const encrypted = db.providers.getEncryptedKey(provider.id)
      if (encrypted) {
        apiKey = keystore.decryptKey(encrypted)
      } else if (provider.type === 'openai-compatible' && isLoopbackBaseUrl(provider.baseUrl)) {
        // Loopback servers (Ollama, LM Studio, …) accept any bearer; the
        // placeholder only ever travels to this provider's own local URL.
        // Same gate as chat-service key resolution + renderer providerUsable,
        // so Test never asserts a provider works that chat would refuse.
        apiKey = KEYLESS_API_KEY
      } else {
        throw new ProviderError('auth', 'Add an API key first.', { retryable: false })
      }
    }
    // Probe with the provider's chosen model (falling back to the catalog
    // default) so Test validates the model the user actually configured.
    const catalog = resolveModelCatalog(provider)
    const modelCatalog = provider.defaultModelId
      ? { ...catalog, defaultModelId: provider.defaultModelId }
      : catalog
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TEST_CONNECTION_TIMEOUT_MS)
    try {
      return await resolveAdapter(provider.type, provider.authMode).testConnection({
        apiKey,
        baseUrl: provider.baseUrl,
        accountId,
        modelCatalog,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  })

  register(CHANNELS.providersListModels, async (id) => {
    const provider = requireProvider(id)
    const modelCatalog = resolveModelCatalog(provider)
    if (provider.authMode === 'chatgpt_oauth') {
      // Model list is static for the ChatGPT backend; no key needed.
      return resolveAdapter(provider.type, provider.authMode).listModels({
        apiKey: '',
        baseUrl: provider.baseUrl,
        modelCatalog,
      })
    }
    const encrypted = db.providers.getEncryptedKey(provider.id)
    // No key yet: loopback servers (Ollama, LM Studio, …) list models keyless;
    // everything else falls back to the catalog (family or preset) instead of
    // failing.
    if (!encrypted) {
      if (provider.type === 'openai-compatible' && isLoopbackBaseUrl(provider.baseUrl)) {
        try {
          return await getAdapter(provider.type).listModels({
            apiKey: KEYLESS_API_KEY,
            baseUrl: provider.baseUrl,
            modelCatalog,
          })
        } catch {
          return modelCatalog.knownModels
        }
      }
      return modelCatalog.knownModels
    }
    const apiKey = keystore.decryptKey(encrypted)
    return getAdapter(provider.type).listModels({ apiKey, baseUrl: provider.baseUrl, modelCatalog })
  })

  register(CHANNELS.providersPreviewModels, async (req) => {
    const parsed = parseInput(previewModelsSchema, req)
    const meta = PROVIDER_TYPES[parsed.type]
    const authMode = parsed.authMode ?? 'api_key'
    const modelCatalog = resolveModelCatalog({ type: parsed.type, presetId: parsed.presetId ?? null })
    const baseUrl = parsed.baseUrl?.trim() || meta.defaultBaseUrl
    // Never send the key to a plaintext remote endpoint.
    if (baseUrl && !isAllowedHttpUrl(baseUrl)) {
      throw invalid('Base URL must use https:// (http:// is only allowed for localhost).')
    }
    const apiKey = parsed.apiKey?.trim() ?? ''
    try {
      // OAuth returns its static Codex list (no key); listing families fetch
      // /models with the ad-hoc key; the rest return their static catalog.
      return await resolveAdapter(parsed.type, authMode).listModels({ apiKey, baseUrl, modelCatalog })
    } catch {
      // Bad key / unreachable / no /models: fall back to the known catalog so the
      // user can still pick a model (or type a custom id).
      return modelCatalog.knownModels
    }
  })

  // Read-only loopback probe (Ollama/LM Studio/Jan/llama.cpp) for the
  // zero-key first chat; never touches anything beyond localhost.
  register(CHANNELS.providersDetectLocal, () => detectLocalServers())

  register(CHANNELS.providersOauthStart, async (id) => {
    const provider = requireProvider(id)
    if (provider.authMode !== 'chatgpt_oauth') {
      throw invalid('This provider does not use ChatGPT sign-in.')
    }
    return await oauthManager.startLogin(provider.id)
  })

  register(CHANNELS.providersOauthLogout, (id) => {
    const provider = requireProvider(id)
    oauthManager.logout(provider.id)
    return oauthManager.status(provider.id)
  })

  register(CHANNELS.providersOauthStatus, (id) => {
    const provider = requireProvider(id)
    return oauthManager.status(provider.id)
  })

  // -- conversations --------------------------------------------------------------

  register(CHANNELS.convList, (req) => db.conversations.list(parseInput(convListSchema, req)))

  register(CHANNELS.convCreate, (req) => {
    const parsed = parseInput(convCreateSchema, req)
    if (parsed.spaceId) found(db.spaces.getById(parsed.spaceId), 'Space')
    // Stamp the per-mode default provider/model onto the new conversation when
    // the caller didn't specify one and the feature is on for this mode.
    if (parsed.providerId == null && parsed.modelId == null) {
      const modeDefault = modeModelDefault(db.settings.get(), parsed.mode)
      if (modeDefault) {
        return db.conversations.create({
          ...parsed,
          providerId: modeDefault.providerId,
          modelId: modeDefault.modelId,
        })
      }
    }
    return db.conversations.create(parsed)
  })

  register(CHANNELS.convGet, (id) =>
    found(db.conversations.getById(requireString(id, 'Conversation id')), 'Conversation')
  )

  register(CHANNELS.convUpdate, (req) => {
    const parsed = parseInput(convUpdateSchema, req)
    return found(db.conversations.update(parsed.id, parsed.patch), 'Conversation')
  })

  register(CHANNELS.convDelete, (id) => {
    const conversationId = requireString(id, 'Conversation id')
    // Stop any generation running in this conversation before deleting its rows
    // so the detached loop doesn't write to messages that no longer exist.
    chatService.stopConversation(conversationId)
    // A Work task's auto-created workspace folder dies with it (user-granted
    // folders are never touched — the service checks the path prefix).
    const conversation = db.conversations.getById(conversationId)
    if (conversation) deps.workspaceRoots.deleteIfAutoRegistered(conversation)
    // Standing approval rules scoped to this conversation go with it. A left
    // dangling rule would be inert, but it would also clutter Settings with
    // entries pointing at a chat the user can no longer see.
    db.toolRules.removeByScope('conversation', conversationId)
    db.conversations.remove(conversationId)
    return undefined
  })

  register(CHANNELS.convMessages, (conversationId) =>
    db.messages.listByConversation(requireString(conversationId, 'Conversation id'))
  )

  register(CHANNELS.convExport, async (req) => {
    const parsed = parseInput(convExportSchema, req)
    const conversation = found(db.conversations.getById(parsed.conversationId), 'Conversation')
    const messages = db.messages.listByConversation(parsed.conversationId)
    const isMarkdown = parsed.format === 'markdown'
    const content = isMarkdown ? toMarkdown(conversation, messages) : toJson(conversation, messages)
    const ext = isMarkdown ? 'md' : 'json'
    return saveTextFile(
      `${exportFileBase(conversation)}.${ext}`,
      [
        isMarkdown
          ? { name: 'Markdown', extensions: ['md'] }
          : { name: 'JSON', extensions: ['json'] },
      ],
      content
    )
  })

  register(CHANNELS.convFork, (req) => {
    const parsed = parseInput(convForkSchema, req)
    const source = found(db.conversations.getById(parsed.id), 'Conversation')
    const messages = db.messages.listByConversation(source.id)
    // Scoping the find to the source's own messages doubles as an ownership
    // check: a messageId from another conversation is simply "not found".
    const target =
      parsed.messageId === undefined
        ? undefined
        : found(messages.find((m) => m.id === parsed.messageId), 'Message')
    const copied = target ? messages.filter((m) => m.seq <= target.seq) : messages
    const forkPoint = target ?? copied[copied.length - 1]
    // One transaction: a fork is the conversation AND its transcript — a
    // partially copied fork would look like a valid (silently truncated) one.
    return db.driver.transaction(() => {
      const fork = db.conversations.create({
        mode: source.mode,
        title: `${source.title} (fork)`,
        providerId: source.providerId,
        modelId: source.modelId,
        systemPrompt: source.systemPrompt,
        // Forks get an independent task workspace on first use; sharing the
        // source workspace would make one branch mutate the other's checklist.
        workspaceId: null,
        projectId: source.projectId,
        projectRef: source.projectRef,
        moaPresetId: source.moaPresetId,
        // KB attachment is steering config like the model choice: a fork keeps
        // it (the base is only ever nulled here if it was already deleted).
        knowledgeBaseId: source.knowledgeBaseId,
        // Provenance stores SOURCE ids (message ids are regenerated below).
        parentConversationId: source.id,
        forkedAtMessageId: forkPoint?.id ?? null,
        // A fork of a private conversation stays in its space (v45).
        spaceId: source.spaceId,
      })
      if (Object.keys(source.params).length > 0) {
        db.conversations.update(fork.id, { params: source.params })
      }
      // Keep the compaction summary only when the fork contains everything it
      // covers; forking before the compaction point drops it.
      if (
        source.summaryText != null &&
        source.summaryThroughSeq != null &&
        (forkPoint?.seq ?? 0) >= source.summaryThroughSeq
      ) {
        db.conversations.setSummary(fork.id, source.summaryText, source.summaryThroughSeq)
      }
      for (const message of copied) {
        db.messages.insert({
          ...message,
          id: randomUUID(),
          conversationId: fork.id,
          // Cost attribution stays with the source: copying usage would make
          // the month-to-date budget aggregates count the same tokens twice.
          usage: undefined,
          // A copied row mid-generation can never resume (backup-import rule).
          status: message.status === 'streaming' ? 'stopped' : message.status,
        })
      }
      return db.conversations.getById(fork.id)!
    })
  })

  register(CHANNELS.convForkLineage, (id) => {
    const conversation = found(
      db.conversations.getById(requireString(id, 'Conversation id')),
      'Conversation'
    )
    const parentId = conversation.parentConversationId ?? null
    if (!parentId) return { parent: null, siblings: [] }
    // Provenance is not an FK: the parent may be gone, but its other forks
    // still resolve through the (dangling) pointer.
    const parent = db.conversations.getById(parentId)
    return {
      parent: parent ? { id: parent.id, title: parent.title } : null,
      siblings: db.conversations.listForks(parentId).filter((f) => f.id !== conversation.id),
    }
  })

  // -- private spaces (v45) ---------------------------------------------------

  const rejectDuplicateSpaceName = (name: string, excludeId?: string): void => {
    const lower = name.toLowerCase()
    if (db.spaces.list().some((s) => s.id !== excludeId && s.name.toLowerCase() === lower)) {
      throw invalid('A space with that name already exists.')
    }
  }

  register(CHANNELS.spacesList, () => db.spaces.list())

  register(CHANNELS.spacesCreate, (req) => {
    const parsed = parseInput(spaceCreateSchema, req)
    rejectDuplicateSpaceName(parsed.name)
    return db.spaces.create({ name: parsed.name })
  })

  register(CHANNELS.spacesUpdate, (req) => {
    const parsed = parseInput(spaceUpdateSchema, req)
    if (parsed.patch.name !== undefined) rejectDuplicateSpaceName(parsed.patch.name, parsed.id)
    if (parsed.patch.providerAllowlist) {
      for (const providerId of parsed.patch.providerAllowlist) {
        if (!db.providers.getById(providerId)) throw invalid('Unknown provider in allowlist.')
      }
    }
    return found(db.spaces.update(parsed.id, parsed.patch), 'Space')
  })

  register(CHANNELS.spacesDelete, (id) => {
    const spaceId = requireString(id, 'Space id')
    found(db.spaces.getById(spaceId), 'Space')
    if (db.spaces.countConversations(spaceId) > 0) {
      throw invalid(
        'Delete or finish its conversations first — a space can only be deleted when empty.'
      )
    }
    db.spaces.remove(spaceId)
    return undefined
  })

  // -- app lock ---------------------------------------------------------------

  const requireLock = (): NonNullable<RegisterIpcDeps['appLock']> => {
    if (!deps.appLock) throw invalid('App lock is unavailable.')
    return deps.appLock
  }

  register(CHANNELS.lockStatus, () =>
    deps.appLock
      ? deps.appLock.status()
      : { configured: false, locked: false, idleMinutes: null }
  )

  register(CHANNELS.lockUnlock, (req) =>
    requireLock().unlock(parseInput(appLockUnlockSchema, req).passphrase)
  )

  register(CHANNELS.lockNow, () => {
    const lock = requireLock()
    lock.lock()
    return lock.status()
  })

  register(CHANNELS.lockSetPassphrase, (req) =>
    requireLock().setPassphrase(parseInput(appLockSetPassphraseSchema, req))
  )

  // -- projects (per-mode organizational grouping) ---------------------------------

  register(CHANNELS.projectsList, (req) => {
    const parsed = parseInput(projectListSchema, req)
    return db.projects.list(parsed?.mode)
  })

  register(CHANNELS.projectsCreate, (input) =>
    db.projects.create(parseInput(projectCreateSchema, input))
  )

  register(CHANNELS.projectsUpdate, (id, patch) => {
    const projectId = requireString(id, 'Project id')
    return found(db.projects.update(projectId, parseInput(projectPatchSchema, patch)), 'Project')
  })

  register(CHANNELS.projectsDelete, (id) => {
    db.projects.remove(requireString(id, 'Project id'))
    return undefined
  })

  // -- data maintenance ------------------------------------------------------------

  register(CHANNELS.dataDeleteAllContent, async () => {
    // Abort (and persist) any in-flight generation first so no detached loop
    // writes to rows we are about to delete.
    await chatService.stopAll()
    db.driver.transaction(() => {
      db.conversations.deleteAll() // cascades messages + documents
      db.workspaces.deleteAll() // cascades workspace_items
      db.projects.deleteAll()
      db.scheduledTasks.deleteAll()
      // Approval rules point at conversations and projects that are going
      // away; a standing "always allow" must not outlive the content it was
      // granted for.
      db.toolRules.deleteAll()
    })
    // After the rows are gone: sweep every auto-created task workspace folder
    // (rows + dirs). User-granted folder rows survive as they always did.
    deps.workspaceRoots.deleteAll()
    return undefined
  })

  // -- chat ------------------------------------------------------------------------

  register(CHANNELS.chatSend, (req) => {
    const parsed = parseInput(chatSendSchema, req)
    const content = parsed.content.trim()
    const hasAttachments = (parsed.attachments?.length ?? 0) > 0
    if (content.length === 0 && !hasAttachments) {
      throw invalid('Type a message or attach a file first.')
    }
    // queueIfBusy (v47): a send into a busy conversation persists + queues the
    // message instead of erroring; one coalesced turn drains after completion.
    return chatService.send({ ...parsed, content }, { queueIfBusy: true })
  })

  register(CHANNELS.chatStop, (streamId) => {
    chatService.stop(requireString(streamId, 'Stream id'))
    return undefined
  })

  register(CHANNELS.chatRegenerate, (req) =>
    chatService.regenerate(parseInput(chatRegenerateSchema, req))
  )

  // Manual context compaction (the /compact command).
  register(CHANNELS.chatCompact, (conversationId) =>
    chatService.compactNow(requireString(conversationId, 'Conversation id'))
  )

  register(CHANNELS.chatEditAndRerun, (req) => {
    const parsed = parseInput(chatEditAndRerunSchema, req)
    const newContent = parsed.newContent.trim()
    if (newContent.length === 0) throw invalid('The edited message cannot be empty.')
    return chatService.editAndRerun({ ...parsed, newContent })
  })

  // Promote one advisor of a compare ("Arena") run to the message's answer.
  register(CHANNELS.chatPickCompareWinner, (req) =>
    chatService.pickCompareWinner(parseInput(chatPickCompareWinnerSchema, req))
  )

  // -- quick assistant (clipboard mini window) --------------------------------
  // Deliberately NOT in the remote router's allowlists: quick content is
  // desktop-local and its stream events are targeted, never broadcast.

  register(CHANNELS.quickRun, (req) => {
    const parsed = parseInput(quickRunSchema, req)
    const action = db.settings.get().quickActions.find((a) => a.id === parsed.actionId)
    if (!action) throw invalid('Quick action not found.')
    return chatService.startQuickStream({
      action,
      selection: parsed.selection,
      emit: (envelope) => deps.quickWindow?.sendToQuick(CHANNELS.quickStreamEvent, envelope),
    })
  })

  register(
    CHANNELS.quickGetContext,
    (): QuickContext => deps.quickWindow?.getContext() ?? { selectionText: '', truncated: false }
  )

  register(CHANNELS.quickHide, () => {
    deps.quickWindow?.hide()
    return undefined
  })

  register(CHANNELS.quickPromote, (req) => {
    const parsed = parseInput(quickPromoteSchema, req)
    const conversation = chatService.promoteQuick(parsed)
    deps.summonMainWindow?.()
    deps.quickWindow?.hide()
    return { conversationId: conversation.id }
  })

  // -- cowork workspaces --------------------------------------------------------------

  register(CHANNELS.workspaceList, () => db.workspaces.list())

  register(CHANNELS.workspaceCreate, (input) =>
    db.workspaces.create(parseInput(workspaceCreateSchema, input))
  )

  register(CHANNELS.workspaceGet, (id) =>
    found(db.workspaces.getById(requireString(id, 'Workspace id')), 'Workspace')
  )

  register(CHANNELS.workspaceUpdate, (id, patch) => {
    const workspaceId = requireString(id, 'Workspace id')
    return found(
      db.workspaces.update(workspaceId, parseInput(workspacePatchSchema, patch)),
      'Workspace'
    )
  })

  register(CHANNELS.workspaceDelete, (id) => {
    db.workspaces.remove(requireString(id, 'Workspace id'))
    return undefined
  })

  register(CHANNELS.workspaceItemsList, (workspaceId) =>
    db.workspaces.itemsList(requireString(workspaceId, 'Workspace id'))
  )

  register(CHANNELS.workspaceItemCreate, (input) =>
    db.workspaces.itemCreate(parseInput(workspaceItemCreateSchema, input))
  )

  register(CHANNELS.workspaceItemUpdate, (id, patch) => {
    const itemId = requireString(id, 'Item id')
    return found(
      db.workspaces.itemUpdate(itemId, parseInput(workspaceItemPatchSchema, patch)),
      'Workspace item'
    )
  })

  register(CHANNELS.workspaceItemDelete, (id) => {
    db.workspaces.itemDelete(requireString(id, 'Item id'))
    return undefined
  })

  // -- working folders + code pipeline ----------------------------------------------

  // autoCreated marks the app's own per-task workspace folders (derived from
  // the path prefix) so the renderer can hide them from folder pickers.
  register(CHANNELS.codeProjectsList, () =>
    db.code.projectsList().map((project) => deps.workspaceRoots.withAutoFlag(project))
  )

  // The path always comes from the OS folder picker — the explicit user grant.
  register(CHANNELS.codeProjectOpen, (path) =>
    codeService.openProject(requireString(path, 'Project path'))
  )

  register(CHANNELS.codeProjectForget, (id) => {
    db.code.projectForget(requireString(id, 'Project id'))
    return undefined
  })

  register(CHANNELS.codeProjectReveal, async (id) => {
    const project = found(db.code.projectGetById(requireString(id, 'Project id')), 'Project')
    if (!existsSync(project.path)) throw invalid('The folder no longer exists.')
    const failure = await shell.openPath(project.path)
    if (failure) throw invalid('Could not open the folder in the file explorer.')
    return undefined
  })

  register(CHANNELS.codeFileTree, (projectId) =>
    codeService.fileTree(requireString(projectId, 'Project id'))
  )

  register(CHANNELS.codeReadFile, (req) => {
    const parsed = parseInput(codeReadFileSchema, req)
    return codeService.readFile(parsed.projectId, parsed.relPath)
  })

  register(CHANNELS.codeChangesList, (projectId) =>
    db.code.changesList(requireString(projectId, 'Project id'))
  )

  // Only ever invoked from an explicit user approval click in the renderer —
  // this is the sole write path into a user project.
  register(CHANNELS.codeChangeApply, (changeId) =>
    codeService.applyChange(requireString(changeId, 'Change id'))
  )

  register(CHANNELS.codeChangeReject, (changeId) =>
    codeService.rejectChange(requireString(changeId, 'Change id'))
  )

  // Restores an APPLIED change's pre-change content — explicit user click only.
  register(CHANNELS.codeChangeRevert, (changeId) =>
    codeService.revertChange(requireString(changeId, 'Change id'))
  )

  register(CHANNELS.codeSuggestFiles, (req) => {
    const parsed = parseInput(codeSuggestFilesSchema, req)
    return codeService.suggestFiles(parsed.projectId, parsed.query, parsed.limit ?? 12)
  })

  // The cross-conversation review queue: all of a project's changes with
  // their conversation titles.
  register(CHANNELS.codeChangesListAll, (projectId) =>
    codeService.listChangesWithContext(requireString(projectId, 'Project id'))
  )

  // -- code git (commit bar; every handler is reached from an explicit click,
  //    which IS the consent — no approval broker involved) ---------------------

  const projectRoot = (projectId: unknown): string => {
    const project = db.code.projectGetById(requireString(projectId, 'Project id'))
    if (!project) throw invalid('Project not found.')
    return project.path
  }

  const gitPathsSchema = z.object({
    projectId: z.string().min(1),
    paths: z.array(z.string().min(1).max(1000)).min(1).max(200),
  })

  register(CHANNELS.codeGitStatus, (projectId) => gitService.status(projectRoot(projectId)))

  register(CHANNELS.codeGitStage, async (req) => {
    const parsed = parseInput(gitPathsSchema, req)
    const root = projectRoot(parsed.projectId)
    await gitService.stage(root, parsed.paths)
    return gitService.status(root)
  })

  register(CHANNELS.codeGitUnstage, async (req) => {
    const parsed = parseInput(gitPathsSchema, req)
    const root = projectRoot(parsed.projectId)
    await gitService.unstage(root, parsed.paths)
    return gitService.status(root)
  })

  register(CHANNELS.codeGitCommit, (req) => {
    const parsed = parseInput(gitCommitSchema, req)
    return gitService.commit(projectRoot(parsed.projectId), parsed.message)
  })

  register(CHANNELS.codeGitCreateBranch, async (req) => {
    const parsed = parseInput(gitBranchSchema, req)
    const root = projectRoot(parsed.projectId)
    await gitService.createBranch(root, parsed.name)
    return gitService.status(root)
  })

  register(CHANNELS.codeGitFetch, (projectId) =>
    gitService.fetch(projectRoot(requireString(projectId, 'Project id')))
  )

  register(CHANNELS.codeGitSetOrigin, (req) => {
    const parsed = parseInput(gitSetOriginSchema, req)
    return gitService.setOrigin(projectRoot(parsed.projectId), parsed.url)
  })

  register(CHANNELS.codeGitPull, (projectId) =>
    gitService.pull(projectRoot(requireString(projectId, 'Project id')))
  )

  register(CHANNELS.codeGitPush, (req) => {
    const parsed = parseInput(gitPushSchema, req)
    return gitService.push(projectRoot(parsed.projectId), parsed.confirmDefaultBranch)
  })

  register(CHANNELS.codeGithubPrCreate, (req) => {
    const parsed = parseInput(githubPrCreateSchema, req)
    return gitService.createPullRequest(projectRoot(parsed.projectId), parsed.input)
  })

  register(CHANNELS.codeGitGenerateCommitMessage, (projectId) =>
    gitService.generateCommitMessage(projectRoot(projectId))
  )

  register(CHANNELS.codeWorktreeCreate, async (req) => {
    const parsed = parseInput(worktreeCreateSchema, req)
    const created = await gitService.createWorktree(
      projectRoot(parsed.projectId),
      deps.worktreesDir,
      parsed.projectId,
      parsed.name
    )
    const registered = codeService.openProject(created.path)
    return { ...created, projectId: registered.id }
  })

  register(CHANNELS.codeOpenInIde, (projectId) =>
    gitService.openInEditor(
      projectRoot(projectId),
      db.settings.get().ideCommand
    )
  )

  // Metadata only: the pre-edit file snapshots stay in main until a restore
  // reads them back through checkpointGet.
  register(CHANNELS.codeCheckpointsList, (conversationId) =>
    db.agentPlatform.checkpointsListLite(requireString(conversationId, 'Conversation id'))
  )

  register(CHANNELS.codeCheckpointRestore, (checkpointId) =>
    codeService.restoreCheckpoint(requireString(checkpointId, 'Checkpoint id'))
  )

  register(CHANNELS.codeTurnRevert, (req) => {
    const parsed = parseInput(turnRevertSchema, req)
    return codeService.revertTurn(parsed.conversationId, parsed.messageSeq)
  })

  // -- code arena ----------------------------------------------------------------

  register(CHANNELS.arenaStart, (req) => {
    const parsed = parseInput(arenaStartSchema, req)
    return deps.arenaService.start(parsed)
  })

  register(CHANNELS.arenaStatus, (conversationId) =>
    deps.arenaService.status(requireString(conversationId, 'Conversation id'))
  )

  register(CHANNELS.arenaApply, (req) => {
    const parsed = parseInput(arenaApplySchema, req)
    return deps.arenaService.apply(parsed.conversationId, parsed.runId)
  })

  register(CHANNELS.arenaStop, (conversationId) =>
    deps.arenaService.stop(requireString(conversationId, 'Conversation id'))
  )

  register(CHANNELS.arenaDiscard, (conversationId) =>
    deps.arenaService.discard(requireString(conversationId, 'Conversation id'))
  )

  // -- optimizer (autonomous optimize-evaluate-commit loops) --------------------
  //
  // The eval command is executed by MAIN only (never through the agent's shell
  // tool), so the scoring path stays deterministic and auditable in Activity.

  register(CHANNELS.optimizerStart, (input) => deps.optimizerService.start(parseInput(optimizerStartSchema, input)))

  register(CHANNELS.optimizerStop, (runId) =>
    deps.optimizerService.stop(requireString(runId, 'Run id'))
  )

  register(CHANNELS.optimizerList, () => deps.optimizerService.list())

  register(CHANNELS.optimizerVersions, (runId) =>
    deps.optimizerService.versions(requireString(runId, 'Run id'))
  )

  register(CHANNELS.experimentsList, (projectId) =>
    db.experiments.listForProject(requireString(projectId, 'Project id'))
  )

  // -- agent inbox (unified review queue for background results) ----------------

  register(CHANNELS.inboxList, () => collectInboxItems(db))

  register(CHANNELS.inboxMarkReviewed, (req) => {
    const parsed = parseInput(inboxMarkReviewedSchema, req)
    db.inbox.markReviewed(parsed.itemType, parsed.itemId)
    deps.notifier?.refreshBadge()
  })

  // -- morning brief (daily digest generated main-side) -------------------------

  register(CHANNELS.briefList, () => deps.briefService.list())

  register(CHANNELS.briefDismiss, (id) => {
    deps.briefService.dismiss(requireString(id, 'Brief id'))
  })

  // -- usage (local, estimate-only spend summary) -------------------------------

  register(CHANNELS.usageSummary, (days) => {
    const window = typeof days === 'number' && days >= 1 && days <= 365 ? days : 30
    const since = Date.now() - window * 24 * 60 * 60 * 1000
    const providers = new Map(db.providers.list().map((p) => [p.id, p]))
    const rows = db.messages.usageSince(since).flatMap((row) => {
      const provider = providers.get(row.providerId)
      if (!provider) return []
      return [
        {
          providerId: row.providerId,
          providerLabel: provider.label,
          providerType: provider.type,
          modelId: row.modelId,
          usage: row.usage,
        },
      ]
    })
    return buildUsageSummary(rows)
  })

  register(CHANNELS.usageConversationCost, (conversationId) => {
    const conversation = found(
      db.conversations.getById(requireString(conversationId, 'Conversation id')),
      'Conversation'
    )
    return conversationCostSummary(db, conversation)
  })

  register(CHANNELS.usageHeadless, (days) => {
    const window = typeof days === 'number' && days >= 1 && days <= 365 ? days : 30
    const since = Date.now() - window * 24 * 60 * 60 * 1000
    return db.headlessUsage.summarySince(since)
  })

  // -- terminal (user-driven Work-view terminal; the click IS the consent) ------

  register(CHANNELS.terminalCreate, (conversationId) => {
    const conversation = found(
      db.conversations.getById(requireString(conversationId, 'Conversation id')),
      'Conversation'
    )
    if (!conversation.projectId) {
      throw invalid('Connect a folder to this task before opening a terminal.')
    }
    return deps.terminalService.createOrAttach(
      conversation.id,
      projectRoot(conversation.projectId)
    )
  })

  register(CHANNELS.terminalInput, (req) => {
    const parsed = parseInput(terminalInputSchema, req)
    deps.terminalService.write(parsed.sessionId, parsed.data)
  })

  register(CHANNELS.terminalDispose, (sessionId) => {
    deps.terminalService.dispose(requireString(sessionId, 'Session id'))
  })

  // -- voice (offline whisper.cpp STT; desktop-local, never on the phone allowlist) --

  register(CHANNELS.voiceStatus, () => deps.voiceService.status())

  register(CHANNELS.voiceDownload, (req) => {
    const parsed = parseInput(z.object({ modelId: voiceModelIdSchema }).strict(), req)
    if (deps.voiceService.downloading) throw invalid('A voice download is already in progress.')
    // Fire-and-forget the long download: progress and failures ride the
    // push:voiceDownloadProgress channel (a terminal event is always sent).
    void deps.voiceService.download(parsed.modelId).catch(() => undefined)
    return deps.voiceService.status()
  })

  register(CHANNELS.voiceDownloadCancel, () => {
    deps.voiceService.cancelDownload()
    return deps.voiceService.status()
  })

  register(CHANNELS.voiceRemove, async (req) => {
    const parsed = parseInput(z.object({ modelId: voiceModelIdSchema }).strict(), req)
    await deps.voiceService.remove(parsed.modelId)
    return deps.voiceService.status()
  })

  register(CHANNELS.voicePickBinary, async (clear) => {
    // The chosen executable path is written to settings by MAIN only — it is
    // deliberately absent from settingsPatchSchema and backup import.
    if (requireBoolean(clear, 'clear')) {
      db.settings.update({ voiceWhisperBinaryPath: null })
      return deps.voiceService.status()
    }
    const result = await showOpen({ properties: ['openFile'] })
    if (!result.canceled && result.filePaths.length > 0) {
      db.settings.update({ voiceWhisperBinaryPath: result.filePaths[0] })
    }
    return deps.voiceService.status()
  })

  register(CHANNELS.voiceSttBegin, () => deps.voiceService.sttBegin())

  register(CHANNELS.voiceSttChunk, (req) => {
    const parsed = parseInput(voiceSttChunkSchema, req)
    deps.voiceService.sttChunk(parsed.sessionId, parsed.chunk)
  })

  register(CHANNELS.voiceSttEnd, (req) => {
    const parsed = parseInput(voiceSttSessionSchema, req)
    return deps.voiceService.sttEnd(parsed.sessionId)
  })

  register(CHANNELS.voiceSttCancel, (req) => {
    const parsed = parseInput(voiceSttSessionSchema, req)
    deps.voiceService.sttCancel(parsed.sessionId)
  })

  register(CHANNELS.voiceTranscribeAttachment, (req) => {
    const parsed = parseInput(voiceTranscribeAttachmentSchema, req)
    return deps.voiceService.transcribeAttachment(parsed)
  })

  // -- tools --------------------------------------------------------------------

  register(CHANNELS.toolsList, () => toolSystem.registry.listDefinitions())

  register(CHANNELS.toolsSetEnabled, (toolId, enabled) => {
    const id = requireString(toolId, 'Tool id')
    const flag = requireBoolean(enabled, 'enabled')
    // The registry rejects ids it does not know (throws a plain Error).
    asInvalid(() => toolSystem.registry.setEnabled(id, flag), 'Unknown tool.')
    return undefined
  })

  register(CHANNELS.toolsPermissionsList, () => toolSystem.registry.listPermissions())

  register(CHANNELS.toolsPermissionSet, (toolId, decision) => {
    const id = requireString(toolId, 'Tool id')
    const parsed = parseInput(toolPermissionDecisionSchema, decision)
    asInvalid(() => toolSystem.registry.setPermission(id, parsed), 'Unknown tool.')
    return undefined
  })

  // The renderer's approve/decline click for a pending tool call. Unknown or
  // expired requestIds are ignored by the broker (still resolves ok). Scope
  // 'conversation' additionally auto-approves the tool's future calls in the
  // same conversation (in-memory, this app session only).
  register(CHANNELS.toolsApprovalRespond, (requestId, approved, scope) => {
    approvalBroker.respond(requireString(requestId, 'Request id'), {
      approved: requireBoolean(approved, 'approved'),
      scope: parseInput(approvalScopeSchema, scope ?? 'once'),
    })
    return undefined
  })

  // -- standing approval rules ("always allow" / "always ask") -----------------
  //
  // A rule can only remove or add a dialog; it never widens what a tool may do.
  // 'deny', plan mode, the read-only sandbox and noStandingApproval tools all
  // still refuse first, inside the executor.

  const signalToolRulesChanged = (): void => {
    for (const win of deps.getWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(CHANNELS.toolRulesChanged, undefined)
      }
    }
  }

  register(CHANNELS.toolsRulesList, () => db.toolRules.list())

  register(CHANNELS.toolsRuleCreate, (input) => {
    const parsed = parseInput(toolRuleInputSchema, input)
    // An allow rule for an unknown tool would be dead weight; for a
    // noStandingApproval tool it would be a promise the executor never keeps.
    if (parsed.effect === 'allow') {
      const tool = toolSystem.registry.getById(parsed.toolId)
      if (!tool) throw invalid(`Unknown tool: ${parsed.toolId}`)
      if (tool.noStandingApproval === true) {
        throw invalid(`The tool '${parsed.toolId}' requires a fresh approval for every call.`)
      }
    }
    if (parsed.scope !== 'global' && !parsed.scopeId) {
      throw invalid('A conversation or project rule needs the id it applies to.')
    }
    db.toolRules.create(parsed)
    signalToolRulesChanged()
    return db.toolRules.list()
  })

  register(CHANNELS.toolsRuleDelete, (ruleId) => {
    db.toolRules.remove(requireString(ruleId, 'Rule id'))
    signalToolRulesChanged()
    return db.toolRules.list()
  })

  // -- activity log (the audit trail) -----------------------------------------
  //
  // Read-only plus a clear. There is deliberately no "delete this one entry":
  // a log you can edit entry by entry is not evidence of anything.

  register(CHANNELS.activityList, (query) => {
    const parsed = parseInput(activityListSchema, query ?? {})
    return { ...db.activity.list(parsed ?? {}), total: db.activity.count() }
  })

  register(CHANNELS.activityClear, () => {
    db.activity.deleteAll()
    return undefined
  })

  // The renderer's answer to an ask_user_question dialog (null = dismissed).
  register(CHANNELS.toolsQuestionRespond, (requestId, answer) => {
    if (answer !== null && typeof answer !== 'string') {
      throw new ProviderError('invalid_request', 'Answer must be a string or null.')
    }
    questionBroker.respond(requireString(requestId, 'Request id'), answer)
    return undefined
  })

  // -- custom HTTP tools ------------------------------------------------------

  /**
   * Encrypts and stores secret headers for a custom tool. An empty value means
   * "leave the existing secret unchanged" (the edit form never re-displays a
   * stored value), so it is skipped rather than overwritten.
   */
  const storeSecretHeaders = (dbId: string, secrets: Record<string, string> | undefined): void => {
    if (!secrets) return
    for (const [name, value] of Object.entries(secrets)) {
      if (value.length === 0) continue
      const { encryptedBase64, preview } = keystore.encryptKey(value)
      db.secrets.set('custom_tool', dbId, name, encryptedBase64, preview)
    }
  }

  register(CHANNELS.toolsCustomList, () => toolSystem.registry.listCustomToolInfos())

  register(CHANNELS.toolsCustomCreate, (input) => {
    const parsed = parseInput(customToolInputSchema, input)
    const definition = asInvalid(
      () => toolSystem.registry.addCustomTool(parsed),
      'Invalid custom tool.'
    )
    storeSecretHeaders(customToolDbId(definition.id), parsed.setSecretHeaders)
    return toolSystem.registry.listCustomToolInfos()
  })

  register(CHANNELS.toolsCustomUpdate, (toolId, patch) => {
    const id = requireString(toolId, 'Tool id')
    const parsed = parseInput(customToolPatchSchema, patch)
    const definition = asInvalid(
      () => toolSystem.registry.updateCustomTool(id, parsed),
      'Invalid custom tool.'
    )
    const dbId = customToolDbId(definition.id)
    for (const name of parsed.deleteSecretHeaders ?? []) {
      db.secrets.remove('custom_tool', dbId, name)
    }
    storeSecretHeaders(dbId, parsed.setSecretHeaders)
    return toolSystem.registry.listCustomToolInfos()
  })

  register(CHANNELS.toolsCustomDelete, (toolId) => {
    const id = requireString(toolId, 'Tool id')
    const dbId = customToolDbId(id)
    asInvalid(() => toolSystem.registry.removeCustomTool(id), 'Unknown tool.')
    db.secrets.deleteAllFor('custom_tool', dbId)
    return toolSystem.registry.listCustomToolInfos()
  })

  // -- prompt library ---------------------------------------------------------

  register(CHANNELS.promptsList, () => db.prompts.list())

  register(CHANNELS.promptsCreate, (input) =>
    db.prompts.create(parseInput(promptTemplateInputSchema, input))
  )

  register(CHANNELS.promptsUpdate, (id, patch) => {
    const templateId = requireString(id, 'Prompt id')
    return found(db.prompts.update(templateId, parseInput(promptTemplatePatchSchema, patch)), 'Prompt')
  })

  register(CHANNELS.promptsDelete, (id) => {
    db.prompts.remove(requireString(id, 'Prompt id'))
    return undefined
  })

  // -- memories -----------------------------------------------------------------

  register(CHANNELS.memoriesList, () => db.memories.list())

  register(CHANNELS.memoriesCreate, (input) =>
    db.memories.create(parseInput(memoryInputSchema, input))
  )

  register(CHANNELS.memoriesUpdate, (id, patch) => {
    const memoryId = requireString(id, 'Memory id')
    return found(db.memories.update(memoryId, parseInput(memoryPatchSchema, patch)), 'Memory')
  })

  register(CHANNELS.memoriesDelete, (id) => {
    db.memories.remove(requireString(id, 'Memory id'))
    return undefined
  })

  // Manual "Consolidate now": forced dream, bypassing the auto-run gates.
  register(CHANNELS.memoriesDream, () => deps.dreamingService.dreamNow(true))

  // -- notebooks ----------------------------------------------------------------

  register(CHANNELS.documentsList, () => db.documents.list())

  register(CHANNELS.documentsGet, (id) =>
    found(db.documents.getById(requireString(id, 'Document id')), 'Document')
  )

  register(CHANNELS.documentsCreate, (input) =>
    db.documents.create(parseInput(notebookDocInputSchema, input))
  )

  register(CHANNELS.documentsUpdate, (id, patch) => {
    const documentId = requireString(id, 'Document id')
    return found(
      db.documents.update(documentId, parseInput(notebookDocPatchSchema, patch)),
      'Document'
    )
  })

  register(CHANNELS.documentsDelete, (id) => {
    db.documents.remove(requireString(id, 'Document id'))
    return undefined
  })

  register(CHANNELS.documentsListVersions, (id) =>
    // Summaries only: the history panel shows a length and restores by id —
    // up to 20 full contents (megabytes) over IPC would be dead weight.
    db.documents.listVersionSummaries(requireString(id, 'Document id'))
  )

  register(CHANNELS.documentsRevert, (req) => {
    const parsed = parseInput(documentsRevertSchema, req)
    return found(db.documents.revert(parsed.id, parsed.versionId), 'Document version')
  })

  register(CHANNELS.documentsExport, async (id) => {
    const doc = found(db.documents.getById(requireString(id, 'Document id')), 'Document')
    const base = doc.title.replace(/[^\w\-. ]+/g, '').trim().slice(0, 60) || 'notebook'
    return saveTextFile(`${base}.md`, [{ name: 'Markdown', extensions: ['md'] }], doc.content)
  })

  // -- skills -------------------------------------------------------------------

  register(CHANNELS.skillsList, () => db.skills.list())

  register(CHANNELS.skillsCreate, (input) => db.skills.create(parseInput(skillInputSchema, input)))

  register(CHANNELS.skillsUpdate, (id, patch) => {
    const skillId = requireString(id, 'Skill id')
    return found(db.skills.update(skillId, parseInput(skillPatchSchema, patch)), 'Skill')
  })

  register(CHANNELS.skillsDelete, (id) => {
    db.skills.remove(requireString(id, 'Skill id'))
    return undefined
  })

  register(CHANNELS.skillsImportFolder, async (path) => {
    const folder = requireString(path, 'Folder path')
    const result = await asInvalidAsync(
      () => readSkillsFromFolder(folder),
      'Could not read the folder.'
    )
    return result.skills.map((skill) =>
      db.skills.upsertByName({
        name: skill.name,
        description: skill.description,
        content: skill.content,
        pluginName: result.pluginName,
        sourcePath: folder,
      })
    )
  })

  // -- backup (settings + memories + skills) ------------------------------------

  register(CHANNELS.backupExport, async (req) => {
    const parsed = parseInput(backupExportOptionsSchema, req)
    const date = new Date().toISOString().slice(0, 10)
    return saveTextFile(
      `grasberg-backup-${date}.json`,
      [{ name: 'JSON', extensions: ['json'] }],
      JSON.stringify(
        buildBackup(db, { includePrivateSpaces: parsed?.includePrivateSpaces === true }),
        null,
        2
      )
    )
  })

  register(CHANNELS.backupImport, async () => {
    const result = await showOpen({
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(result.filePaths[0], 'utf8'))
    } catch {
      throw invalid('The selected file is not valid JSON.')
    }
    return asInvalid(
      () => ({ canceled: false, ...applyBackup(db, raw) }),
      'Could not import the backup.'
    )
  })

  // -- MCP servers ------------------------------------------------------------

  const { mcpManager } = deps

  register(CHANNELS.mcpList, () => mcpManager.list())

  register(CHANNELS.mcpCreate, (input) => {
    const parsed = parseInput(mcpServerInputSchema, input)
    if (parsed.transport === 'stdio' && !(parsed.command ?? '').trim()) {
      throw invalid('A stdio MCP server needs a command.')
    }
    if (parsed.transport === 'http') {
      const url = (parsed.url ?? '').trim()
      if (!url) throw invalid('An HTTP MCP server needs a URL.')
      if (!isAllowedHttpUrl(url)) {
        throw invalid('MCP server URL must use https:// (http is only allowed for localhost).')
      }
    }
    return mcpManager.create(parsed)
  })

  register(CHANNELS.mcpUpdate, (id, patch) => {
    const serverId = requireString(id, 'Server id')
    const parsed = parseInput(mcpServerPatchSchema, patch)
    if (parsed.url !== undefined && parsed.url.trim() && !isAllowedHttpUrl(parsed.url.trim())) {
      throw invalid('MCP server URL must use https:// (http is only allowed for localhost).')
    }
    return mcpManager.update(serverId, parsed)
  })

  register(CHANNELS.mcpDelete, (id) => mcpManager.remove(requireString(id, 'Server id')))

  register(CHANNELS.mcpSetEnabled, (id, enabled) =>
    mcpManager.setEnabled(requireString(id, 'Server id'), requireBoolean(enabled, 'enabled'))
  )

  register(CHANNELS.mcpReconnect, (id) => mcpManager.reconnect(requireString(id, 'Server id')))

  register(CHANNELS.mcpStatus, () => mcpManager.getRuntime())

  // -- IM bridges -------------------------------------------------------------

  const { imBridgeManager } = deps

  register(CHANNELS.imStatus, () => imBridgeManager.status())

  register(CHANNELS.imSetTelegram, (input) => {
    const parsed = parseInput(imTelegramSchema, input)
    // A private-space conversation must never be reachable over Telegram; the
    // runtime backstop in ImBridgeManager.handleInbound covers pre-v45 binds.
    if (parsed.conversationId) {
      const conversation = found(db.conversations.getById(parsed.conversationId), 'Conversation')
      if (conversation.spaceId) {
        throw invalid('A conversation in a private space cannot be bridged to Telegram.')
      }
    }
    return imBridgeManager.setTelegram(parsed)
  })

  // Delivery drops a webhook that isn't https (or http on localhost), so the
  // same rule is enforced here — a webhook that can never fire is rejected.
  register(CHANNELS.imSetWebhook, (url) =>
    imBridgeManager.setWebhook(parseInput(outboundWebhookUrlSchema, url ?? null))
  )

  // -- remote access (phone tunnel) --------------------------------------------

  const remote = (): RemoteService => {
    const service = deps.getRemoteService()
    if (!service) throw invalid('Remote access is not available.')
    return service
  }
  const remoteSetConfigSchema = z.object({
    enabled: z.boolean(),
    relayUrl: z.string().trim().max(500).nullable().optional(),
    clientUrl: z.string().trim().max(500).nullable().optional(),
  })

  register(CHANNELS.remoteStatus, () => remote().status())

  register(CHANNELS.remoteSetConfig, (input) =>
    remote().setConfig(parseInput(remoteSetConfigSchema, input))
  )

  register(CHANNELS.remotePair, (open) => remote().pair(parseInput(z.boolean(), open)))

  register(CHANNELS.remoteDeviceRevoke, (deviceId) =>
    remote().revokeDevice(requireString(deviceId, 'Device id'))
  )

  // -- workflows --------------------------------------------------------------

  const asGraph = (value: unknown): WorkflowGraph =>
    parseInput(workflowGraphSchema, value) as WorkflowGraph

  const workflowScheduleSchema = z.union([
    // A pre-v33 client (or a saved graph round-tripped through a backup)
    // may still send the untagged interval shape.
    z.object({ everyMinutes: z.number() }),
    z.object({ kind: z.literal('interval'), everyMinutes: z.number() }),
    z.object({
      kind: z.literal('calendar'),
      days: z.array(z.number().int().min(0).max(6)).max(7),
      time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
    }),
  ])

  const workflowWatchSchema = z.object({
    enabled: z.boolean(),
    folderPath: z.string().min(1).max(1000),
    glob: z.string().max(200),
    event: z.enum(['created', 'changed']),
    debounceMs: z.number().int().min(100).max(60_000).optional(),
  })

  const workflowInputSchema = z.object({
    name: z.string().trim().min(1).max(200),
    graph: workflowGraphSchema,
    schedule: workflowScheduleSchema.nullish(),
    scheduleEnabled: z.boolean().optional(),
    webhookEnabled: z.boolean().optional(),
    watch: workflowWatchSchema.nullish(),
    budgetUsd: z.number().positive().max(100_000).nullable().optional(),
  })

  /**
   * Update is a PATCH, so an absent field means "leave unchanged" and only an
   * explicitly sent null/false clears — a caller that omits `webhookEnabled`
   * can never silently revoke a workflow's trigger opt-in.
   */
  const workflowPatchSchema = workflowInputSchema.partial()

  const asSchedule = (
    raw: z.infer<typeof workflowScheduleSchema> | null | undefined
  ): WorkflowSchedule | null => {
    if (raw && 'kind' in raw && raw.kind === 'calendar') {
      return {
        kind: 'calendar',
        days: [...new Set(raw.days)].sort((a, b) => a - b),
        time: raw.time,
      }
    }
    if (raw && 'everyMinutes' in raw) {
      // Interval clamped to [1 minute, 7 days]; anything else = no schedule.
      const every = raw.everyMinutes
      return Number.isFinite(every) && every >= 1
        ? { kind: 'interval', everyMinutes: Math.min(Math.floor(every), 7 * 24 * 60) }
        : null
    }
    return null
  }

  /**
   * Enabling the schedule with nothing that can fire must fail loudly, not
   * save a workflow that silently never runs. `schedule` is the MERGED value:
   * a patch that omits the field keeps whatever is stored.
   */
  const assertScheduleCanFire = (
    scheduleEnabled: boolean | undefined,
    schedule: WorkflowSchedule | null
  ): void => {
    if (scheduleEnabled === true && schedule === null) {
      throw invalid('Set a valid interval or a time before turning the schedule on.')
    }
  }

  /**
   * The folder must be a real directory chosen with the OS folder picker.
   * Enforced server-side regardless of what the UI does: an enabled watch on a
   * relative or missing path would silently never fire (or worse, the wrong
   * dir). Disabled configs pass — the path is kept, just not watched.
   */
  const assertWatchCanFire = (watch: WorkflowWatchConfig | null | undefined): void => {
    if (watch?.enabled !== true) return
    if (!isAbsolute(watch.folderPath)) {
      throw invalid('Pick a folder with the folder picker before turning the watch on.')
    }
    try {
      if (!statSync(watch.folderPath).isDirectory()) throw new Error('not a directory')
    } catch {
      throw invalid('The watched folder no longer exists — pick it again.')
    }
  }

  const asWorkflowInput = (value: unknown): WorkflowInput => {
    const parsed = parseInput(workflowInputSchema, value)
    const schedule = asSchedule(parsed.schedule)
    assertScheduleCanFire(parsed.scheduleEnabled, schedule)
    const watch = parsed.watch ?? null
    assertWatchCanFire(watch)
    return {
      name: parsed.name,
      graph: parsed.graph as WorkflowGraph,
      schedule,
      scheduleEnabled: parsed.scheduleEnabled === true,
      webhookEnabled: parsed.webhookEnabled === true,
      watch,
      budgetUsd: parsed.budgetUsd ?? null,
    }
  }

  const asWorkflowPatch = (value: unknown): Partial<WorkflowInput> => {
    const parsed = parseInput(workflowPatchSchema, value)
    const patch: Partial<WorkflowInput> = {}
    if (parsed.name !== undefined) patch.name = parsed.name
    if (parsed.graph !== undefined) patch.graph = parsed.graph as WorkflowGraph
    if (parsed.schedule !== undefined) patch.schedule = asSchedule(parsed.schedule)
    if (parsed.scheduleEnabled !== undefined) patch.scheduleEnabled = parsed.scheduleEnabled
    if (parsed.webhookEnabled !== undefined) patch.webhookEnabled = parsed.webhookEnabled
    if (parsed.watch !== undefined) {
      // No merge needed: enabled travels inside the config, so a patch either
      // replaces the whole object or omits it (undefined keeps the stored one).
      patch.watch = parsed.watch ?? null
      assertWatchCanFire(patch.watch)
    }
    if (parsed.budgetUsd !== undefined) patch.budgetUsd = parsed.budgetUsd
    return patch
  }

  register(CHANNELS.workflowsList, () => db.workflows.list())
  register(CHANNELS.workflowsGet, (id) => db.workflows.getById(requireString(id, 'Workflow id')))
  register(CHANNELS.workflowsCreate, (input) => {
    const workflow = db.workflows.create(asWorkflowInput(input))
    deps.wakeWorkflowScheduler?.()
    deps.workflowWatcher?.sync()
    return workflow
  })
  register(CHANNELS.workflowsUpdate, (id, input) => {
    const workflowId = requireString(id, 'Workflow id')
    const patch = asWorkflowPatch(input)
    // A patch that omits `schedule` keeps the stored one, so the guard needs
    // the merged state, not just what was sent.
    const current = found(db.workflows.getById(workflowId), 'Workflow')
    assertScheduleCanFire(
      patch.scheduleEnabled,
      patch.schedule !== undefined ? patch.schedule : current.schedule
    )
    const workflow = found(db.workflows.update(workflowId, patch), 'Workflow')
    deps.wakeWorkflowScheduler?.()
    deps.workflowWatcher?.sync()
    return workflow
  })
  register(CHANNELS.workflowsDelete, (id) => {
    db.workflows.remove(requireString(id, 'Workflow id'))
    deps.wakeWorkflowScheduler?.()
    deps.workflowWatcher?.sync()
    return undefined
  })
  register(CHANNELS.workflowsRun, (graph, opts) => {
    const parsed = parseInput(workflowsRunOptsSchema, opts)
    const liveDeps = {
      runAgent: (
        prompt: string,
        providerId?: string,
        modelId?: string,
        agentOpts?: Parameters<ChatService['generateForWorkflow']>[3]
      ) => chatService.generateForWorkflow(prompt, providerId, modelId, agentOpts),
      notify: (text: string) => deps.imBridgeManager.notify(text),
    }
    return runWorkflow(
      asGraph(graph),
      parsed?.dryRun === true
        ? makeDryRunDeps(liveDeps, {
            notifyConfigured: () => deps.imBridgeManager.notifyConfigured(),
          })
        : liveDeps
    )
  })

  // Saved-workflow execution (persisted to the run history) + that history.
  register(CHANNELS.workflowsRunById, (id) =>
    deps.workflowRunner.runById(requireString(id, 'Workflow id'), 'manual')
  )
  register(CHANNELS.workflowsRuns, (id) =>
    db.workflows.listRuns(requireString(id, 'Workflow id'))
  )

  // One call for the Home overview + sidebar Scheduled section: every workflow
  // with a schedule (paused included) paired with its latest run, plus recent
  // runs across all workflows. Latest-run status comes from a dedicated
  // per-workflow query so a frequent workflow can't evict the others.
  // -- local trigger endpoint --------------------------------------------------

  const triggerInfo = (workflowId?: unknown): WorkflowTriggerInfo => {
    const current = db.settings.get()
    const id = typeof workflowId === 'string' && workflowId.length > 0 ? workflowId : undefined
    return {
      running: deps.triggerServer?.running === true,
      port: current.workflowWebhookPort,
      // The token only ever travels to the desktop UI that displays it; it is
      // never part of the settings payload the renderer holds.
      url: deps.triggerServer?.url(id) ?? null,
    }
  }

  register(CHANNELS.workflowsTriggerInfo, (workflowId) => triggerInfo(workflowId))

  register(
    CHANNELS.workflowsWatchInfo,
    (workflowId): WorkflowWatchStatus =>
      deps.workflowWatcher?.statusFor(requireString(workflowId, 'Workflow id')) ?? {
        watching: false,
        lastError: null,
      }
  )

  register(CHANNELS.workflowsTriggerRegenerate, () => {
    // Rotating the token is the revoke button: every hook using the old URL
    // stops working the moment this returns.
    db.settings.update({ workflowWebhookToken: generateTriggerToken() })
    deps.triggerServer?.sync()
    return triggerInfo()
  })

  register(CHANNELS.workflowsOverview, (): WorkflowsOverview => {
    const latestByWorkflow = new Map(
      db.workflows.latestRunsPerWorkflow().map((run) => [run.workflowId, run])
    )
    return {
      scheduled: db.workflows
        .list()
        .filter((w) => w.schedule !== null)
        .map((workflow) => ({
          workflow,
          latestRun: latestByWorkflow.get(workflow.id) ?? null,
        })),
      recentRuns: db.workflows.listRecentRunsWithNames(),
    }
  })

  // -- standalone scheduled tasks --------------------------------------------

  const scheduledTaskInputSchema = z.object({
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(20_000),
    recurrence: z.enum(['once', 'hourly', 'daily', 'weekly']),
    runAt: z.number().int().positive(),
    approvedToolIds: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    projectId: z.string().trim().min(1).nullable().optional(),
    agentId: z.string().trim().min(1).nullable().optional(),
    // Delivery target (v47): https, or plain http on localhost only — the
    // same posture as provider base URLs.
    webhookUrl: z
      .string()
      .trim()
      .max(2000)
      .refine(isAllowedWebhookUrl, 'Webhook URLs must be https:// (http:// only on localhost).')
      .nullable()
      .optional(),
  }) satisfies z.ZodType<ScheduledTaskInput>

  /**
   * Pre-approved tools become standing grants for the task's headless runs —
   * only known, enabled tools qualify, and never noStandingApproval ones
   * (their contract is a fresh approval per call).
   */
  const validateScheduledTaskGrants = (input: ScheduledTaskInput): void => {
    for (const toolId of input.approvedToolIds ?? []) {
      const tool = toolSystem.registry.getById(toolId)
      if (!tool || !tool.enabled) throw invalid(`Unknown or disabled tool: ${toolId}`)
      if (tool.noStandingApproval === true || tool.id === 'schedule_task') {
        throw invalid(`The tool '${toolId}' cannot be pre-approved for scheduled runs.`)
      }
    }
    if (input.projectId && !db.code.projectGetById(input.projectId)) {
      throw invalid('The selected working folder is no longer registered.')
    }
    if (input.agentId) {
      const agent = db.agents.getById(input.agentId)
      if (!agent || !agent.enabled) throw invalid('The selected agent profile is unavailable.')
    }
  }

  const signalScheduledTasksChanged = (event: ScheduledTasksChangedEvent): void => {
    for (const win of deps.getWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(CHANNELS.scheduledTasksChanged, event)
      }
    }
  }

  register(CHANNELS.scheduledTasksList, () => db.scheduledTasks.list())
  register(CHANNELS.scheduledTasksCreate, (input) => {
    const parsed = parseInput(scheduledTaskInputSchema, input)
    if (parsed.runAt < Date.now() - 60_000) {
      throw invalid('The first run time cannot be in the past.')
    }
    validateScheduledTaskGrants(parsed)
    const task = db.scheduledTasks.create(parsed)
    signalScheduledTasksChanged({ type: 'upsert', task })
    deps.wakeScheduledTaskScheduler?.()
    return task
  })
  register(CHANNELS.scheduledTasksSetEnabled, (id, enabled) => {
    const task = found(
      db.scheduledTasks.setEnabled(
        requireString(id, 'Scheduled task id'),
        requireBoolean(enabled, 'Enabled')
      ),
      'Scheduled task'
    )
    signalScheduledTasksChanged({ type: 'upsert', task })
    deps.wakeScheduledTaskScheduler?.()
    return task
  })
  register(CHANNELS.scheduledTasksSetBudget, (id, budgetUsd) => {
    const parsed = parseInput(z.number().positive().max(100_000).nullable(), budgetUsd)
    const task = found(
      db.scheduledTasks.setBudget(requireString(id, 'Scheduled task id'), parsed),
      'Scheduled task'
    )
    signalScheduledTasksChanged({ type: 'upsert', task })
    return task
  })
  register(CHANNELS.scheduledTaskRuns, (taskId) =>
    db.scheduledTaskRuns.list(requireString(taskId, 'Scheduled task id'))
  )
  register(CHANNELS.scheduledTasksDelete, (id) => {
    const taskId = requireString(id, 'Scheduled task id')
    db.scheduledTasks.remove(taskId)
    signalScheduledTasksChanged({ type: 'delete', id: taskId })
    deps.wakeScheduledTaskScheduler?.()
    return undefined
  })

  // -- agent profiles ----------------------------------------------------------

  const agentInputSchema = z.object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(1024).optional(),
    systemPrompt: z.string().min(1).max(100_000),
    providerId: z.string().max(100).nullable().optional(),
    modelId: z.string().max(200).nullable().optional(),
    toolIds: z.array(z.string().max(200)).max(200).nullable().optional(),
    maxRounds: z.number().int().min(1).max(40).nullable().optional(),
    enabled: z.boolean().optional(),
    // Bot Mode (v46): role title, roster avatar, display-only hidden flag.
    title: z.string().max(200).optional(),
    avatar: z
      .object({
        emoji: z.string().max(16).nullable().optional(),
        color: z.string().max(32).nullable().optional(),
      })
      .nullable()
      .optional(),
    hidden: z.boolean().optional(),
    // Bot gateway (v47): heartbeat, auto-compact policy, messaging allowlist.
    heartbeat: z
      .object({
        everyMinutes: z.number().int().min(15).max(24 * 60),
        deliver: z.enum(['chat', 'notify']),
        prompt: z.string().max(2000).nullable().optional(),
      })
      .nullable()
      .optional(),
    reset: z
      .object({
        dailyHour: z.number().int().min(0).max(23).nullable().optional(),
        idleMinutes: z.number().int().min(15).max(7 * 24 * 60).nullable().optional(),
      })
      .nullable()
      .optional(),
    messageAllow: z.array(z.string().min(1).max(100)).max(50).nullable().optional(),
  })

  register(CHANNELS.agentsList, () => db.agents.list())
  register(CHANNELS.agentsCreate, (input) => {
    const parsed = parseInput(agentInputSchema, input)
    if (db.agents.getByName(parsed.name)) {
      throw invalid(`An agent named '${parsed.name}' already exists.`)
    }
    return db.agents.create(parsed)
  })
  register(CHANNELS.agentsUpdate, (id, patch) => {
    const agentId = requireString(id, 'Agent id')
    const parsed = parseInput(agentInputSchema.partial(), patch)
    if (parsed.name) {
      const existing = db.agents.getByName(parsed.name)
      if (existing && existing.id !== agentId) {
        throw invalid(`An agent named '${parsed.name}' already exists.`)
      }
    }
    return found(db.agents.update(agentId, parsed), 'Agent')
  })
  register(CHANNELS.agentsDelete, (id) => {
    const agentId = requireString(id, 'Agent id')
    const agent = db.agents.getById(agentId)
    db.agents.remove(agentId)
    // Bot Mode cleanup: canonical chat + group memberships go with the
    // profile (Hermes "Delete Profile" semantics).
    if (agent) deps.botService?.cleanupDeletedAgent(agent)
    return undefined
  })
  register(CHANNELS.agentRunsList, (conversationId) =>
    db.agentPlatform.runsList(
      conversationId === undefined ? undefined : requireString(conversationId, 'Conversation id')
    )
  )
  register(CHANNELS.agentRunStop, (runId) =>
    chatService.stopAgentRun(requireString(runId, 'Agent run id'))
  )

  // -- Bot Mode (v46) ----------------------------------------------------------

  const requireBots = (): BotService => {
    if (!deps.botService) throw invalid('Bot Mode is unavailable in this build.')
    return deps.botService
  }
  const groupPatchSchema = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    memberIds: z.array(z.string().min(1).max(100)).max(12).optional(),
    activation: z.enum(['always', 'mention']).optional(),
    observerIds: z.array(z.string().min(1).max(100)).max(12).optional(),
  })

  register(CHANNELS.botsRoster, () => requireBots().roster())
  register(CHANNELS.botsOpenChat, (agentId) => {
    const conversation = requireBots().ensureBotChat(requireString(agentId, 'Agent id'))
    return { conversationId: conversation.id }
  })
  register(CHANNELS.botsOutbox, (agentId) =>
    requireBots().listOutbox(requireString(agentId, 'Agent id'))
  )
  register(CHANNELS.botGroupCreate, (input) => {
    const parsed = parseInput(
      z.object({
        name: z.string().trim().min(1).max(200),
        memberIds: z.array(z.string().min(1).max(100)).max(12),
        activation: z.enum(['always', 'mention']).optional(),
        observerIds: z.array(z.string().min(1).max(100)).max(12).optional(),
      }),
      input
    )
    return requireBots().createGroup(parsed)
  })
  register(CHANNELS.botGroupUpdate, (id, patch) =>
    requireBots().updateGroup(requireString(id, 'Group id'), parseInput(groupPatchSchema, patch))
  )
  register(CHANNELS.botGroupDelete, (id) => {
    requireBots().deleteGroup(requireString(id, 'Group id'))
    return undefined
  })
  register(CHANNELS.botGroupSend, (groupId, content) => {
    requireBots().groupSend(
      requireString(groupId, 'Group id'),
      requireString(content, 'Message')
    )
    return undefined
  })
  register(CHANNELS.botGroupStop, (groupId) => {
    requireBots().stopGroup(requireString(groupId, 'Group id'))
    return undefined
  })
  register(CHANNELS.botGroupMarkSeen, (groupId) => {
    requireBots().markGroupSeen(requireString(groupId, 'Group id'))
    return undefined
  })

  // -- per-bot Telegram bindings (v47) ------------------------------------------

  const requireChannels = (): BotChannelService => {
    if (!deps.botChannels) throw invalid('Bot channels are unavailable in this build.')
    return deps.botChannels
  }

  register(CHANNELS.botBindingGet, (agentId) =>
    requireChannels().describe(requireString(agentId, 'Agent id'))
  )
  register(CHANNELS.botBindingSetToken, (agentId, token) => {
    const trimmed = requireString(token, 'Bot token').trim()
    // Telegram bot tokens look like "<digits>:<35 url-safe chars>".
    if (!/^\d{5,}:[\w-]{20,}$/.test(trimmed)) {
      throw invalid('That does not look like a Telegram bot token (get one from @BotFather).')
    }
    return requireChannels().setToken(requireString(agentId, 'Agent id'), trimmed)
  })
  register(CHANNELS.botBindingSetEnabled, (agentId, enabled) =>
    requireChannels().setEnabled(
      requireString(agentId, 'Agent id'),
      requireBoolean(enabled, 'Enabled')
    )
  )
  register(CHANNELS.botBindingRepair, (agentId) =>
    requireChannels().repair(requireString(agentId, 'Agent id'))
  )
  register(CHANNELS.botBindingClearToken, (agentId) => {
    requireChannels().clearToken(requireString(agentId, 'Agent id'))
    return undefined
  })
  register(CHANNELS.botBindingUpdateGroup, (agentId, groupId, patch) => {
    const parsed = parseInput(
      z.object({
        activation: z.enum(['mention', 'always']).optional(),
        remove: z.boolean().optional(),
      }),
      patch
    )
    return requireChannels().updateGroup(
      requireString(agentId, 'Agent id'),
      requireString(groupId, 'Group id'),
      parsed
    )
  })

  const packHookSchema = z.object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    event: z.enum(['afterAgent', 'afterApply', 'beforeCommit']),
    command: z.string().min(1).max(2000),
    enabled: z.boolean(),
  })
  const agentPackSchema = z.object({
    format: z.literal('grasberg-agent-pack'),
    version: z.literal(1),
    agents: z.array(agentInputSchema).max(200),
    skills: z.array(z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      content: z.string().max(500_000),
      pluginName: z.string().max(200).nullable().optional(),
    })).max(500),
    hooks: z.array(packHookSchema).max(100),
  })

  register(CHANNELS.agentPackExport, () => {
    const pack = {
      format: 'grasberg-agent-pack' as const,
      version: 1 as const,
      agents: db.agents.list().map(({ name, description, systemPrompt, providerId, modelId, toolIds, maxRounds, enabled }) =>
        ({ name, description, systemPrompt, providerId, modelId, toolIds, maxRounds, enabled })),
      skills: db.skills.list().map(({ name, description, content, pluginName }) =>
        ({ name, description, content, pluginName })),
      hooks: db.settings.get().projectHooks,
    }
    return saveTextFile(
      'grasberg-agent-pack.json',
      [{ name: 'Grasberg agent pack', extensions: ['json'] }],
      JSON.stringify(pack, null, 2)
    )
  })

  register(CHANNELS.agentPackImport, async () => {
    const picked = await showOpen({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(picked.filePaths[0], 'utf8'))
    } catch {
      throw invalid('The selected file is not valid JSON.')
    }
    const parsed = parseInput(agentPackSchema, raw)
    for (const agent of parsed.agents) {
      const existing = db.agents.getByName(agent.name)
      if (existing) db.agents.update(existing.id, agent)
      else db.agents.create(agent)
    }
    for (const skill of parsed.skills) db.skills.upsertByName(skill)
    const current = db.settings.get().projectHooks
    const importedIds = new Set(parsed.hooks.map((hook) => hook.id))
    db.settings.update({ projectHooks: [...current.filter((hook) => !importedIds.has(hook.id)), ...parsed.hooks] })
    return { canceled: false, agents: parsed.agents.length, skills: parsed.skills.length, hooks: parsed.hooks.length }
  })

  // -- knowledge bases (RAG) ----------------------------------------------------

  const kbInputSchema = z.object({
    name: z.string().trim().min(1).max(200),
    providerId: z.string().min(1).max(100),
    modelId: z.string().trim().min(1).max(200),
  })

  register(CHANNELS.kbList, () => db.knowledge.list())
  register(CHANNELS.kbCreate, (input) => db.knowledge.create(parseInput(kbInputSchema, input)))
  register(CHANNELS.kbDelete, (id) => {
    const kbId = requireString(id, 'Knowledge base id')
    db.knowledge.remove(kbId) // chunks cascade
    db.conversations.clearKnowledgeBase(kbId)
    return undefined
  })
  register(CHANNELS.kbSources, (id) =>
    db.knowledge.listSources(requireString(id, 'Knowledge base id'))
  )
  register(CHANNELS.kbRemoveSource, (id, source) => {
    db.knowledge.removeSource(
      requireString(id, 'Knowledge base id'),
      requireString(source, 'Source name')
    )
    return undefined
  })

  // Import: pick files, extract their text (same pipeline as attachments),
  // chunk + embed + store. Images and unreadable files are counted as skipped.
  register(CHANNELS.kbImportFiles, async (id) => {
    const kbId = requireString(id, 'Knowledge base id')
    const result = await showOpen({ properties: ['openFile', 'multiSelections'] })
    if (result.canceled) return { canceled: true, imported: 0, chunks: 0, skipped: 0 }
    let imported = 0
    let chunks = 0
    let skipped = 0
    for (const filePath of result.filePaths) {
      // No imageDir: KB import must not copy picked images into the
      // attachments store as a side effect. textContent presence is the
      // "this is readable text" signal (images/binaries never set it).
      const attachment = await readAttachment(filePath)
      const text = attachment?.textContent ?? ''
      if (!attachment || !text.trim()) {
        skipped += 1
        continue
      }
      const added = await deps.knowledgeService.addDocument(kbId, attachment.name, text)
      imported += 1
      chunks += added.chunks
    }
    return { canceled: false, imported, chunks, skipped }
  })

  // While the app is locked, the renderer transport serves nothing but the
  // lock screen's own two channels — the single choke point, so no handler
  // needs its own check. The phone tunnel invokes handlers directly (its own
  // 256-bit pairing auth; private-space exclusions cover it independently),
  // so remote access deliberately keeps working while the desktop is locked.
  const LOCK_EXEMPT_CHANNELS: ReadonlySet<ChannelName> = new Set([
    CHANNELS.lockStatus,
    CHANNELS.lockUnlock,
    // Dismissing a quick window opened pre-lock exposes nothing (hide + abort);
    // gating it would leave Esc/✕ dead while the window stays on top.
    CHANNELS.quickHide,
  ])

  // Wire every collected handler to ipcMain with the shared normalization:
  // renderer invoke → IpcResult, never a thrown exception across the boundary.
  for (const [channel, fn] of handlers) {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        if (deps.appLock?.isLocked() && !LOCK_EXEMPT_CHANNELS.has(channel)) {
          throw new ProviderError('auth', 'Grasberg is locked. Unlock to continue.', {
            retryable: false,
          })
        }
        return ok(await fn(...args))
      } catch (e) {
        return err(toNormalizedError(e))
      }
    })
  }
  return handlers
}
