/**
 * Private spaces: named partitions of the conversation list, each optionally
 * restricted to a provider allowlist. NULL conversations.space_id = the
 * default space; membership is stamped at conversation creation and never
 * moves in v1.
 */

import { randomUUID } from 'node:crypto'
import type { Space } from '@shared/types'
import type { SqliteDriver } from '../driver'
import { parseJson } from './util'

export interface SpaceCreateInput {
  name: string
  /** Preserve this id instead of generating one — backup import only. */
  id?: string
  providerAllowlist?: string[] | null
}

export interface SpacesRepository {
  list(): Space[]
  getById(id: string): Space | null
  create(input: SpaceCreateInput): Space
  /** Returns the updated row, or null when id is unknown. */
  update(id: string, patch: { name?: string; providerAllowlist?: string[] | null }): Space | null
  remove(id: string): void
  /** Conversations currently in this space (delete is refused while > 0). */
  countConversations(id: string): number
  /**
   * Removes a deleted provider's id from every space allowlist, collapsing a
   * now-empty list to NULL (= all providers) rather than leaving a space that
   * can never generate.
   */
  removeProviderFromAllowlists(providerId: string): void
}

interface SpaceRow {
  id: string
  name: string
  provider_allowlist_json: string | null
  created_at: number
}

function toAllowlist(text: string | null): string[] | null {
  const parsed = parseJson<string[]>(text, [], (value): value is string[] =>
    Array.isArray(value) && value.every((v) => typeof v === 'string')
  )
  return parsed.length > 0 ? parsed : null
}

function toSpace(row: SpaceRow): Space {
  return {
    id: row.id,
    name: row.name,
    providerAllowlist: toAllowlist(row.provider_allowlist_json),
    createdAt: row.created_at,
  }
}

export function createSpacesRepository(driver: SqliteDriver): SpacesRepository {
  const getById = (id: string): Space | null => {
    const row = driver.get<SpaceRow>('SELECT * FROM spaces WHERE id = ?', [id])
    return row ? toSpace(row) : null
  }

  const encodeAllowlist = (allowlist: string[] | null | undefined): string | null =>
    allowlist && allowlist.length > 0 ? JSON.stringify(allowlist) : null

  return {
    list() {
      const rows = driver.all<SpaceRow>('SELECT * FROM spaces ORDER BY created_at ASC')
      return rows.map(toSpace)
    },

    getById,

    create(input) {
      const space: Space = {
        id: input.id ?? randomUUID(),
        name: input.name,
        providerAllowlist:
          input.providerAllowlist && input.providerAllowlist.length > 0
            ? input.providerAllowlist
            : null,
        createdAt: Date.now(),
      }
      driver.run(
        `INSERT INTO spaces (id, name, provider_allowlist_json, created_at)
         VALUES (?, ?, ?, ?)`,
        [space.id, space.name, encodeAllowlist(space.providerAllowlist), space.createdAt]
      )
      return space
    },

    update(id, patch) {
      if (patch.name !== undefined) {
        driver.run('UPDATE spaces SET name = ? WHERE id = ?', [patch.name, id])
      }
      if (patch.providerAllowlist !== undefined) {
        driver.run('UPDATE spaces SET provider_allowlist_json = ? WHERE id = ?', [
          encodeAllowlist(patch.providerAllowlist),
          id,
        ])
      }
      return getById(id)
    },

    remove(id) {
      driver.run('DELETE FROM spaces WHERE id = ?', [id])
    },

    countConversations(id) {
      const row = driver.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM conversations WHERE space_id = ?',
        [id]
      )
      return row?.n ?? 0
    },

    removeProviderFromAllowlists(providerId) {
      const rows = driver.all<SpaceRow>(
        'SELECT * FROM spaces WHERE provider_allowlist_json IS NOT NULL'
      )
      for (const row of rows) {
        const allowlist = toAllowlist(row.provider_allowlist_json)
        if (!allowlist || !allowlist.includes(providerId)) continue
        const filtered = allowlist.filter((pid) => pid !== providerId)
        driver.run('UPDATE spaces SET provider_allowlist_json = ? WHERE id = ?', [
          encodeAllowlist(filtered),
          row.id,
        ])
      }
    },
  }
}
