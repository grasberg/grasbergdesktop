/**
 * Durable bot-to-bot outbox (migration v48): one row per `message_agent`
 * delivery. BotService pumps rows per target bot strictly FIFO and settles
 * them through the completion hook; at boot it recovers whatever the previous
 * process left open. Pure persistence here — no delivery logic.
 */

import type { A2aOutboxEntry, A2aOutboxStatus } from '@shared/types'
import type { SqliteDriver } from '../driver'

const OPEN_STATUSES = "('queued', 'delivered')"
const TERMINAL_STATUSES = "('replied', 'failed', 'cancelled')"

export interface A2aOutboxRepository {
  insert(input: {
    id: string
    fromAgentId: string | null
    toAgentId: string
    conversationId: string | null
    body: string
    hop: number
    groupId?: string | null
    handoffMessageId?: string | null
  }): A2aOutboxEntry
  getById(id: string): A2aOutboxEntry | null
  /** Oldest queued row for a target (FIFO by created_at, rowid). */
  nextQueued(toAgentId: string): A2aOutboxEntry | null
  countQueued(toAgentId: string): number
  /** The 'delivered' row whose turn is running in a target chat, if any. */
  inFlightFor(targetConversationId: string): A2aOutboxEntry | null
  /** Every queued + delivered row, oldest first (boot recovery, cleanup). */
  listOpen(filter?: { toAgentId?: string; fromAgentId?: string }): A2aOutboxEntry[]
  /** Distinct target agent ids that have queued rows. */
  queuedTargets(): string[]
  /** Recent rows touching a bot in either direction, newest first. */
  listForAgent(agentId: string, limit?: number): A2aOutboxEntry[]
  markDelivered(
    id: string,
    input: { targetConversationId: string; assistantMessageId: string }
  ): void
  /** Back to 'queued' (clears the target pointers); optionally counts an attempt. */
  requeue(id: string, opts?: { bumpAttempts?: boolean }): void
  bumpAttempts(id: string): number
  markReplied(id: string): void
  markFailed(id: string, error: string): void
  /** Sender-side cancellation on profile delete; returns the rows touched. */
  cancelForSender(fromAgentId: string): A2aOutboxEntry[]
  setHandoffMessage(id: string, messageId: string): void
  /** Housekeeping: deletes terminal rows last touched before `beforeMs`. */
  pruneTerminal(beforeMs: number): number
}

interface OutboxRow {
  id: string
  from_agent_id: string | null
  to_agent_id: string
  group_id: string | null
  conversation_id: string | null
  body: string
  status: string
  hop: number
  attempts: number
  target_conversation_id: string | null
  assistant_message_id: string | null
  handoff_message_id: string | null
  error: string | null
  created_at: number
  updated_at: number
  delivered_at: number | null
}

function toEntry(row: OutboxRow): A2aOutboxEntry {
  return {
    id: row.id,
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    groupId: row.group_id,
    conversationId: row.conversation_id,
    body: row.body,
    status: row.status as A2aOutboxStatus,
    hop: row.hop,
    attempts: row.attempts,
    targetConversationId: row.target_conversation_id,
    assistantMessageId: row.assistant_message_id,
    handoffMessageId: row.handoff_message_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
  }
}

