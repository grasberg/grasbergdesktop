/**
 * Backup export/import of user data: settings, memories, skills, prompt
 * templates, workflows and full conversations (with messages), as one portable
 * JSON file. API keys, OAuth tokens and other secrets are NEVER part of a
 * backup — they stay in the OS keystore-encrypted provider storage. Provider
 * configs and MCP servers are also excluded: without their secrets they import
 * as broken half-entries, so re-adding them explicitly is the safer flow.
 *
 * Import is tolerant: the envelope (format marker) must match, but individual
 * entries that fail validation are skipped and counted rather than failing the
 * whole import. Memories upsert by title, skills by name, prompts/workflows
 * dedupe by title/name, and conversations keep their original ids — an id
 * that already exists is skipped, so re-importing never duplicates data.
 */

import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_SETTINGS,
  SECURITY_SENSITIVE_SETTING_KEYS,
  type AppSettings,
  type BackupSummary,
  type BackupPreview,
  type Conversation,
  type Message,
  type WorkflowGraph,
} from '@shared/types'
import { chatParamsSchema, settingsPatchSchema, workflowGraphSchema } from '@shared/schemas'
import type { AppDatabase } from '../db/database'

export const BACKUP_FORMAT = 'grasberg-backup'
/** Pre-rebrand marker ("Grasberg"); still accepted on import. */
export const LEGACY_BACKUP_FORMAT = 'grasberg-desktop-backup'
/**
 * v3: the two-mode model — legacy modes remap to 'work' on import.
 * v4: private spaces — a `spaces` section and conversation `spaceId`, present
 * only when the export explicitly opted private spaces in.
 * v5: every memory carries its owner; unknown owners remain isolated.
 */
export const BACKUP_VERSION = 5

/** A conversation with its transcript, as exported. */
interface BackupConversation extends Conversation {
  messages: Message[]
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: number
  exportedAt: number
  settings: Record<string, unknown>
  memories: { title: string; content: string; agentId: string | null }[]
  skills: {
    name: string
    description: string
    content: string
    pluginName: string | null
    sourcePath: string | null
    enabled: boolean
  }[]
  conversations: BackupConversation[]
  prompts: { title: string; body: string }[]
  workflows: { name: string; graph: unknown }[]
  /** Present only when the export explicitly included private spaces (v4). */
  spaces?: { id: string; name: string; providerAllowlist: string[] | null }[]
}

/**
 * Collects the current user data into a backup object. Private-space
 * conversations are EXCLUDED unless `includePrivateSpaces` is set — the
 * repository's default listing already scopes to the default space.
 */
export function buildBackup(
  db: AppDatabase,
  opts?: { includePrivateSpaces?: boolean }
): BackupFile {
  const includePrivate = opts?.includePrivateSpaces === true
  const conversations: BackupConversation[] = []
  // includeBots: bot chats and group-room transcripts (v46) are hidden from
  // the sidebar listing but must never be lost from an exported backup.
  for (const summary of db.conversations.list(
    includePrivate ? { allSpaces: true, includeBots: true } : { includeBots: true }
  )) {
    const conversation = db.conversations.getById(summary.id)
    if (!conversation) continue
    conversations.push({
      ...conversation,
      messages: db.messages.listByConversation(conversation.id),
    })
  }
  // The security-sensitive keys hold bearer secrets (webhook URL, Telegram
  // pairing code) and capability switches; import never applies them anyway, so
  // a plaintext backup must not carry them out of the app in the first place.
  const settings = Object.fromEntries(
    Object.entries(db.settings.get()).filter(([key]) => !SECURITY_SENSITIVE_SETTING_KEYS.has(key))
  )
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    settings,
    memories: db.memories.list().map((m) => ({ title: m.title, content: m.content, agentId: m.agentId })),
    skills: db.skills.list().map((s) => ({
      name: s.name,
      description: s.description,
      content: s.content,
      pluginName: s.pluginName,
      sourcePath: s.sourcePath,
      enabled: s.enabled,
    })),
    conversations,
    prompts: db.prompts.list().map((p) => ({ title: p.title, body: p.body })),
    workflows: db.workflows.list().map((w) => ({ name: w.name, graph: w.graph })),
    ...(includePrivate
      ? {
          spaces: db.spaces.list().map((s) => ({
            id: s.id,
            name: s.name,
            providerAllowlist: s.providerAllowlist,
          })),
        }
      : {}),
  }
}

