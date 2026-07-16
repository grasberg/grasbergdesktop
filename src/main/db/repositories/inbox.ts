/**
 * inbox_state: which finished background results the user marked reviewed in
 * the Home inbox. Composite key (item_type, item_id); an unreviewed item has
 * no row. Sources (agent runs, workflow runs, scheduled-task runs) live in
 * their own tables — this table never cascades.
 */

import type { InboxItemType } from '@shared/types'
import type { SqliteDriver } from '../driver'

export interface InboxRepository {
  markReviewed(itemType: InboxItemType, itemId: string, at?: number): void
  /** reviewed_at per "type:id" key, for joining onto the aggregated feed. */
  reviewedByKey(): Map<string, number>
}

export function createInboxRepository(driver: SqliteDriver): InboxRepository {
  return {
    markReviewed(itemType, itemId, at = Date.now()) {
      driver.run(
        `INSERT INTO inbox_state (item_type, item_id, reviewed_at) VALUES (?, ?, ?)
           ON CONFLICT(item_type, item_id) DO UPDATE SET reviewed_at = excluded.reviewed_at`,
        [itemType, itemId, at]
      )
    },

    reviewedByKey() {
      const rows = driver.all<{ item_type: string; item_id: string; reviewed_at: number }>(
        'SELECT item_type, item_id, reviewed_at FROM inbox_state'
      )
      return new Map(rows.map((row) => [`${row.item_type}:${row.item_id}`, row.reviewed_at]))
    },
  }
}
