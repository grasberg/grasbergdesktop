/**
 * Knowledge-base service (RAG): chunking, embedding (via the provider layer's
 * /embeddings), and cosine-similarity retrieval over the chunks stored in
 * SQLite. Pure helpers (chunkText, cosineSimilarity) are exported for tests.
 */

import type { KnowledgeSearchHit } from '@shared/types'
import type { AppDatabase } from '../db/database'

/** ~4 chars/token puts a chunk near 400 tokens — a good retrieval granularity. */
const CHUNK_SIZE_CHARS = 1600
const CHUNK_OVERLAP_CHARS = 200
/** Texts embedded per /embeddings request. */
const EMBED_BATCH_SIZE = 32
/** Hard cap on chunks per document (guards accidental giant imports). */
const MAX_CHUNKS_PER_DOCUMENT = 2000

export interface KnowledgeServiceDeps {
  db: AppDatabase
  /** Embeds texts with the given provider/model (one vector per text). */
  embed: (providerId: string, modelId: string, texts: string[]) => Promise<number[][]>
}

/**
 * Splits text into overlapping chunks, preferring paragraph/sentence/line
 * boundaries in the back half of each window so chunks stay coherent.
 */
export function chunkText(
  text: string,
  chunkSize = CHUNK_SIZE_CHARS,
  overlap = CHUNK_OVERLAP_CHARS
): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (clean.length === 0) return []
  if (clean.length <= chunkSize) return [clean]
  const chunks: string[] = []
  let start = 0
  while (start < clean.length && chunks.length < MAX_CHUNKS_PER_DOCUMENT) {
    let end = Math.min(start + chunkSize, clean.length)
    if (end < clean.length) {
      const window = clean.slice(start, end)
      const breakAt = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('. '),
        window.lastIndexOf('\n')
      )
      if (breakAt > chunkSize * 0.5) end = start + breakAt + 1
    }
    const chunk = clean.slice(start, end).trim()
    if (chunk.length > 0) chunks.push(chunk)
    if (end >= clean.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return chunks
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom > 0 ? dot / denom : 0
}

export class KnowledgeService {
  constructor(private readonly deps: KnowledgeServiceDeps) {}

  /** Chunks + embeds a document and stores it under the given source name. */
  async addDocument(kbId: string, source: string, text: string): Promise<{ chunks: number }> {
    const kb = this.deps.db.knowledge.getById(kbId)
    if (!kb) throw new Error('Knowledge base not found.')
    const chunks = chunkText(text)
    if (chunks.length === 0) return { chunks: 0 }

    // Embed EVERYTHING first: a mid-import provider failure (rate limit,
    // network) must not leave the document half-replaced.
    const rows: Array<{ source: string; seq: number; content: string; embedding: Float32Array }> =
      []
    for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(offset, offset + EMBED_BATCH_SIZE)
      const vectors = await this.deps.embed(kb.providerId, kb.modelId, batch)
      for (let i = 0; i < batch.length; i++) {
        const vector = vectors[i]
        if (!vector || vector.length === 0) {
          throw new Error('The embeddings provider returned an incomplete batch.')
        }
        rows.push({
          source,
          seq: offset + i,
          content: batch[i],
          embedding: Float32Array.from(vector),
        })
      }
    }
    // Replace an existing document of the same name rather than duplicating —
    // only now that the new version is fully embedded, and atomically (one
    // transaction) so a failure can't strand the source half-replaced.
    this.deps.db.knowledge.replaceSourceChunks(kbId, source, rows)
    return { chunks: chunks.length }
  }

  /** Top-K chunks by cosine similarity to the query. */
  async search(kbId: string, query: string, topK = 5): Promise<KnowledgeSearchHit[]> {
    const kb = this.deps.db.knowledge.getById(kbId)
    if (!kb) throw new Error('Knowledge base not found.')
    const trimmed = query.trim()
    if (trimmed.length === 0) return []
    const [queryVector] = await this.deps.embed(kb.providerId, kb.modelId, [trimmed])
    const q = Float32Array.from(queryVector ?? [])
    return this.deps.db.knowledge
      .listChunks(kbId)
      .map((chunk) => ({
        source: chunk.source,
        content: chunk.content,
        score: cosineSimilarity(q, chunk.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(topK, 20)))
  }
}