// -- import validation ----------------------------------------------------------

/** Envelope: only the format marker is strict; sections are optional. */
const envelopeSchema = z
  .object({
    format: z.union([z.literal(BACKUP_FORMAT), z.literal(LEGACY_BACKUP_FORMAT)]),
    version: z.number().int().min(1),
    settings: z.record(z.unknown()).optional(),
    memories: z.array(z.unknown()).max(100_000).optional(),
    skills: z.array(z.unknown()).max(100_000).optional(),
    conversations: z.array(z.unknown()).max(100_000).optional(),
    prompts: z.array(z.unknown()).max(100_000).optional(),
    workflows: z.array(z.unknown()).max(100_000).optional(),
    spaces: z.array(z.unknown()).max(1000).optional(),
  })
  .passthrough()

/** Bounded, expiring previews hold the exact bytes reviewed, never a mutable file path. */
export class BackupImports {
  private pending = new Map<string, { owner: string; raw: unknown; expires: number }>()
  constructor(private db: AppDatabase, private now = Date.now) {}

  prepare(json: string, filename: string, owner = 'desktop'): BackupPreview {
    if (Buffer.byteLength(json, 'utf8') > 64 * 1024 * 1024) throw new Error('Backups must be 64 MB or smaller.')
    let raw: unknown
    try { raw = JSON.parse(json) } catch { throw new Error('The selected file is not valid JSON.') }
    const parsed = envelopeSchema.safeParse(raw)
    if (!parsed.success) throw new Error('Not a Grasberg backup file.')
    if (parsed.data.version > BACKUP_VERSION) throw new Error('This backup needs a newer version of Grasberg.')
    const data = parsed.data
    const counts: BackupSummary = { settingsApplied: 0, memoriesImported: 0, skillsImported: 0, conversationsImported: 0, promptsImported: 0, workflowsImported: 0, skippedItems: 0 }
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (data.settings && key in data.settings && !SECURITY_SENSITIVE_SETTING_KEYS.has(key) && settingsPatchSchema.safeParse({ [key]: data.settings[key] }).success) counts.settingsApplied++
    }
    for (const item of data.memories ?? []) {
      const p = memoryItemSchema.safeParse(item)
      if (p.success && (data.version < 5 || p.data.agentId !== undefined)) counts.memoriesImported++
      else counts.skippedItems++
    }
    for (const item of data.skills ?? []) {
      if (skillItemSchema.safeParse(item).success) counts.skillsImported++
      else counts.skippedItems++
    }
    const seenConversations = new Set<string>()
    for (const item of data.conversations ?? []) {
      const p = conversationItemSchema.safeParse(item)
      if (p.success && !this.db.conversations.getById(p.data.id) && !seenConversations.has(p.data.id)) {
        seenConversations.add(p.data.id); counts.conversationsImported++
      } else counts.skippedItems++
    }
    const promptNames = new Set(this.db.prompts.list().map(p => p.title.toLowerCase()))
    for (const item of data.prompts ?? []) {
      const p = promptItemSchema.safeParse(item)
      if (p.success && !promptNames.has(p.data.title.toLowerCase())) { promptNames.add(p.data.title.toLowerCase()); counts.promptsImported++ }
      else counts.skippedItems++
    }
    const workflowNames = new Set(this.db.workflows.list().map(w => w.name.toLowerCase()))
    for (const item of data.workflows ?? []) {
      const p = workflowItemSchema.safeParse(item)
      if (p.success && !workflowNames.has(p.data.name.toLowerCase())) { workflowNames.add(p.data.name.toLowerCase()); counts.workflowsImported++ }
      else counts.skippedItems++
    }
    for (const [id, p] of this.pending) if (p.owner === owner || p.expires <= this.now()) this.pending.delete(id)
    if (this.pending.size >= 4) this.pending.delete(this.pending.keys().next().value!)
    const id = randomUUID()
    this.pending.set(id, { owner, raw, expires: this.now() + 10 * 60_000 })
    return { id, filename, version: data.version, exportedAt: typeof data.exportedAt === 'number' ? data.exportedAt : null, counts }
  }

  commit(id: string, owner = 'desktop'): BackupSummary {
    const pending = this.pending.get(id)
    if (!pending || pending.owner !== owner || pending.expires <= this.now()) throw new Error('This import preview expired. Choose the backup again.')
    const result = this.db.driver.transaction(() => applyBackup(this.db, pending.raw))
    this.pending.delete(id)
    return result
  }
}

const memoryItemSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    content: z.string().max(10_000),
    agentId: z.string().min(1).max(100).nullable().optional(),
  })
  .passthrough()

const skillItemSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(1024).optional(),
    content: z.string().min(1).max(200_000),
    pluginName: z.string().max(100).nullable().optional(),
    sourcePath: z.string().max(2000).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough()

const backupMessageSchema = z
  .object({
    id: z.string().min(1).max(100),
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    content: z.string().max(2_000_000),
    reasoning: z.string().max(2_000_000).optional(),
    status: z.enum(['streaming', 'complete', 'stopped', 'error']).optional(),
    providerId: z.string().max(100).optional(),
    modelId: z.string().max(200).optional(),
    seq: z.number().int().min(0),
    createdAt: z.number().int().optional(),
  })
  .passthrough()

// Ids are kept verbatim on import and a Work conversation's id becomes a
// directory name under the workspaces base — so only the charset app-generated
// ids actually use is accepted, never a path traversal segment.
const BACKUP_ID_PATTERN = /^[A-Za-z0-9._-]+$/

// Accepts pre-v3 backups' legacy modes; anything non-chat imports as 'work'.
const conversationItemSchema = z
  .object({
    id: z.string().min(1).max(100).regex(BACKUP_ID_PATTERN),
    mode: z.enum(['chat', 'work', 'cowork', 'code', 'write', 'design']),
    title: z.string().max(500),
    providerId: z.string().max(100).nullable().optional(),
    modelId: z.string().max(200).nullable().optional(),
    systemPrompt: z.string().max(100_000).nullable().optional(),
    moaPresetId: z.string().max(100).nullable().optional(),
    params: z.unknown().optional(),
    messages: z.array(z.unknown()).max(100_000).optional(),
    spaceId: z.string().max(100).nullable().optional(),
  })
  .passthrough()

const spaceItemSchema = z
  .object({
    id: z.string().min(1).max(100).regex(BACKUP_ID_PATTERN),
    name: z.string().trim().min(1).max(60),
    providerAllowlist: z.array(z.string().max(100)).nullable().optional(),
  })
  .passthrough()

const promptItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(100_000),
})

const workflowItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  // Same strict graph schema the IPC save path enforces: an imported graph goes
  // straight into the editor and the engine.
  graph: workflowGraphSchema,
})

// JSON-column payloads travel from the backup straight into the renderer and
// (via tool replay) onto the provider wire, so each element is shape-checked;
// entries that fail are dropped rather than imported corrupt.
const attachmentItemSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number(),
    kind: z.enum(['text', 'image']),
  })
  .passthrough()

const toolCallItemSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    arguments: z.string(),
    result: z.string().optional(),
    status: z.enum(['proposed', 'approved', 'denied', 'done', 'error']).optional(),
  })
  .passthrough()

const moaReferenceItemSchema = z
  .object({
    index: z.number().int().min(0),
    label: z.string(),
    providerId: z.string(),
    modelId: z.string(),
    status: z.enum(['running', 'done', 'error']),
    text: z.string(),
  })
  .passthrough()

const usageItemSchema = z.object({
  promptTokens: z.number().optional(),
  completionTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
})

const compareItemSchema = z.object({ pickedIndex: z.number().int().min(0).nullable() })

const errorItemSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
})

