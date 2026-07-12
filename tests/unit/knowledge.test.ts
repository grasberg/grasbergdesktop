/**
 * Knowledge bases (RAG): chunking, cosine ranking, BLOB round-trip through the
 * repository, and the OpenAI-compatible /embeddings adapter call.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import {
  KnowledgeService,
  chunkText,
  cosineSimilarity,
} from '../../src/main/services/knowledge'
import { OpenAICompatibleAdapter } from '../../src/main/providers/openai-compatible'
import { makeJsonResponse } from '../helpers/mock-fetch'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-knowledge-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('chunkText', () => {
  it('returns short text as one chunk and splits long text with overlap', () => {
    expect(chunkText('hello world')).toEqual(['hello world'])
    const paragraph = `${'a'.repeat(400)}.\n\n`
    const text = paragraph.repeat(10)
    const chunks = chunkText(text, 1000, 100)
    expect(chunks.length).toBeGreaterThan(2)
    // Every chunk respects the window size and none is empty.
    expect(chunks.every((c) => c.length > 0 && c.length <= 1000)).toBe(true)
  })

  it('empty input yields no chunks', () => {
    expect(chunkText('   \n  ')).toEqual([])
  })
})

describe('cosineSimilarity', () => {
  it('ranks identical direction above orthogonal', () => {
    const a = Float32Array.from([1, 0, 0])
    expect(cosineSimilarity(a, Float32Array.from([2, 0, 0]))).toBeCloseTo(1)
    expect(cosineSimilarity(a, Float32Array.from([0, 1, 0]))).toBeCloseTo(0)
  })
})

describe('KnowledgeService over the real db', () => {
  /** Deterministic fake embeddings: axis by keyword. */
  const embed = async (
    _providerId: string,
    _modelId: string,
    texts: string[]
  ): Promise<number[][]> =>
    texts.map((t) => {
      const lower = t.toLowerCase()
      return [
        lower.includes('cat') ? 1 : 0,
        lower.includes('dog') ? 1 : 0,
        lower.includes('bird') ? 1 : 0,
      ]
    })

  it('addDocument embeds chunks and search ranks by similarity', async () => {
    const kb = db.knowledge.create({ name: 'Pets', providerId: 'p1', modelId: 'embed-1' })
    const service = new KnowledgeService({ db, embed })

    await service.addDocument(kb.id, 'cats.md', 'Cats purr and nap.')
    await service.addDocument(kb.id, 'dogs.md', 'Dogs bark and fetch.')
    expect(db.knowledge.getById(kb.id)?.chunkCount).toBe(2)

    const hits = await service.search(kb.id, 'tell me about the cat')
    expect(hits[0].source).toBe('cats.md')
    expect(hits[0].score).toBeGreaterThan(hits[1]?.score ?? 0)
  })

  it('search throws instead of returning zero-score chunks when the query has no vector', async () => {
    const kb = db.knowledge.create({ name: 'Pets', providerId: 'p1', modelId: 'embed-1' })
    await new KnowledgeService({ db, embed }).addDocument(kb.id, 'cats.md', 'Cats purr.')

    const degraded = new KnowledgeService({ db, embed: async () => [] })
    await expect(degraded.search(kb.id, 'tell me about the cat')).rejects.toThrow(/no vector/i)
  })

  it('re-importing the same source replaces its chunks (no duplicates)', async () => {
    const kb = db.knowledge.create({ name: 'K', providerId: 'p1', modelId: 'e' })
    const service = new KnowledgeService({ db, embed })
    await service.addDocument(kb.id, 'doc.md', 'Dogs bark.')
    await service.addDocument(kb.id, 'doc.md', 'Dogs bark loudly.')
    expect(db.knowledge.getById(kb.id)?.chunkCount).toBe(1)
    expect(db.knowledge.listSources(kb.id)).toEqual([{ source: 'doc.md', chunks: 1 }])
  })

  it('deleting a base cascades its chunks', async () => {
    const kb = db.knowledge.create({ name: 'K', providerId: 'p1', modelId: 'e' })
    const service = new KnowledgeService({ db, embed })
    await service.addDocument(kb.id, 'doc.md', 'Birds sing.')
    db.knowledge.remove(kb.id)
    expect(db.knowledge.list()).toEqual([])
  })

  it('replaceSourceChunks is atomic: a mid-write failure keeps the old chunks', () => {
    const kb = db.knowledge.create({ name: 'K', providerId: 'p1', modelId: 'e' })
    const emb = (): Float32Array => Float32Array.from([1, 2, 3])
    db.knowledge.insertChunks(kb.id, [
      { source: 'doc', seq: 0, content: 'OLD-0', embedding: emb() },
      { source: 'doc', seq: 1, content: 'OLD-1', embedding: emb() },
    ])
    expect(db.knowledge.listChunks(kb.id)).toHaveLength(2)

    // The second chunk has a broken embedding (no .buffer), so writeChunks
    // throws AFTER the delete and the first insert have run inside the
    // transaction — the whole swap must roll back.
    const bad = [
      { source: 'doc', seq: 0, content: 'NEW-0', embedding: emb() },
      { source: 'doc', seq: 1, content: 'NEW-1', embedding: undefined as unknown as Float32Array },
    ]
    expect(() => db.knowledge.replaceSourceChunks(kb.id, 'doc', bad)).toThrow()

    // Rolled back: original chunks intact, no NEW-* partially written.
    expect(
      db.knowledge
        .listChunks(kb.id)
        .map((c) => c.content)
        .sort()
    ).toEqual(['OLD-0', 'OLD-1'])
  })
})

describe('OpenAI-compatible /embeddings', () => {
  it('posts model + input and returns vectors in input order', async () => {
    let requestedUrl = ''
    let requestBody: unknown
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url)
      requestBody = JSON.parse(String(init?.body))
      // Deliberately reordered — the adapter must restore input order by index.
      return makeJsonResponse(200, {
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      })
    }) as unknown as typeof fetch

    const adapter = new OpenAICompatibleAdapter()
    const vectors = await adapter.embed(
      { modelId: 'text-embedding-3-small', input: ['first', 'second'] },
      { apiKey: 'k', baseUrl: 'https://api.example/v1', fetchImpl }
    )
    expect(requestedUrl).toBe('https://api.example/v1/embeddings')
    expect(requestBody).toEqual({ model: 'text-embedding-3-small', input: ['first', 'second'] })
    expect(vectors).toEqual([
      [1, 0],
      [0, 1],
    ])
  })
})
