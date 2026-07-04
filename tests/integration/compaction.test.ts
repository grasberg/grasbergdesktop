/**
 * Context compaction end-to-end over the real db + ChatService. When the
 * transcript exceeds the threshold, maybeCompact summarizes older messages via
 * the adapter's non-streaming chat(), persists the summary, and the streamed
 * request carries the summary + only the recent turns. A failing chat() falls
 * back to the full history.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  Conversation,
  ModelInfo,
  StreamEventEnvelope,
  TestConnectionResult,
} from '@shared/types'
import { CHANNELS } from '@shared/ipc'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import type {
  AdapterChatRequest,
  AdapterChatResult,
  AdapterStreamEvent,
  ProviderAdapter,
} from '../../src/main/providers/adapter'
import { ChatService } from '../../src/main/services/chat-service'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-compaction-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

class CompactionAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  readonly invocations: AdapterChatRequest[] = []
  readonly chatCalls: AdapterChatRequest[] = []
  constructor(private readonly summarize: () => AdapterChatResult) {}

  async *chatStream(req: AdapterChatRequest): AsyncGenerator<AdapterStreamEvent> {
    this.invocations.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
    yield { type: 'text', text: 'Reply.' }
    yield { type: 'finish', reason: 'stop' }
  }

  async chat(req: AdapterChatRequest): Promise<AdapterChatResult> {
    this.chatCalls.push(req)
    return this.summarize()
  }

  async listModels(): Promise<ModelInfo[]> {
    return []
  }
  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'ok' }
  }
}

function seed(): Conversation {
  const provider = db.providers.create({
    id: randomUUID(),
    type: 'openai-compatible',
    label: 'Fake',
    baseUrl: 'https://fake.example/v1',
    defaultModelId: 'fake-model',
    enabled: true,
  })
  db.providers.setKeyRow(
    provider.id,
    'insecure:' + Buffer.from('sk-compaction', 'utf8').toString('base64'),
    'sk-…comp'
  )
  db.settings.update({ compactionEnabled: true, compactionThresholdRatio: 0.1 })
  const conversation = db.conversations.create({
    mode: 'chat',
    title: 'Long chat',
    providerId: provider.id,
    modelId: 'fake-model',
  })
  // 14 large messages (~1000 chars each) -> well over 0.1 * 32000 tokens.
  const big = 'x'.repeat(1000)
  for (let i = 0; i < 14; i++) {
    db.messages.insert({
      id: randomUUID(),
      conversationId: conversation.id,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg ${i} ${big}`,
      status: 'complete',
      seq: db.messages.nextSeq(conversation.id),
      createdAt: Date.now(),
    })
  }
  return conversation
}

describe('ChatService context compaction', () => {
  it('summarizes older turns, persists the summary, and prunes the wire history', async () => {
    const conversation = seed()
    const adapter = new CompactionAdapter(() => ({
      text: 'CONDENSED SUMMARY',
      toolCalls: [],
      finishReason: 'stop',
    }))
    let resolveDone: () => void = () => undefined
    const done = new Promise<void>((r) => (resolveDone = r))
    const service = new ChatService(
      db,
      (channel, payload) => {
        if (channel !== CHANNELS.streamEvent) return
        const env = payload as StreamEventEnvelope
        if (env.event.type === 'done' || env.event.type === 'error') resolveDone()
      },
      { resolveAdapter: () => adapter }
    )

    service.send({ conversationId: conversation.id, content: 'next question' })
    await done

    // The summary was generated and persisted.
    expect(adapter.chatCalls).toHaveLength(1)
    const stored = db.conversations.getById(conversation.id)!
    expect(stored.summaryText).toBe('CONDENSED SUMMARY')
    expect(stored.summaryThroughSeq).toBeGreaterThan(0)

    // The streamed request carries the summary as a system message and far
    // fewer messages than the full 15+ transcript.
    const wire = adapter.invocations[0].messages
    const summarySystem = wire.find(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('CONDENSED SUMMARY')
    )
    expect(summarySystem).toBeDefined()
    expect(wire.length).toBeLessThan(15)
    // The latest user turn ('next question') is always kept verbatim.
    expect(
      wire.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('next question'))
    ).toBe(true)
  })

  it('falls back to the full history when summarization fails', async () => {
    const conversation = seed()
    const adapter = new CompactionAdapter(() => {
      throw new Error('summarization boom')
    })
    let resolveDone: () => void = () => undefined
    const done = new Promise<void>((r) => (resolveDone = r))
    const service = new ChatService(
      db,
      (channel, payload) => {
        if (channel !== CHANNELS.streamEvent) return
        const env = payload as StreamEventEnvelope
        if (env.event.type === 'done' || env.event.type === 'error') resolveDone()
      },
      { resolveAdapter: () => adapter }
    )

    service.send({ conversationId: conversation.id, content: 'next question' })
    await done

    // No summary persisted; the generation still completed.
    const stored = db.conversations.getById(conversation.id)!
    expect(stored.summaryText ?? null).toBeNull()
    // Full history (15 seeded/new user+assistant messages) reached the wire.
    const userAssistant = adapter.invocations[0].messages.filter(
      (m) => m.role === 'user' || m.role === 'assistant'
    )
    expect(userAssistant.length).toBeGreaterThanOrEqual(15)
  })
})