/** Validates each array element against `schema`, dropping failures. */
function parseArrayOf<T>(schema: z.ZodType<T>, value: unknown): T[] | undefined {
  if (!Array.isArray(value)) return undefined
  const valid = value
    .map((entry) => schema.safeParse(entry))
    .filter((r): r is z.SafeParseSuccess<T> => r.success)
    .map((r) => r.data)
  return valid.length > 0 ? valid : undefined
}

function parseObjectOf<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/**
 * Applies a parsed backup file to the database. Throws only when `raw` is not
 * a Grasberg backup at all; individually invalid entries are skipped.
 */
export function applyBackup(db: AppDatabase, raw: unknown): BackupSummary {
  const envelope = envelopeSchema.safeParse(raw)
  if (!envelope.success) {
    throw new Error('Not a Grasberg backup file.')
  }
  const data = envelope.data
  const summary: BackupSummary = {
    settingsApplied: 0,
    memoriesImported: 0,
    skillsImported: 0,
    conversationsImported: 0,
    promptsImported: 0,
    workflowsImported: 0,
    skippedItems: 0,
  }

  // Settings: validate key by key so one bad value never blocks the rest;
  // the valid keys accumulate into one patch applied with a single write.
  // Security-sensitive keys are never taken from a backup — applying them from
  // an untrusted file would grant shell/browser execution or wire up
  // exfiltration behind a single "Import" click (see the shared set's docs).
  if (data.settings) {
    const patch: Partial<AppSettings> = {}
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (!(key in data.settings)) continue
      if (SECURITY_SENSITIVE_SETTING_KEYS.has(key)) continue
      const single = settingsPatchSchema.safeParse({ [key]: data.settings[key] })
      if (!single.success) continue
      Object.assign(patch, single.data)
      summary.settingsApplied += 1
    }
    if (summary.settingsApplied > 0) db.settings.update(patch)
  }

  for (const item of data.memories ?? []) {
    const parsed = memoryItemSchema.safeParse(item)
    if (!parsed.success || (data.version >= 5 && parsed.data.agentId === undefined)) {
      summary.skippedItems += 1
      continue
    }
    // No roster is imported. Keep an unknown owner inert, never promote it
    // into shared memory or guess an owner from a matching name.
    db.memories.upsertByTitle({
      title: parsed.data.title,
      content: parsed.data.content,
      agentId: parsed.data.agentId ?? null,
    })
    summary.memoriesImported += 1
  }

  for (const item of data.skills ?? []) {
    const parsed = skillItemSchema.safeParse(item)
    if (!parsed.success) {
      summary.skippedItems += 1
      continue
    }
    const skill = db.skills.upsertByName({
      name: parsed.data.name,
      description: parsed.data.description ?? '',
      content: parsed.data.content,
      pluginName: parsed.data.pluginName ?? null,
      sourcePath: parsed.data.sourcePath ?? null,
    })
    // upsertByName preserves an existing enabled flag; the backup's explicit
    // flag (when present) wins on import.
    if (typeof parsed.data.enabled === 'boolean' && parsed.data.enabled !== skill.enabled) {
      db.skills.update(skill.id, { enabled: parsed.data.enabled })
    }
    summary.skillsImported += 1
  }

  // Spaces (v4): match an existing space by case-insensitive name (reusing its
  // id), else recreate it. Allowlists reference provider ids that don't
  // survive backups, so they import as null (= all providers).
  const spaceIdMap = new Map<string, string>()
  for (const item of data.spaces ?? []) {
    const parsed = spaceItemSchema.safeParse(item)
    if (!parsed.success) {
      summary.skippedItems += 1
      continue
    }
    const s = parsed.data
    const existing = db.spaces.list().find((x) => x.name.toLowerCase() === s.name.toLowerCase())
    if (existing) {
      spaceIdMap.set(s.id, existing.id)
      continue
    }
    const created = db.spaces.create({
      id: db.spaces.getById(s.id) ? undefined : s.id,
      name: s.name,
      providerAllowlist: null,
    })
    spaceIdMap.set(s.id, created.id)
  }

  // Conversations keep their original ids so a re-import recognizes (and
  // skips) them. Workspace/project links are dropped — those entities aren't
  // part of the backup, and dangling references would break their views.
  for (const item of data.conversations ?? []) {
    const parsed = conversationItemSchema.safeParse(item)
    if (!parsed.success) {
      summary.skippedItems += 1
      continue
    }
    const c = parsed.data
    if (db.conversations.getById(c.id)) {
      summary.skippedItems += 1
      continue
    }
    try {
      // One transaction per conversation: a failure (or a crash mid-import)
      // leaves no half-imported row behind, so a re-import retries it cleanly
      // instead of skipping it — with its transcript truncated — forever.
      let skippedMessages = 0
      db.driver.transaction(() => {
        skippedMessages = 0
        db.conversations.create({
          id: c.id,
          mode: c.mode === 'chat' ? 'chat' : 'work',
          title: c.title || 'Imported chat',
          providerId: c.providerId ?? null,
          modelId: c.modelId ?? null,
          systemPrompt: c.systemPrompt ?? null,
          moaPresetId: c.moaPresetId ?? null,
          // Unknown spaceIds land in the default space rather than dangling.
          spaceId: c.spaceId ? (spaceIdMap.get(c.spaceId) ?? null) : null,
        })
        const params = parseObjectOf(chatParamsSchema, c.params)
        if (params && Object.keys(params).length > 0) {
          db.conversations.update(c.id, { params })
        }
        for (const rawMessage of c.messages ?? []) {
          const msg = backupMessageSchema.safeParse(rawMessage)
          if (!msg.success) {
            skippedMessages += 1
            continue
          }
          const extras = rawMessage as Record<string, unknown>
          const m = msg.data
          db.messages.insert({
            id: m.id,
            conversationId: c.id,
            role: m.role,
            content: m.content,
            reasoning: m.reasoning,
            // A row exported mid-generation can never resume here.
            status: m.status === 'streaming' ? 'stopped' : (m.status ?? 'complete'),
            providerId: m.providerId,
            modelId: m.modelId,
            attachments: parseArrayOf(attachmentItemSchema, extras.attachments) as
              | Message['attachments']
              | undefined,
            toolCalls: parseArrayOf(toolCallItemSchema, extras.toolCalls) as
              | Message['toolCalls']
              | undefined,
            usage: parseObjectOf(usageItemSchema, extras.usage),
            moaReferences: parseArrayOf(moaReferenceItemSchema, extras.moaReferences) as
              | Message['moaReferences']
              | undefined,
            compare: parseObjectOf(compareItemSchema, extras.compare),
            error: parseObjectOf(errorItemSchema, extras.error) as Message['error'] | undefined,
            seq: m.seq,
            createdAt: m.createdAt ?? Date.now(),
          })
        }
      })
      summary.skippedItems += skippedMessages
      summary.conversationsImported += 1
    } catch {
      summary.skippedItems += 1
    }
  }

  const existingPromptTitles = new Set(db.prompts.list().map((p) => p.title.toLowerCase()))
  for (const item of data.prompts ?? []) {
    const parsed = promptItemSchema.safeParse(item)
    if (!parsed.success || existingPromptTitles.has(parsed.data.title.toLowerCase())) {
      summary.skippedItems += 1
      continue
    }
    db.prompts.create({ title: parsed.data.title, body: parsed.data.body })
    existingPromptTitles.add(parsed.data.title.toLowerCase())
    summary.promptsImported += 1
  }

  const existingWorkflowNames = new Set(db.workflows.list().map((w) => w.name.toLowerCase()))
  for (const item of data.workflows ?? []) {
    const parsed = workflowItemSchema.safeParse(item)
    if (!parsed.success || existingWorkflowNames.has(parsed.data.name.toLowerCase())) {
      summary.skippedItems += 1
      continue
    }
    db.workflows.create({
      name: parsed.data.name,
      graph: parsed.data.graph as WorkflowGraph,
    })
    existingWorkflowNames.add(parsed.data.name.toLowerCase())
    summary.workflowsImported += 1
  }

  return summary
}