export function createA2aOutboxRepository(driver: SqliteDriver): A2aOutboxRepository {
  const getById = (id: string): A2aOutboxEntry | null => {
    const row = driver.get<OutboxRow>('SELECT * FROM a2a_outbox WHERE id = ?', [id])
    return row ? toEntry(row) : null
  }

  return {
    insert(input) {
      const now = Date.now()
      driver.run(
        `INSERT INTO a2a_outbox
           (id, from_agent_id, to_agent_id, group_id, conversation_id, body, status, hop,
            attempts, handoff_message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?)`,
        [
          input.id,
          input.fromAgentId,
          input.toAgentId,
          input.groupId ?? null,
          input.conversationId,
          input.body,
          input.hop,
          input.handoffMessageId ?? null,
          now,
          now,
        ]
      )
      return getById(input.id) as A2aOutboxEntry
    },

    getById,

    nextQueued(toAgentId) {
      const row = driver.get<OutboxRow>(
        `SELECT * FROM a2a_outbox WHERE to_agent_id = ? AND status = 'queued'
          ORDER BY created_at ASC, rowid ASC LIMIT 1`,
        [toAgentId]
      )
      return row ? toEntry(row) : null
    },

    countQueued(toAgentId) {
      const row = driver.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM a2a_outbox WHERE to_agent_id = ? AND status = 'queued'`,
        [toAgentId]
      )
      return row?.n ?? 0
    },

    inFlightFor(targetConversationId) {
      const row = driver.get<OutboxRow>(
        `SELECT * FROM a2a_outbox WHERE target_conversation_id = ? AND status = 'delivered'
          ORDER BY delivered_at DESC, rowid DESC LIMIT 1`,
        [targetConversationId]
      )
      return row ? toEntry(row) : null
    },

    listOpen(filter) {
      const where = [`status IN ${OPEN_STATUSES}`]
      const params: string[] = []
      if (filter?.toAgentId) {
        where.push('to_agent_id = ?')
        params.push(filter.toAgentId)
      }
      if (filter?.fromAgentId) {
        where.push('from_agent_id = ?')
        params.push(filter.fromAgentId)
      }
      return driver
        .all<OutboxRow>(
          `SELECT * FROM a2a_outbox WHERE ${where.join(' AND ')}
            ORDER BY created_at ASC, rowid ASC`,
          params
        )
        .map(toEntry)
    },

    queuedTargets() {
      return driver
        .all<{ to_agent_id: string }>(
          `SELECT DISTINCT to_agent_id FROM a2a_outbox WHERE status = 'queued'`
        )
        .map((row) => row.to_agent_id)
    },

    listForAgent(agentId, limit = 50) {
      return driver
        .all<OutboxRow>(
          `SELECT * FROM a2a_outbox WHERE to_agent_id = ? OR from_agent_id = ?
            ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          [agentId, agentId, limit]
        )
        .map(toEntry)
    },

    markDelivered(id, input) {
      const now = Date.now()
      driver.run(
        `UPDATE a2a_outbox
            SET status = 'delivered', target_conversation_id = ?, assistant_message_id = ?,
                attempts = attempts + 1, delivered_at = ?, updated_at = ?
          WHERE id = ?`,
        [input.targetConversationId, input.assistantMessageId, now, now, id]
      )
    },

    requeue(id, opts) {
      driver.run(
        `UPDATE a2a_outbox
            SET status = 'queued', target_conversation_id = NULL, assistant_message_id = NULL,
                delivered_at = NULL, attempts = attempts + ?, updated_at = ?
          WHERE id = ?`,
        [opts?.bumpAttempts ? 1 : 0, Date.now(), id]
      )
    },

    bumpAttempts(id) {
      driver.run('UPDATE a2a_outbox SET attempts = attempts + 1, updated_at = ? WHERE id = ?', [
        Date.now(),
        id,
      ])
      return getById(id)?.attempts ?? 0
    },

    markReplied(id) {
      driver.run(`UPDATE a2a_outbox SET status = 'replied', updated_at = ? WHERE id = ?`, [
        Date.now(),
        id,
      ])
    },

    markFailed(id, error) {
      driver.run(
        `UPDATE a2a_outbox SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
        [error.slice(0, 2000), Date.now(), id]
      )
    },

    cancelForSender(fromAgentId) {
      const rows = driver
        .all<OutboxRow>(
          `SELECT * FROM a2a_outbox WHERE from_agent_id = ? AND status IN ${OPEN_STATUSES}`,
          [fromAgentId]
        )
        .map(toEntry)
      if (rows.length === 0) return rows
      driver.run(
        `UPDATE a2a_outbox SET status = 'cancelled', updated_at = ?
          WHERE from_agent_id = ? AND status IN ${OPEN_STATUSES}`,
        [Date.now(), fromAgentId]
      )
      return rows
    },

    setHandoffMessage(id, messageId) {
      driver.run('UPDATE a2a_outbox SET handoff_message_id = ? WHERE id = ?', [messageId, id])
    },

    pruneTerminal(beforeMs) {
      const result = driver.run(
        `DELETE FROM a2a_outbox WHERE status IN ${TERMINAL_STATUSES} AND updated_at < ?`,
        [beforeMs]
      )
      return result.changes
    },
  }
}
