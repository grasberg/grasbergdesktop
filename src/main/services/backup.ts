/**
 * Backup export/import of user data: settings, memories and skills, as one
 * portable JSON file. API keys, OAuth tokens and other secrets are NEVER part
 * of a backup — they stay in the OS keystore-encrypted provider storage.
 *
 * Import is tolerant: the envelope (format marker) must match, but individual
 * settings keys and memory/skill entries that fail validation are skipped and
 * counted rather than failing the whole import. Memories upsert by title and
 * skills by name, so re-importing the same backup never duplicates data.
 */

import { z } from 'zod'
import { DEFAULT_SETTINGS, type BackupSummary } from '@shared/types'
import { settingsPatchSchema } from '@shared/schemas'
import type { AppDatabase } from '../db/database'

export const BACKUP_FORMAT = 'grasberg-desktop-backup'
export const BACKUP_VERSION = 1

export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: number
  exportedAt: number
  settings: Record<string, unknown>
  memories: { title: string; content: string }[]
  skills: {
    name: string
    description: string
    content: string
    pluginName: string | null
    sourcePath: string | null
    enabled: boolean
  }[]
}

/** Collects the current settings, memories and skills into a backup object. */
export function buildBackup(db: AppDatabase): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    settings: { ...db.settings.get() },
    memories: db.memories.list().map((m) => ({ title: m.title, content: m.content })),
    skills: db.skills.list().map((s) => ({
      name: s.name,
      description: s.description,
      content: s.content,
      pluginName: s.pluginName,
      sourcePath: s.sourcePath,
      enabled: s.enabled,
    })),
  }
}

// -- import validation ----------------------------------------------------------

/** Envelope: only the format marker is strict; sections are optional. */
const envelopeSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    version: z.number().int().min(1),
    settings: z.record(z.unknown()).optional(),
    memories: z.array(z.unknown()).max(100_000).optional(),
    skills: z.array(z.unknown()).max(100_000).optional(),
  })
  .passthrough()

const memoryItemSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    content: z.string().max(10_000),
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

/**
 * Settings that are NEVER applied from an imported backup: enabling them from
 * an untrusted file would silently grant shell/browser execution, wire up an
 * exfiltration webhook, or pre-authorize a Telegram sender — all behind a
 * single "Import" click. They stay whatever the local machine already has.
 */
const IMPORT_EXCLUDED_SETTING_KEYS: ReadonlySet<string> = new Set([
  'shellExecutionEnabled',
  'browserToolsEnabled',
  'outboundWebhookUrl',
  'telegramBridgeEnabled',
  'telegramBridgeConversationId',
  'telegramBridgeAllowedChatId',
])

/**
 * Applies a parsed backup file to the database. Throws only when `raw` is not
 * a Grasberg backup at all; individually invalid entries are skipped.
 */
export function applyBackup(db: AppDatabase, raw: unknown): BackupSummary {
  const envelope = envelopeSchema.safeParse(raw)
  if (!envelope.success) {
    throw new Error('Not a Grasberg Desktop backup file.')
  }
  const data = envelope.data
  const summary: BackupSummary = {
    settingsApplied: 0,
    memoriesImported: 0,
    skillsImported: 0,
    skippedItems: 0,
  }

  // Settings: validate key by key so one bad value never blocks the rest.
  // Security-sensitive keys are never taken from a backup (see the set above).
  if (data.settings) {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (!(key in data.settings)) continue
      if (IMPORT_EXCLUDED_SETTING_KEYS.has(key)) continue
      const single = settingsPatchSchema.safeParse({ [key]: data.settings[key] })
      if (!single.success) continue
      db.settings.update(single.data)
      summary.settingsApplied += 1
    }
  }

  for (const item of data.memories ?? []) {
    const parsed = memoryItemSchema.safeParse(item)
    if (!parsed.success) {
      summary.skippedItems += 1
      continue
    }
    db.memories.upsertByTitle({ title: parsed.data.title, content: parsed.data.content })
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

  return summary
}
