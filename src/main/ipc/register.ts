/**
 * Registers every request/response IPC channel. Each handler validates its
 * input, calls through to the service/repository layer, and always resolves
 * to an IpcResult — errors are normalized, never thrown across the boundary.
 */

import { randomUUID } from 'node:crypto'
import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { z } from 'zod'
import { CHANNELS, err, ok, type ChannelName, type PickFilesResult } from '@shared/ipc'
import type { AppInfo, Attachment, WorkflowGraph, WorkflowInput } from '@shared/types'
import { runWorkflow } from '../workflows/engine'
import {
  CHATGPT_OAUTH_DEFAULT_MODEL,
  PROVIDER_TYPES,
  PROVIDER_TYPE_LIST,
  providerAuthModes,
  resolveModelCatalog,
} from '@shared/catalog'
import { presetMeta } from '@shared/presets'
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
  settingsPatchSchema,
} from '@shared/schemas'
import type { AppDatabase } from '../db/database'
import type { ChatService } from '../services/chat-service'
import type { CodeService } from '../code/code-service'
import type { Keystore } from '../keys/keystore'
import { customToolDbId, type ToolSystem } from '../tools'
import type { McpManager } from '../tools/mcp/manager'
import type { ImBridgeManager } from '../im/manager'
import type { ApprovalBroker } from '../services/approval-broker'
import { getAdapter, resolveAdapter } from '../providers/registry'
import type { OpenAiOAuthManager } from '../providers/openai-oauth'
import { ProviderError, toNormalizedError } from '../providers/errors'
import { toJson, toMarkdown, exportFileBase, documentToHtml } from '../services/export'
import { readSkillsFromFolder } from '../services/skills'
import { applyBackup, buildBackup } from '../services/backup'
import { readAttachment, readStoredImage } from './attachments'
import { readFile, writeFile } from 'node:fs/promises'

export interface RegisterIpcDeps {
  db: AppDatabase
  chatService: ChatService
  codeService: CodeService
  keystore: Keystore
  toolSystem: ToolSystem
  approvalBroker: ApprovalBroker
  mcpManager: McpManager
  imBridgeManager: ImBridgeManager
  oauthManager: OpenAiOAuthManager
  /** Directory where image attachments are stored on disk. */
  attachmentsDir: string
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

// ---------------------------------------------------------------------------
// Schemas without a shared counterpart (hand-rolled, minimal)
// ---------------------------------------------------------------------------

const conversationModeSchema = z.enum(['chat', 'cowork', 'code', 'write', 'design'])

const convListSchema = z
  .object({
    mode: conversationModeSchema.optional(),
    search: z.string().max(500).optional(),
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
  }),
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
  storageKey: z.string().max(300).optional(),
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
    })
    .optional(),
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

const workspaceItemKindSchema = z.enum(['note', 'plan', 'checklist', 'doc', 'task'])

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

const toolPermissionDecisionSchema = z.enum(['always_allow', 'ask', 'deny'])

const codeReadFileSchema = z.object({
  projectId: z.string().min(1),
  relPath: z.string().min(1).max(2000),
})

