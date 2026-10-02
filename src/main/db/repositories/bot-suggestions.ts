/**
 * Bot suggestions (migration v53): actions a bot proposed instead of taking —
 * the output of proactive read-only work (dots/Muse "suggestions you did not
 * ask for"). Open rows are the user's to accept or dismiss; decided rows stay
 * as history and are pruned with the bot.
 */

import { randomUUID } from 'node:crypto'
import type { BotSuggestion, BotSuggestionKind, BotSuggestionStatus } from '@shared/types'
import type { SqliteDriver } from '../driver'

/** Open suggestions per bot are capped so a looping heartbeat cannot flood the inbox. */
export const MAX_OPEN_SUGGESTIONS_PER_BOT = 20

export interface BotSuggestionsRepository {
  create(input: {
    agentId: string | null
    kind?: BotSuggestionKind
    conversationId: string | null
    title: string
    action: string
    reason?: string
  }): BotSuggestion
  getById(id: string): BotSuggestion | null
  /** Newest first. `status` filters; omitted = every status. */
  listForAgent(agentId: string, status?: BotSuggestionStatus, limit?: number): BotSuggestion[]
  /** Every open suggestion across bots, newest first (Home inbox). */
  listOpen(limit?: number): BotSuggestion[]
  countOpen(agentId: string): number
  /** Every open row, bots and ordinary conversations alike (the badge count). */
  countAllOpen(): number
  /** An open suggestion with the same title already exists for the bot. */
  findOpenByTitle(agentId: string, title: string): BotSuggestion | null
  /** open → accepted | dismissed. False when the row was not open. */
  decide(id: string, status: 'accepted' | 'dismissed'): boolean
  removeForAgent(agentId: string): void
}

interface Row {
  id: string
  agent_id: string | null
  kind: string
  conversation_id: string | null
  title: string
  action: string
  reason: string
  status: string
  created_at: number
  decided_at: number | null
}

function toSuggestion(row: Row): BotSuggestion {
  const status: BotSuggestionStatus =
    row.status === 'accepted' || row.status === 'dismissed' ? row.status : 'open'
  return {
    id: row.id,
    agentId: row.agent_id,
    kind: row.kind === 'handoff' ? 'handoff' : 'suggestion',
    conversationId: row.conversation_id,
    title: row.title,
    action: row.action,
    reason: row.reason,
    status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  }
}

export function createBotSuggestionsRepository(driver: SqliteDriver): BotSuggestionsRepository {
  const getById = (id: string): BotSuggestion | null => {
    const row = driver.get<Row>('SELECT * FROM bot_suggestions WHERE id = ?', [id])
    return row ? toSuggestion(row) : null
  }
  return {
    create(input) {
      const suggestion: BotSuggestion = {
        id: randomUUID(),
        agentId: input.agentId,
        kind: input.kind ?? 'suggestion',
        conversationId: input.conversationId,
        title: input.title,
        action: input.action,
        reason: input.reason ?? '',
        status: 'open',
        createdAt: Date.now(),
        decidedAt: null,
      }
      driver.run(
        `INSERT INTO bot_suggestions
           (id, agent_id, kind, conversation_id, title, action, reason, status, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL)`,
        [
          suggestion.id,
          suggestion.agentId,
          suggestion.kind,
          suggestion.conversationId,
          suggestion.title,
          suggestion.action,
          suggestion.reason,
          suggestion.createdAt,
        ]
      )
      return suggestion
    },
    getById,
    listForAgent(agentId, status, limit = 50) {
      const rows = status
        ? driver.all<Row>(
            'SELECT * FROM bot_suggestions WHERE agent_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?',
            [agentId, status, limit]
          )
        : driver.all<Row>(
            'SELECT * FROM bot_suggestions WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?',
            [agentId, limit]
          )
      return rows.map(toSuggestion)
    },
    listOpen(limit = 100) {
      return driver
        .all<Row>(
          "SELECT * FROM bot_suggestions WHERE status = 'open' ORDER BY created_at DESC LIMIT ?",
          [limit]
        )
        .map(toSuggestion)
    },
    countOpen(agentId) {
      return (
        driver.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM bot_suggestions WHERE agent_id = ? AND status = 'open'",
          [agentId]
        )?.n ?? 0
      )
    },
    countAllOpen() {
      return (
        driver.get<{ n: number }>("SELECT COUNT(*) AS n FROM bot_suggestions WHERE status = 'open'")
          ?.n ?? 0
      )
    },
    findOpenByTitle(agentId, title) {
      const row = driver.get<Row>(
        "SELECT * FROM bot_suggestions WHERE agent_id = ? AND status = 'open' AND title = ? COLLATE NOCASE",
        [agentId, title]
      )
      return row ? toSuggestion(row) : null
    },
    decide(id, status) {
      const current = getById(id)
      if (!current || current.status !== 'open') return false
      driver.run('UPDATE bot_suggestions SET status = ?, decided_at = ? WHERE id = ?', [
        status,
        Date.now(),
        id,
      ])
      return true
    },
    removeForAgent(agentId) {
      driver.run('DELETE FROM bot_suggestions WHERE agent_id = ?', [agentId])
    },
  }
}
