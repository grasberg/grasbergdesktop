/**
 * Assistant memories (migration v14, table `memories`): durable facts the
 * assistant persists across conversations via ```uld-memory blocks (parsed in
 * services/mode-artifacts.ts, saved by the memory completion hook). Users
 * review, edit and delete them in Settings → Memory.
 */

import { randomUUID } from 'node:crypto'
import type { Memory, MemoryInput, MemoryPatch } from '@shared/types'
import type { SqliteDriver } from '../driver'

export interface MemoriesRepository {
  /** Ordered by updated_at DESC (most recently touched first). */
  list(): Memory[]
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
  /** Case-insensitive delete by title; returns whether a row was removed. */
  removeByTitle(title: string): boolean
}

interface MemoryRow {
  id: string
  title: string
  content: string
  source_conversation_id: string | null
  created_at: number
  updated_at: number
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    sourceConversationId: row.source_conversation_id,
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
      createdAt: now,
      updatedAt: now,
    }
    driver.run(
      `INSERT INTO memories (id, title, content, source_conversation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [memory.id, memory.title, memory.content, memory.sourceConversationId, now, now]
    )
    return memory
  }

  return {
    list() {
      const rows = driver.all<MemoryRow>('SELECT * FROM memories ORDER BY updated_at DESC')
      return rows.map(toMemory)
    },

    getById,

    create,

    update(id, patch) {
      const sets: string[] = []
      const params: (string | number)[] = []
      if (patch.title !== undefined) {
        sets.push('title = ?')
        params.push(patch.title)
      }
      if (patch.content !== undefined) {
        sets.push('content = ?')
        params.push(patch.content)
      }
      if (sets.length > 0) {
        sets.push('updated_at = ?')
        params.push(Date.now(), id)
        driver.run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, params)
      }
      return getById(id)
    },

    remove(id) {
      driver.run('DELETE FROM memories WHERE id = ?', [id])
    },

    upsertByTitle(input) {
      const row = driver.get<MemoryRow>(
        `SELECT * FROM memories
         WHERE title = ? COLLATE NOCASE
         ORDER BY created_at ASC LIMIT 1`,
        [input.title]
      )
      if (!row) return create(input)
      driver.run(
        'UPDATE memories SET content = ?, source_conversation_id = ?, updated_at = ? WHERE id = ?',
        [input.content, input.sourceConversationId ?? null, Date.now(), row.id]
      )
      // The row exists, so getById cannot return null here.
      return getById(row.id) as Memory
    },

    removeByTitle(title) {
      const result = driver.run('DELETE FROM memories WHERE title = ? COLLATE NOCASE', [title])
      return result.changes > 0
    },
  }
}
