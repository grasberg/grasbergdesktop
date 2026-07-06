/**
 * Knowledge-base storage (migration v22): bases + their embedded text chunks.
 * Embeddings are stored as raw Float32Array bytes in a BLOB column; similarity
 * search happens in JS (src/main/services/knowledge.ts) — fine at local scale.
 */

import { randomUUID } from 'node:crypto'
import type { KnowledgeBase, KnowledgeBaseInput } from '@shared/types'
import type { SqliteDriver } from '../driver'

export interface KnowledgeChunkInput {
  source: string
  seq: number
  content: string
  embedding: Float32Array
}

export interface StoredChunk {
  source: string
  content: string
  embedding: Float32Array
}

export interface KnowledgeRepository {
  list(): KnowledgeBase[]
  getById(id: string): KnowledgeBase | null
  create(input: KnowledgeBaseInput): KnowledgeBase
  remove(id: string): void
  insertChunks(kbId: string, chunks: KnowledgeChunkInput[]): void
  listChunks(kbId: string): StoredChunk[]
  /** Distinct source names with their chunk counts. */
  listSources(kbId: string): Array<{ source: string; chunks: number }>
  removeSource(kbId: string, source: string): number
}

interface BaseRow {
  id: string
  name: string
  provider_id: string
  model_id: string
  chunk_count: number
  created_at: number
  updated_at: number
}

interface ChunkRow {
  source: string
  content: string
  embedding: Uint8Array
}

function toBase(row: BaseRow): KnowledgeBase {
  return {
    id: row.id,
    name: row.name,
    providerId: row.provider_id,
    modelId: row.model_id,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Reinterprets BLOB bytes as floats (copy-aligned — BLOBs may be unaligned). */
function toFloat32(bytes: Uint8Array): Float32Array {
  const copy = new Uint8Array(bytes)
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4))
}

const BASE_SELECT = `SELECT kb.*, (
    SELECT COUNT(*) FROM knowledge_chunks c WHERE c.kb_id = kb.id
  ) AS chunk_count FROM knowledge_bases kb`

export function createKnowledgeRepository(driver: SqliteDriver): KnowledgeRepository {
  const getById = (id: string): KnowledgeBase | null => {
    const row = driver.get<BaseRow>(`${BASE_SELECT} WHERE kb.id = ?`, [id])
    return row ? toBase(row) : null
  }

  return {
    list() {
      return driver.all<BaseRow>(`${BASE_SELECT} ORDER BY kb.name COLLATE NOCASE`).map(toBase)
    },

    getById,

    create(input) {
      const now = Date.now()
      const id = randomUUID()
      driver.run(
        `INSERT INTO knowledge_bases (id, name, provider_id, model_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, input.name, input.providerId, input.modelId, now, now]
      )
      return getById(id)!
    },

    remove(id) {
      driver.run('DELETE FROM knowledge_bases WHERE id = ?', [id])
    },

    insertChunks(kbId, chunks) {
      const now = Date.now()
      for (const chunk of chunks) {
        driver.run(
          `INSERT INTO knowledge_chunks (id, kb_id, source, seq, content, embedding, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            kbId,
            chunk.source,
            chunk.seq,
            chunk.content,
            new Uint8Array(chunk.embedding.buffer.slice(0)),
            now,
          ]
        )
      }
      driver.run('UPDATE knowledge_bases SET updated_at = ? WHERE id = ?', [now, kbId])
    },

    listChunks(kbId) {
      return driver
        .all<ChunkRow>(
          'SELECT source, content, embedding FROM knowledge_chunks WHERE kb_id = ? ORDER BY source, seq',
          [kbId]
        )
        .map((row) => ({
          source: row.source,
          content: row.content,
          embedding: toFloat32(row.embedding),
        }))
    },

    listSources(kbId) {
      return driver.all<{ source: string; chunks: number }>(
        `SELECT source, COUNT(*) AS chunks FROM knowledge_chunks
         WHERE kb_id = ? GROUP BY source ORDER BY source`,
        [kbId]
      )
    },

    removeSource(kbId, source) {
      const result = driver.run(
        'DELETE FROM knowledge_chunks WHERE kb_id = ? AND source = ?',
        [kbId, source]
      )
      return result.changes
    },
  }
}
