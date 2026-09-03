/**
 * Bot channel bindings (migration v47): one external Telegram bot per agent
 * profile. Only routing state lives here — the bot token is safeStorage
 * ciphertext in tool_secrets (scope 'im_bridge', owner 'bot:<agentId>') and
 * never touches this table. allowed_chat_id is the paired DM chat; Telegram
 * private-chat ids equal the user id, which is what lets owner-only group
 * commands (/allowgroup, /activation) verify the sender.
 */

import type { BotBindingGroup } from '@shared/types'
import type { SqliteDriver } from '../driver'

export interface BotBindingRecord {
  agentId: string
  channel: 'telegram'
  enabled: boolean
  allowedChatId: number | null
  pairingCode: string | null
  pairingExpiresAt: number | null
  pairingAttempts: number
  groups: BotBindingGroup[]
  createdAt: number
  updatedAt: number
}

export interface BotBindingsRepository {
  list(): BotBindingRecord[]
  getByAgent(agentId: string): BotBindingRecord | null
  /** Creates the binding row if missing; returns the current record. */
  ensure(agentId: string): BotBindingRecord
  setEnabled(agentId: string, enabled: boolean): void
  /** Arms a fresh one-time pairing code (also clears any previous pairing). */
  setPairing(agentId: string, code: string, expiresAt: number): void
  bumpPairingAttempts(agentId: string): number
  /** Pins the paired DM chat and clears the pairing code. */
  setPaired(agentId: string, chatId: number): void
  /** Unpairs (keeps groups; they are inert without a paired owner). */
  clearPaired(agentId: string): void
  setGroups(agentId: string, groups: BotBindingGroup[]): void
  remove(agentId: string): void
}

interface BindingRow {
  agent_id: string
  channel: string
  enabled: number
  allowed_chat_id: number | null
  pairing_code: string | null
  pairing_expires_at: number | null
  pairing_attempts: number
  groups_json: string | null
  created_at: number
  updated_at: number
}

function parseGroups(json: string | null): BotBindingGroup[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is BotBindingGroup =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as BotBindingGroup).id === 'string'
    )
  } catch {
    return []
  }
}

function toRecord(row: BindingRow): BotBindingRecord {
  return {
    agentId: row.agent_id,
    channel: 'telegram',
    enabled: row.enabled === 1,
    allowedChatId: row.allowed_chat_id,
    pairingCode: row.pairing_code,
    pairingExpiresAt: row.pairing_expires_at,
    pairingAttempts: row.pairing_attempts,
    groups: parseGroups(row.groups_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createBotBindingsRepository(driver: SqliteDriver): BotBindingsRepository {
  const getByAgent = (agentId: string): BotBindingRecord | null => {
    const row = driver.get<BindingRow>('SELECT * FROM bot_bindings WHERE agent_id = ?', [agentId])
    return row ? toRecord(row) : null
  }

  const touch = (agentId: string): void => {
    driver.run('UPDATE bot_bindings SET updated_at = ? WHERE agent_id = ?', [Date.now(), agentId])
  }

  return {
    list() {
      return driver.all<BindingRow>('SELECT * FROM bot_bindings').map(toRecord)
    },

    getByAgent,

    ensure(agentId) {
      const existing = getByAgent(agentId)
      if (existing) return existing
      const now = Date.now()
      driver.run(
        `INSERT INTO bot_bindings (agent_id, channel, enabled, created_at, updated_at)
         VALUES (?, 'telegram', 1, ?, ?)`,
        [agentId, now, now]
      )
      return getByAgent(agentId) as BotBindingRecord
    },

    setEnabled(agentId, enabled) {
      driver.run('UPDATE bot_bindings SET enabled = ?, updated_at = ? WHERE agent_id = ?', [
        enabled ? 1 : 0,
        Date.now(),
        agentId,
      ])
    },

    setPairing(agentId, code, expiresAt) {
      driver.run(
        `UPDATE bot_bindings
            SET allowed_chat_id = NULL, pairing_code = ?, pairing_expires_at = ?,
                pairing_attempts = 0, updated_at = ?
          WHERE agent_id = ?`,
        [code, expiresAt, Date.now(), agentId]
      )
    },

    bumpPairingAttempts(agentId) {
      driver.run(
        'UPDATE bot_bindings SET pairing_attempts = pairing_attempts + 1 WHERE agent_id = ?',
        [agentId]
      )
      return getByAgent(agentId)?.pairingAttempts ?? 0
    },

    setPaired(agentId, chatId) {
      driver.run(
        `UPDATE bot_bindings
            SET allowed_chat_id = ?, pairing_code = NULL, pairing_expires_at = NULL,
                pairing_attempts = 0, updated_at = ?
          WHERE agent_id = ?`,
        [chatId, Date.now(), agentId]
      )
    },

    clearPaired(agentId) {
      driver.run(
        `UPDATE bot_bindings
            SET allowed_chat_id = NULL, pairing_code = NULL, pairing_expires_at = NULL,
                pairing_attempts = 0, updated_at = ?
          WHERE agent_id = ?`,
        [Date.now(), agentId]
      )
    },

    setGroups(agentId, groups) {
      driver.run('UPDATE bot_bindings SET groups_json = ? WHERE agent_id = ?', [
        JSON.stringify(groups),
        agentId,
      ])
      touch(agentId)
    },

    remove(agentId) {
      driver.run('DELETE FROM bot_bindings WHERE agent_id = ?', [agentId])
    },
  }
}
