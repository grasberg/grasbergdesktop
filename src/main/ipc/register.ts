/**
 * Registers every request/response IPC channel. Each handler validates its
 * input, calls through to the service/repository layer, and always resolves
 * to an IpcResult — errors are normalized, never thrown across the boundary.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
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
  Attachment,
  ConversationMode,
  ScheduledTaskInput,
  ToolPermissionDecision,
  WorkflowGraph,
  WorkflowInput,
  WorkflowsOverview,
  WorkspaceItemKind,
} from '@shared/types'
import { runWorkflow } from '../workflows/engine'
import type { WorkflowRunner } from '../workflows/runner'
import type { WorkspaceRootService } from '../code/workspace-root'
import type { KnowledgeService } from '../services/knowledge'
import type { DreamingService } from '../services/dreaming'
import {
  CHATGPT_OAUTH_DEFAULT_MODEL,
  PROVIDER_TYPES,
  PROVIDER_TYPE_LIST,
  providerAuthModes,
  resolveModelCatalog,
} from '@shared/catalog'
import { presetMeta } from '@shared/presets'
import { modeModelDefault } from '@shared/mode-models'
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
  promptTemplateInputSchema,
  promptTemplatePatchSchema,
  skillInputSchema,
  skillPatchSchema,
  providerConfigInputSchema,
  providerConfigPatchSchema,
  providerTypeSchema,
  authModeSchema,
  researchDepthSchema,
  settingsPatchSchema,
  workflowGraphSchema,
  isValidStorageKey,
} from '@shared/schemas'
import type { AppDatabase } from '../db/database'
import type { ChatService } from '../services/chat-service'
import type { CodeService } from '../code/code-service'
import type { GitService } from '../code/git-service'
import type { Keystore } from '../keys/keystore'
import { customToolDbId, type ToolSystem } from '../tools'
import type { McpManager } from '../tools/mcp/manager'
import type { ImBridgeManager } from '../im/manager'
import type { ApprovalBroker } from '../services/approval-broker'
import type { QuestionBroker } from '../services/question-broker'
import { getAdapter, resolveAdapter } from '../providers/registry'
import type { OpenAiOAuthManager } from '../providers/openai-oauth'
import { ProviderError, toNormalizedError } from '../providers/errors'
import { toJson, toMarkdown, exportFileBase } from '../services/export'
import { readSkillsFromFolder } from '../services/skills'
import { applyBackup, buildBackup } from '../services/backup'
import {
  MAX_IMAGE_BASE64_CHARS,
  PASTED_IMAGE_MIME_TYPES,
  readAttachment,
  readStoredImage,
  storePastedImage,
} from './attachments'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface RegisterIpcDeps {
  db: AppDatabase
  chatService: ChatService
  codeService: CodeService
  gitService: GitService
  keystore: Keystore
  toolSystem: ToolSystem
  approvalBroker: ApprovalBroker
  questionBroker: QuestionBroker
  mcpManager: McpManager
  imBridgeManager: ImBridgeManager
  oauthManager: OpenAiOAuthManager
  /** Runs saved workflows and records their run history. */
  workflowRunner: WorkflowRunner
  /** Per-task workspace folders (auto-created working dirs for Work tasks). */
  workspaceRoots: WorkspaceRootService
  /** Memory consolidation ("dreaming") — the manual Consolidate-now action. */
  dreamingService: DreamingService
  /** Knowledge-base chunking/embedding/retrieval. */
  knowledgeService: KnowledgeService
  /** Directory where image attachments are stored on disk. */
  attachmentsDir: string
  /** App-owned directory for isolated Git worktrees. */
  worktreesDir: string
  getWindows: () => BrowserWindow[]
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
  kind: z.enum(['text', 'image']).optional(),
  textContent: z.string().max(2_000_000).optional(),
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
})

const chatEditAndRerunSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  newContent: z.string().max(1_000_000),
})

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

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerIpc(deps: RegisterIpcDeps): void {
  const { db, chatService, codeService, gitService, keystore, toolSystem, approvalBroker, questionBroker, oauthManager } = deps

  const register = (channel: ChannelName, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return ok(await fn(...args))
      } catch (e) {
        return err(toNormalizedError(e))
      }
    })
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
    const parsed = parseInput(
      z.object({
        mimeType: z.enum(PASTED_IMAGE_MIME_TYPES),
        dataBase64: z
          .string()
          .min(1)
          .max(MAX_IMAGE_BASE64_CHARS)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Invalid base64 image data'),
      }),
      req
    )
    return storePastedImage(deps.attachmentsDir, parsed.mimeType, parsed.dataBase64)
  })

  register(CHANNELS.appReadAttachment, (storageKey) =>
    readStoredImage(deps.attachmentsDir, requireString(storageKey, 'Attachment key'))
  )

  register(CHANNELS.appSaveAttachmentAs, async (req) => {
    const parsed = parseInput(
      z.object({
        storageKey: z
          .string()
          .max(300)
          .refine(isValidStorageKey, { message: 'Invalid attachment storage key' }),
        suggestedName: z.string().max(200).optional(),
      }),
      req
    )
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

  register(CHANNELS.settingsUpdate, (patch) =>
    db.settings.update(parseInput(settingsPatchSchema, patch))
  )

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
    // no dangling defaultProviderId or conversation.provider_id survives.
    db.driver.transaction(() => {
      if (db.settings.get().defaultProviderId === providerId) {
        db.settings.update({ defaultProviderId: null, defaultModelId: null })
      }
      db.conversations.clearProvider(providerId)
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
      if (!encrypted) {
        throw new ProviderError('auth', 'Add an API key first.', { retryable: false })
      }
      apiKey = keystore.decryptKey(encrypted)
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
    // No key yet: fall back to the catalog (family or preset) instead of failing.
    if (!encrypted) return modelCatalog.knownModels
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
    const parsed = parseInput(
      z.object({ id: z.string().min(1), throughSeq: z.number().int().positive().optional() }),
      req
    )
    const source = found(db.conversations.getById(parsed.id), 'Conversation')
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
    })
    const messages = db.messages
      .listByConversation(source.id)
      .filter((message) => parsed.throughSeq === undefined || message.seq <= parsed.throughSeq)
    for (const message of messages) {
      db.messages.insert({ ...message, id: randomUUID(), conversationId: fork.id })
    }
    return fork
  })

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
    return chatService.send({ ...parsed, content })
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
    const parsed = parseInput(
      z.object({ projectId: z.string().min(1), message: z.string().min(1).max(5000) }),
      req
    )
    return gitService.commit(projectRoot(parsed.projectId), parsed.message)
  })

  register(CHANNELS.codeGitCreateBranch, async (req) => {
    const parsed = parseInput(
      z.object({ projectId: z.string().min(1), name: z.string().min(1).max(200) }),
      req
    )
    const root = projectRoot(parsed.projectId)
    await gitService.createBranch(root, parsed.name)
    return gitService.status(root)
  })

  register(CHANNELS.codeGitGenerateCommitMessage, (projectId) =>
    gitService.generateCommitMessage(projectRoot(projectId))
  )

  register(CHANNELS.codeWorktreeCreate, async (req) => {
    const parsed = parseInput(
      z.object({ projectId: z.string().min(1), name: z.string().max(100).optional() }),
      req
    )
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

  register(CHANNELS.codeCheckpointsList, (conversationId) =>
    db.agentPlatform.checkpointsList(requireString(conversationId, 'Conversation id'))
  )

  register(CHANNELS.codeCheckpointRestore, (checkpointId) =>
    codeService.restoreCheckpoint(requireString(checkpointId, 'Checkpoint id'))
  )

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

  register(CHANNELS.backupExport, async () => {
    const date = new Date().toISOString().slice(0, 10)
    return saveTextFile(
      `grasberg-backup-${date}.json`,
      [{ name: 'JSON', extensions: ['json'] }],
      JSON.stringify(buildBackup(db), null, 2)
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

  register(CHANNELS.imSetTelegram, (input) =>
    imBridgeManager.setTelegram(parseInput(imTelegramSchema, input))
  )

  register(CHANNELS.imSetWebhook, (url) => {
    if (url !== null && typeof url !== 'string') throw invalid('Webhook URL must be a string or null.')
    return imBridgeManager.setWebhook(url as string | null)
  })

  // -- workflows --------------------------------------------------------------

  const asGraph = (value: unknown): WorkflowGraph =>
    parseInput(workflowGraphSchema, value) as WorkflowGraph
  const asWorkflowInput = (value: unknown): WorkflowInput => {
    const o = value as {
      name?: unknown
      graph?: unknown
      schedule?: unknown
      scheduleEnabled?: unknown
    }
    const name = typeof o?.name === 'string' ? o.name.trim() : ''
    if (name.length === 0) throw invalid('Workflow name is required.')
    // Interval clamped to [1 minute, 7 days]; anything else = no schedule.
    let schedule: WorkflowInput['schedule'] = null
    if (o?.schedule && typeof o.schedule === 'object') {
      const every = (o.schedule as { everyMinutes?: unknown }).everyMinutes
      if (typeof every === 'number' && Number.isFinite(every) && every >= 1) {
        schedule = { everyMinutes: Math.min(Math.floor(every), 7 * 24 * 60) }
      }
    }
    // Enabling the schedule with an invalid interval must fail loudly, not
    // save a workflow that silently never fires.
    if (o?.scheduleEnabled === true && schedule === null) {
      throw invalid('Schedule interval must be at least 1 minute.')
    }
    return {
      name,
      graph: asGraph(o?.graph),
      schedule,
      scheduleEnabled: o?.scheduleEnabled === true,
    }
  }

  register(CHANNELS.workflowsList, () => db.workflows.list())
  register(CHANNELS.workflowsGet, (id) => db.workflows.getById(requireString(id, 'Workflow id')))
  register(CHANNELS.workflowsCreate, (input) => db.workflows.create(asWorkflowInput(input)))
  register(CHANNELS.workflowsUpdate, (id, input) =>
    found(db.workflows.update(requireString(id, 'Workflow id'), asWorkflowInput(input)), 'Workflow')
  )
  register(CHANNELS.workflowsDelete, (id) => {
    db.workflows.remove(requireString(id, 'Workflow id'))
    return undefined
  })
  register(CHANNELS.workflowsRun, (graph) =>
    runWorkflow(asGraph(graph), {
      runAgent: (prompt, providerId, modelId, opts) =>
        chatService.generateForWorkflow(prompt, providerId, modelId, opts),
      notify: (text) => deps.imBridgeManager.notify(text),
    })
  )

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
  }) satisfies z.ZodType<ScheduledTaskInput>

  const signalScheduledTasksChanged = (): void => {
    for (const win of deps.getWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(CHANNELS.scheduledTasksChanged, {})
      }
    }
  }

  register(CHANNELS.scheduledTasksList, () => db.scheduledTasks.list())
  register(CHANNELS.scheduledTasksCreate, (input) => {
    const parsed = parseInput(scheduledTaskInputSchema, input)
    if (parsed.runAt < Date.now() - 60_000) {
      throw invalid('The first run time cannot be in the past.')
    }
    const task = db.scheduledTasks.create(parsed)
    signalScheduledTasksChanged()
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
    signalScheduledTasksChanged()
    return task
  })
  register(CHANNELS.scheduledTasksDelete, (id) => {
    db.scheduledTasks.remove(requireString(id, 'Scheduled task id'))
    signalScheduledTasksChanged()
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
    db.agents.remove(requireString(id, 'Agent id'))
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
    const parsed = parseInput(agentPackSchema, JSON.parse(await readFile(picked.filePaths[0], 'utf8')))
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
}
