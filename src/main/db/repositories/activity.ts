/**
 * The activity log (migration v34): every tool call the app made, with the
 * reason it was allowed to run.
 *
 * Two decisions shape this table. It has NO foreign keys — an entry must
 * outlive the conversation, project or change it refers to, because a log that
 * deletes itself along with the evidence is not a log. And it is capped: the
 * newest MAX_ENTRIES rows are kept and older ones pruned as new ones land, so
 * an append-only audit trail cannot grow into a performance problem on a
 * long-lived local database. The prune itself is amortized (PRUNE_SLACK) —
 * writing here is on the tool-call path, i.e. inside a stream.
 *
 * Redaction and truncation happen at the CALL SITE (tools/executor.ts) rather
 * than here, so nothing secret-looking is ever handed to the driver.
 */

import { randomUUID } from 'node:crypto'
import type { ActivityCursor, ActivityEntry, ActivityQuery } from '@shared/types'
import type { SqliteDriver } from '../driver'
import { toSearchGlob } from './util'

/** Entries retained. Older ones are pruned as new ones land. */
export const MAX_ENTRIES = 5000
/**
 * Rows the table is allowed to run past MAX_ENTRIES before a prune. The prune
 * sorts every row to find the ones to drop — several times the cost of the
 * insert it follows — so it is paid once per slack rather than on every tool
 * call. The cap is therefore honest to within this many entries.
 */
export const PRUNE_SLACK = 200
/** Default page size for the Activity view. */
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

export type ActivityEntryInput = Omit<ActivityEntry, 'id'>

/** One page of the log, and where the page after it continues. */
export interface ActivityPage {
  entries: ActivityEntry[]
  /** Pass as `before` to get the next (older) page; null when this is the end. */
  cursor: ActivityCursor | null
}

export interface ActivityRepository {
  record(input: ActivityEntryInput): ActivityEntry
  /** Newest first, filtered and paged. */
  list(query?: ActivityQuery): ActivityPage
  /** Total rows retained (for "showing N of M"). */
  count(): number
  deleteAll(): void
}

interface ActivityRow {
  id: string
  /** The rowid, selected for paging only — never part of an entry. */
  seq: number
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
  const total = (): number =>
    driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM activity_log')?.n ?? 0

  // Rows stored, so the prune can be skipped without asking the database.
  // Read back from the table on first use rather than assumed to be zero: an
  // already-full log that survives a restart must still be pruned.
  let rowCount: number | null = null

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
      // Counted after the INSERT, so the row just written is included either way.
      rowCount = rowCount === null ? total() : rowCount + 1
      if (rowCount > MAX_ENTRIES + PRUNE_SLACK) {
        // Prune by rowid, not by timestamp: two calls in the same millisecond
        // must still have a stable order to trim from.
        driver.run(
          `DELETE FROM activity_log WHERE rowid NOT IN (
             SELECT rowid FROM activity_log ORDER BY at DESC, rowid DESC LIMIT ?
           )`,
          [MAX_ENTRIES]
        )
        rowCount = MAX_ENTRIES
      }
      return entry
    },

    list(query = {}) {
      const clauses: string[] = []
      const params: Array<string | number> = []
      if (query.before) {
        // Keyset paging on the same pair the ORDER BY sorts on. A plain
        // `at < ?` would drop every row sharing the boundary millisecond —
        // and drop it from every later page too, so the entries would be gone
        // from the log entirely while still counted in the total.
        clauses.push('(at < ? OR (at = ? AND rowid < ?))')
        params.push(query.before.at, query.before.at, query.before.seq)
      }
      if (query.decision) {
        clauses.push('decision = ?')
        params.push(query.decision)
      }
      const search = query.search?.trim() ?? ''
      if (search.length > 0) {
        // Same GLOB pattern the conversation search uses: neither LIKE nor
        // LOWER folds beyond ASCII in the bundled SQLite build, and a wildcard
        // typed in the search box must stay literal.
        const pattern = toSearchGlob(search)
        clauses.push('(tool_name GLOB ? OR detail GLOB ? OR arguments GLOB ? OR result GLOB ?)')
        params.push(pattern, pattern, pattern, pattern)
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
      const limit = Math.min(Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)), MAX_LIMIT)
      // One row beyond the page, so "is there an older page?" is answered by
      // the database rather than guessed from the page being full.
      params.push(limit + 1)
      const rows = driver.all<ActivityRow>(
        `SELECT *, rowid AS seq FROM activity_log ${where}
         ORDER BY at DESC, rowid DESC LIMIT ?`,
        params
      )
      const page = rows.slice(0, limit)
      const last = page[page.length - 1]
      return {
        entries: page.map(toEntry),
        cursor: rows.length > limit && last ? { at: last.at, seq: last.seq } : null,
      }
    },

    count() {
      rowCount = total()
      return rowCount
    },

    deleteAll() {
      driver.run('DELETE FROM activity_log')
      rowCount = 0
    },
  }
}