const convExportSchema = z.object({
  conversationId: z.string().min(1),
  format: z.enum(['markdown', 'json']),
})

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerIpc(deps: RegisterIpcDeps): void {
  const { db, chatService, codeService, keystore, toolSystem, approvalBroker, oauthManager } = deps

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
    const parent = dialogParent()
    const options = { properties: ['openDirectory'] as Array<'openDirectory'> }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  register(CHANNELS.appPickFiles, async (): Promise<PickFilesResult> => {
    const parent = dialogParent()
    const options = {
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return { attachments: [] }
    const attachments: Attachment[] = []
    for (const filePath of result.filePaths) {
      const attachment = await readAttachment(filePath, deps.attachmentsDir)
      if (attachment) attachments.push(attachment)
    }
    return { attachments }
  })

  register(CHANNELS.appReadAttachment, (storageKey) =>
    readStoredImage(deps.attachmentsDir, requireString(storageKey, 'Attachment key'))
  )

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
    const updated = db.providers.update(providerId, parsed)
    if (!updated) throw invalid('Provider not found.')
    return updated
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
    const updated = db.providers.getById(provider.id)
    if (!updated) throw invalid('Provider not found.')
    return updated
  })

  register(CHANNELS.providersDeleteKey, (id) => {
    const provider = requireProvider(id)
    db.providers.deleteKeyRow(provider.id)
    const updated = db.providers.getById(provider.id)
    if (!updated) throw invalid('Provider not found.')
    return updated
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
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TEST_CONNECTION_TIMEOUT_MS)
    try {
      return await resolveAdapter(provider.type, provider.authMode).testConnection({
        apiKey,
        baseUrl: provider.baseUrl,
        accountId,
        modelCatalog: resolveModelCatalog(provider),
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

  register(CHANNELS.convCreate, (req) =>
    db.conversations.create(parseInput(convCreateSchema, req))
  )

  register(CHANNELS.convGet, (id) => {
    const conversation = db.conversations.getById(requireString(id, 'Conversation id'))
    if (!conversation) throw invalid('Conversation not found.')
    return conversation
  })

  register(CHANNELS.convUpdate, (req) => {
    const parsed = parseInput(convUpdateSchema, req)
    const updated = db.conversations.update(parsed.id, parsed.patch)
    if (!updated) throw invalid('Conversation not found.')
    return updated
  })

  register(CHANNELS.convDelete, (id) => {
    const conversationId = requireString(id, 'Conversation id')
    // Stop any generation running in this conversation before deleting its rows
    // so the detached loop doesn't write to messages that no longer exist.
    chatService.stopConversation(conversationId)
    db.conversations.remove(conversationId)
    return undefined
  })

  register(CHANNELS.convMessages, (conversationId) =>
    db.messages.listByConversation(requireString(conversationId, 'Conversation id'))
  )

  register(CHANNELS.convExport, async (req) => {
    const parsed = parseInput(convExportSchema, req)
    const conversation = db.conversations.getById(parsed.conversationId)
    if (!conversation) throw invalid('Conversation not found.')
    const messages = db.messages.listByConversation(parsed.conversationId)
    const isMarkdown = parsed.format === 'markdown'
    const content = isMarkdown ? toMarkdown(conversation, messages) : toJson(conversation, messages)
    const ext = isMarkdown ? 'md' : 'json'
    const dialogOptions = {
      defaultPath: `${exportFileBase(conversation)}.${ext}`,
      filters: [
        isMarkdown
          ? { name: 'Markdown', extensions: ['md'] }
          : { name: 'JSON', extensions: ['json'] },
      ],
    }
    const parent = dialogParent()
    const result = parent
      ? await dialog.showSaveDialog(parent, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)
    if (result.canceled || !result.filePath) return { canceled: true }
    await writeFile(result.filePath, content, 'utf8')
    return { canceled: false, path: result.filePath }
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

  register(CHANNELS.chatEditAndRerun, (req) => {
    const parsed = parseInput(chatEditAndRerunSchema, req)
    const newContent = parsed.newContent.trim()
    if (newContent.length === 0) throw invalid('The edited message cannot be empty.')
    return chatService.editAndRerun({ ...parsed, newContent })
  })

  // -- cowork workspaces --------------------------------------------------------------

  register(CHANNELS.workspaceList, () => db.workspaces.list())

  register(CHANNELS.workspaceCreate, (input) =>
    db.workspaces.create(parseInput(workspaceCreateSchema, input))
  )

  register(CHANNELS.workspaceGet, (id) => {
    const workspace = db.workspaces.getById(requireString(id, 'Workspace id'))
    if (!workspace) throw invalid('Workspace not found.')
    return workspace
  })

  register(CHANNELS.workspaceUpdate, (id, patch) => {
    const workspaceId = requireString(id, 'Workspace id')
    const updated = db.workspaces.update(workspaceId, parseInput(workspacePatchSchema, patch))
    if (!updated) throw invalid('Workspace not found.')
    return updated
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
    const updated = db.workspaces.itemUpdate(itemId, parseInput(workspaceItemPatchSchema, patch))
    if (!updated) throw invalid('Workspace item not found.')
    return updated
  })

  register(CHANNELS.workspaceItemDelete, (id) => {
    db.workspaces.itemDelete(requireString(id, 'Item id'))
    return undefined
  })

  // -- code mode --------------------------------------------------------------------

  register(CHANNELS.codeProjectsList, () => db.code.projectsList())

  // The path always comes from the OS folder picker — the explicit user grant.
  register(CHANNELS.codeProjectOpen, (path) =>
    codeService.openProject(requireString(path, 'Project path'))
  )

  register(CHANNELS.codeProjectForget, (id) => {
    db.code.projectForget(requireString(id, 'Project id'))
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

  // -- tools --------------------------------------------------------------------

  register(CHANNELS.toolsList, () => toolSystem.registry.listDefinitions())

  register(CHANNELS.toolsSetEnabled, (toolId, enabled) => {
    const id = requireString(toolId, 'Tool id')
    const flag = requireBoolean(enabled, 'enabled')
    // The registry rejects ids it does not know (throws a plain Error).
    try {
      toolSystem.registry.setEnabled(id, flag)
    } catch (e) {
      throw invalid(e instanceof Error ? e.message : 'Unknown tool.')
    }
    return undefined
  })

  register(CHANNELS.toolsPermissionsList, () => toolSystem.registry.listPermissions())

  register(CHANNELS.toolsPermissionSet, (toolId, decision) => {
    const id = requireString(toolId, 'Tool id')
    const parsed = parseInput(toolPermissionDecisionSchema, decision)
    try {
      toolSystem.registry.setPermission(id, parsed)
    } catch (e) {
      throw invalid(e instanceof Error ? e.message : 'Unknown tool.')
    }
    return undefined
  })

  // The renderer's approve/decline click for a pending tool call. Unknown or
  // expired requestIds are ignored by the broker (still resolves ok).
  register(CHANNELS.toolsApprovalRespond, (requestId, approved) => {
    approvalBroker.respond(
      requireString(requestId, 'Request id'),
      requireBoolean(approved, 'approved')
    )
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
    let definition
    try {
      definition = toolSystem.registry.addCustomTool(parsed)
    } catch (e) {
      throw invalid(e instanceof Error ? e.message : 'Invalid custom tool.')
    }
    storeSecretHeaders(customToolDbId(definition.id), parsed.setSecretHeaders)
    return toolSystem.registry.listCustomToolInfos()
  })

  register(CHANNELS.toolsCustomUpdate, (toolId, patch) => {
    const id = requireString(toolId, 'Tool id')
    const parsed = parseInput(customToolPatchSchema, patch)
    let definition
    try {
      definition = toolSystem.registry.updateCustomTool(id, parsed)
    } catch (e) {
      throw invalid(e instanceof Error ? e.message : 'Invalid custom tool.')
    }
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
    try {
      toolSystem.registry.removeCustomTool(id)
    } catch (e) {
      throw invalid(e instanceof Error ? e.message : 'Unknown tool.')
    }
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
    const updated = db.prompts.update(templateId, parseInput(promptTemplatePatchSchema, patch))
    if (!updated) throw invalid('Prompt not found.')
    return updated
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
    const updated = db.memories.update(memoryId, parseInput(memoryPatchSchema, patch))
    if (!updated) throw invalid('Memory not found.')
    return updated
  })

  register(CHANNELS.memoriesDelete, (id) => {
    db.memories.remove(requireString(id, 'Memory id'))
    return undefined
  })

  // -- skills -------------------------------------------------------------------

  register(CHANNELS.skillsList, () => db.skills.list())

  register(CHANNELS.skillsCreate, (input) => db.skills.create(parseInput(skillInputSchema, input)))

  register(CHANNELS.skillsUpdate, (id, patch) => {
    const skillId = requireString(id, 'Skill id')
    const updated = db.skills.update(skillId, parseInput(skillPatchSchema, patch))
    if (!updated) throw invalid('Skill not found.')
    return updated
  })

  register(CHANNELS.skillsDelete, (id) => {
    db.skills.remove(requireString(id, 'Skill id'))
    return undefined
  })

  register(CHANNELS.skillsImportFolder, async (path) => {
    const folder = requireString(path, 'Folder path')
    let result
    try {
      result = await readSkillsFromFolder(folder)
    } catch (e) {
      throw invalid(e instanceof Error ? e.message : 'Could not read the folder.')
    }
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
    const options = {
      defaultPath: `grasberg-backup-${date}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    }
    const parent = dialogParent()
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { canceled: true }
    await writeFile(result.filePath, JSON.stringify(buildBackup(db), null, 2), 'utf8')
    return { canceled: false, path: result.filePath }
  })

  register(CHANNELS.backupImport, async () => {
    const options = {
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    }
    const parent = dialogParent()
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(result.filePaths[0], 'utf8'))
    } catch {
      throw invalid('The selected file is not valid JSON.')
    }
    try {
      return { canceled: false, ...applyBackup(db, raw) }
    } catch (e) {
      throw invalid(e instanceof Error ? e.message : 'Could not import the backup.')
    }
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
    const parsed = parseInput(
      z
        .object({
          token: z.string().max(4096).optional(),
          conversationId: z.string().nullable(),
          enabled: z.boolean(),
        })
        .strict(),
      input
    )
    return imBridgeManager.setTelegram(parsed)
  })

  register(CHANNELS.imSetWebhook, (url) => {
    if (url !== null && typeof url !== 'string') throw invalid('Webhook URL must be a string or null.')
    return imBridgeManager.setWebhook(url as string | null)
  })

  // -- Write / Design documents ----------------------------------------------

  register(CHANNELS.documentsGet, (conversationId) =>
    db.documents.getDoc(requireString(conversationId, 'Conversation id'))
  )

  register(CHANNELS.documentsSave, (conversationId, content) => {
    const id = requireString(conversationId, 'Conversation id')
    if (typeof content !== 'string') throw invalid('Document content must be a string.')
    if (content.length > 2_000_000) throw invalid('Document is too large.')
    const existing = db.documents.getDoc(id)
    return db.documents.upsertDoc(id, existing?.title ?? 'Document', content)
  })

  register(CHANNELS.documentsListHtml, (conversationId) =>
    db.documents.listByConversation(requireString(conversationId, 'Conversation id'), 'html')
  )

  register(CHANNELS.documentsExport, async (id, format) => {
    const docId = requireString(id, 'Document id')
    const fmt = parseInput(z.enum(['markdown', 'html']), format)
    const doc = db.documents.getById(docId)
    if (!doc) throw invalid('Document not found.')
    const isHtml = fmt === 'html'
    const content = isHtml ? documentToHtml(doc.title, doc.kind, doc.content) : doc.content
    const ext = isHtml ? 'html' : doc.kind === 'html' ? 'html' : 'md'
    const base = (doc.title || 'document').replace(/[^\w\-. ]+/g, '').trim().replace(/\s+/g, '-') || 'document'
    const options = {
      defaultPath: `${base}.${ext}`,
      filters: [
        isHtml
          ? { name: 'HTML', extensions: ['html'] }
          : { name: 'Markdown', extensions: ['md'] },
      ],
    }
    const parent = dialogParent()
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { canceled: true }
    await writeFile(result.filePath, content, 'utf8')
    return { canceled: false, path: result.filePath }
  })

  // -- workflows --------------------------------------------------------------

  const asGraph = (value: unknown): WorkflowGraph => {
    const g = value as { nodes?: unknown; edges?: unknown }
    if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
      throw invalid('Invalid workflow graph.')
    }
    return value as WorkflowGraph
  }
  const asWorkflowInput = (value: unknown): WorkflowInput => {
    const o = value as { name?: unknown; graph?: unknown }
    const name = typeof o?.name === 'string' ? o.name.trim() : ''
    if (name.length === 0) throw invalid('Workflow name is required.')
    return { name, graph: asGraph(o?.graph) }
  }

  register(CHANNELS.workflowsList, () => db.workflows.list())
  register(CHANNELS.workflowsGet, (id) => db.workflows.getById(requireString(id, 'Workflow id')))
  register(CHANNELS.workflowsCreate, (input) => db.workflows.create(asWorkflowInput(input)))
  register(CHANNELS.workflowsUpdate, (id, input) => {
    const updated = db.workflows.update(requireString(id, 'Workflow id'), asWorkflowInput(input))
    if (!updated) throw invalid('Workflow not found.')
    return updated
  })
  register(CHANNELS.workflowsDelete, (id) => {
    db.workflows.remove(requireString(id, 'Workflow id'))
    return undefined
  })
  register(CHANNELS.workflowsRun, (graph) =>
    runWorkflow(asGraph(graph), {
      runAgent: (prompt, providerId, modelId) =>
        chatService.generateForWorkflow(prompt, providerId, modelId),
    })
  )
}
