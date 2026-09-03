/**
 * Assistant memories (migration v14, table `memories`): durable facts the
 * assistant persists across conversations via ```uld-memory blocks (parsed in
 * services/mode-artifacts.ts, saved by the memory completion hook). Users
 * review, edit and delete them in Settings → Memory.
 *
 * Since v32 a memory has an OWNER: `agentId` null means shared (every ordinary
 * conversation sees it), a non-null one means the memory belongs to that agent
 * profile. Two scopes, deliberately different:
 * - WRITE / consolidation scope (`listForAgent`, `upsertByTitle`,
 *   `removeByTitle`, dreaming): exactly one owner. An agent only ever edits,
 *   forgets or consolidates its own memories.
 * - READ / prompt scope (`listVisibleTo`): a bot sees its own memories AND
 *   the user's shared pool (own first, titles deduped with the bot's winning)
 *   — never another bot's private recollection.
 * Titles are unique per owner, so two agents can each keep a "last-seen"
 * without overwriting one another — every title-keyed operation below is
 * therefore owner-scoped.
 */

import { randomUUID } from 'node:crypto'
import type { Memory, MemoryInput, MemoryPatch } from '@shared/types'
import type { SqliteDriver } from '../driver'
import { updateById } from './util'

export interface MemoriesRepository {
  /** EVERY memory regardless of owner, updated_at DESC (Settings → Memory). */
  list(): Memory[]
  /**
   * One owner's rows: the shared memories for `null`, or exactly that agent's
   * memories for an id. The write/consolidation scope — never shared+agent.
   */
  listForAgent(agentId: string | null): Memory[]
  /**
   * The prompt view for a run: the agent's own memories first, then the shared
   * pool, deduped by title (case-insensitive; the agent's entry wins). For
   * `null` = the shared pool alone. Never includes another agent's memories.
   */
  listVisibleTo(agentId: string | null): Memory[]
  /** Owners that currently hold memories (null = the shared pool). Dreaming iterates these. */
  listOwners(): Array<string | null>
  getById(id: string): Memory | null
  create(input: MemoryInput): Memory
  update(id: string, patch: MemoryPatch): Memory | null
  remove(id: string): void
  /**
   * Creates the memory, or — when one with the same title already exists
   * (compared case-insensitively) — replaces that memory's content and
   * provenance instead. This is what lets the assistant keep a memory current
   * by re-emitting a block under the same title.
   */
  upsertByTitle(input: MemoryInput): Memory
  /**
   * Case-insensitive delete by title WITHIN one owner; returns whether a row
   * was removed. An agent can only forget its own memories.
   */
  removeByTitle(title: string, agentId?: string | null): boolean
}

interface MemoryRow {
  id: string
  title: string
  content: string
  source_conversation_id: string | null
  agent_id: string | null
  created_at: number
  updated_at: number
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    sourceConversationId: row.source_conversation_id,
    agentId: row.agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createMemoriesRepository(driver: SqliteDriver): MemoriesRepository {
  const getById = (id: string): Memory | null => {
    const row = driver.get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [id])
    return row ? toMemory(row) : null
  }

  const create = (input: MemoryInput): Memory => {
    const now = Date.now()
    const memory: Memory = {
      id: randomUUID(),
      title: input.title,
      content: input.content,
      sourceConversationId: input.sourceConversationId ?? null,
      agentId: input.agentId ?? null,
      createdAt: now,
      updatedAt: now,
    }
    driver.run(
      `INSERT INTO memories
         (id, title, content, source_conversation_id, agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        memory.id,
        memory.title,
        memory.content,
        memory.sourceConversationId,
        memory.agentId,
        now,
        now,
      ]
    )
    return memory
  }

  // A null owner has to be compared with `IS NULL`, not `= ?` — the latter is
  // never true in SQL, which would silently give every shared memory its own
  // duplicate on upsert.
  const ownerClause = (agentId: string | null): string =>
    agentId === null ? 'agent_id IS NULL' : 'agent_id = ?'
  const ownerParams = (agentId: string | null): string[] => (agentId === null ? [] : [agentId])

  return {
    list() {
      const rows = driver.all<MemoryRow>('SELECT * FROM memories ORDER BY updated_at DESC')
      return rows.map(toMemory)
    },

    listForAgent(agentId) {
      const rows = driver.all<MemoryRow>(
        `SELECT * FROM memories WHERE ${ownerClause(agentId)} ORDER BY updated_at DESC`,
        ownerParams(agentId)
      )
      return rows.map(toMemory)
    },

    listVisibleTo(agentId) {
      if (agentId === null) {
        return driver
          .all<MemoryRow>('SELECT * FROM memories WHERE agent_id IS NULL ORDER BY updated_at DESC')
          .map(toMemory)
      }
      const rows = driver.all<MemoryRow>(
        `SELECT * FROM memories WHERE agent_id = ? OR agent_id IS NULL
          ORDER BY (agent_id IS NULL) ASC, updated_at DESC`,
        [agentId]
      )
      const seen = new Set<string>()
      const visible: Memory[] = []
      for (const row of rows) {
        const key = row.title.trim().toLowerCase()
        if (seen.has(key)) continue // the agent's own entry came first and wins
        seen.add(key)
        visible.push(toMemory(row))
      }
      return visible
    },

    listOwners() {
      return driver
        .all<{ agent_id: string | null }>(
          'SELECT DISTINCT agent_id FROM memories ORDER BY (agent_id IS NULL) DESC, agent_id'
        )
        .map((row) => row.agent_id)
    },

    getById,

    create,

    update(id, patch) {
      updateById(
        driver,
        'memories',
        id,
        { title: patch.title, content: patch.content },
        { touchUpdatedAt: true }
      )
      return getById(id)
    },

    remove(id) {
      driver.run('DELETE FROM memories WHERE id = ?', [id])
    },

    upsertByTitle(input) {
      const agentId = input.agentId ?? null
      const row = driver.get<MemoryRow>(
        `SELECT * FROM memories
         WHERE title = ? COLLATE NOCASE AND ${ownerClause(agentId)}
         ORDER BY created_at ASC LIMIT 1`,
        [input.title, ...ownerParams(agentId)]
      )
      if (!row) return create(input)
      driver.run(
        'UPDATE memories SET content = ?, source_conversation_id = ?, updated_at = ? WHERE id = ?',
        [input.content, input.sourceConversationId ?? null, Date.now(), row.id]
      )
      // The row exists, so getById cannot return null here.
      return getById(row.id) as Memory
    },

    removeByTitle(title, agentId = null) {
      const result = driver.run(
        `DELETE FROM memories WHERE title = ? COLLATE NOCASE AND ${ownerClause(agentId)}`,
        [title, ...ownerParams(agentId)]
      )
      return result.changes > 0
    },
  }
}
