/**
 * The activity log (migration v34): every tool call the app made, with the
 * reason it was allowed to run.
 *
 * Two decisions shape this table. It has NO foreign keys — an entry must
 * outlive the conversation, project or change it refers to, because a log that
 * deletes itself along with the evidence is not a log. And it is capped: the
 * newest MAX_ENTRIES rows are kept and older ones pruned on insert, so an
 * append-only audit trail cannot grow into a performance problem on a
 * long-lived local database.
 *
 * Redaction and truncation happen at the CALL SITE (tools/executor.ts) rather
 * than here, so nothing secret-looking is ever handed to the driver.
 */

import { randomUUID } from 'node:crypto'
import type { ActivityEntry, ActivityQuery } from '@shared/types'
import type { SqliteDriver } from '../driver'

/** Entries retained. Older ones are pruned as new ones land. */
const MAX_ENTRIES = 5000
/** Default page size for the Activity view. */
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

export type ActivityEntryInput = Omit<ActivityEntry, 'id'>

export interface ActivityRepository {
  record(input: ActivityEntryInput): ActivityEntry
  /** Newest first, filtered and paged. */
  list(query?: ActivityQuery): ActivityEntry[]
  /** Total rows retained (for "showing N of M"). */
  count(): number
  deleteAll(): void
}

interface ActivityRow {
  id: string
  at: number
  conversation_id: string | null
  agent_name: string | null
  tool_id: string
  tool_name: string
  risk: ActivityEntry['risk']
  decision: ActivityEntry['decision']
  detail: string
  arguments: string
  result: string
  change_id: string | null
}

function toEntry(row: ActivityRow): ActivityEntry {
  return {
    id: row.id,
    at: row.at,
    conversationId: row.conversation_id,
    agentName: row.agent_name,
    toolId: row.tool_id,
    toolName: row.tool_name,
    risk: row.risk,
    decision: row.decision,
    detail: row.detail,
    arguments: row.arguments,
    result: row.result,
    changeId: row.change_id,
  }
}

export function createActivityRepository(driver: SqliteDriver): ActivityRepository {
  return {
    record(input) {
      const entry: ActivityEntry = { id: randomUUID(), ...input }
      driver.run(
        `INSERT INTO activity_log
           (id, at, conversation_id, agent_name, tool_id, tool_name, risk,
            decision, detail, arguments, result, change_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.at,
          entry.conversationId,
          entry.agentName,
          entry.toolId,
          entry.toolName,
          entry.risk,
          entry.decision,
          entry.detail,
          entry.arguments,
          entry.result,
          entry.changeId,
        ]
      )
      // Prune by rowid, not by timestamp: two calls in the same millisecond
      // must still have a stable order to trim from.
      driver.run(
        `DELETE FROM activity_log WHERE rowid NOT IN (
           SELECT rowid FROM activity_log ORDER BY at DESC, rowid DESC LIMIT ?
         )`,
        [MAX_ENTRIES]
      )
      return entry
    },

    list(query = {}) {
      const clauses: string[] = []
      const params: Array<string | number> = []
      if (typeof query.before === 'number') {
        clauses.push('at < ?')
        params.push(query.before)
      }
      if (query.decision) {
        clauses.push('decision = ?')
        params.push(query.decision)
      }
      const search = query.search?.trim() ?? ''
      if (search.length > 0) {
        // ESCAPE is required for the escaping to mean anything: without it a
        // '%' typed in the search box would silently become a wildcard.
        clauses.push(
          "(tool_name LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\'" +
            " OR arguments LIKE ? ESCAPE '\\' OR result LIKE ? ESCAPE '\\')"
        )
        const like = `%${search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
        params.push(like, like, like, like)
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
      const limit = Math.min(Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)), MAX_LIMIT)
      params.push(limit)
      return driver
        .all<ActivityRow>(
          `SELECT * FROM activity_log ${where}
           ORDER BY at DESC, rowid DESC LIMIT ?`,
          params
        )
        .map(toEntry)
    },

    count() {
      const row = driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM activity_log')
      return row?.n ?? 0
    },

    deleteAll() {
      driver.run('DELETE FROM activity_log')
    },
  }
}
