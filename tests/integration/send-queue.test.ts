/**
 * Busy-send queue (v47, OpenClaw collect semantics) over the real db +
 * ChatService: a send while a stream runs persists + queues the message
 * (instead of the old "stop it first" error), and ONE coalesced follow-up
 * turn covers everything queued after the stream completes.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, ModelInfo, TestConnectionResult } from '@shared/types'
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
  dir = mkdtempSync(join(tmpdir(), 'uld-send-queue-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** First stream holds until release(); later streams finish immediately. */
class GatedAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  readonly invocations: AdapterChatRequest[] = []
  private releaseFirst: (() => void) | null = null
  readonly firstStarted: Promise<void>
  private markStarted: () => void = () => undefined

  constructor() {
    this.firstStarted = new Promise((resolve) => {
      this.markStarted = resolve
    })
  }

  release(): void {
    this.releaseFirst?.()
  }

  async *chatStream(req: AdapterChatRequest): AsyncGenerator<AdapterStreamEvent> {
    this.invocations.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
    if (this.invocations.length === 1) {
      this.markStarted()
      yield { type: 'text', text: 'thinking…' }
      await new Promise<void>((resolve) => {
        this.releaseFirst = resolve
      })
      yield { type: 'text', text: ' first answer.' }
      yield { type: 'finish', reason: 'stop' }
      return
    }
    yield { type: 'text', text: 'coalesced answer.' }
    yield { type: 'finish', reason: 'stop' }
  }

  async chat(): Promise<AdapterChatResult> {
    throw new Error('not used')
  }

  async listModels(): Promise<ModelInfo[]> {
    return []
  }

  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'ok' }
  }
}

function seedConversation(): Conversation {
  const provider = db.providers.create({
    id: randomUUID(),
    type: 'openai-compatible',
    label: 'Fake provider',
    baseUrl: 'https://fake.example/v1',
    defaultModelId: 'fake-model',
    enabled: true,
  })
  db.providers.setKeyRow(
    provider.id,
    'insecure:' + Buffer.from('sk-test-queue', 'utf8').toString('base64'),
    'sk-…queue'
  )
  return db.conversations.create({
    mode: 'chat',
    title: 'Queue test',
    providerId: provider.id,
    modelId: 'fake-model',
  })
}

describe('busy-send queue (v47)', () => {
  it('queues while streaming, then drains one coalesced turn', async () => {
    const conversation = seedConversation()
    const adapter = new GatedAdapter()
    const service = new ChatService(db, () => undefined, {
      resolveAdapter: () => adapter,
    })

    const first = await service.send(
      { conversationId: conversation.id, content: 'question one' },
      { queueIfBusy: true }
    )
    expect('queued' in first).toBe(false)
    await adapter.firstStarted

    // Two rapid follow-ups while the stream is held: both queue.
    const second = await service.send(
      { conversationId: conversation.id, content: 'also this' },
      { queueIfBusy: true }
    )
    const third = await service.send(
      { conversationId: conversation.id, content: 'and this' },
      { queueIfBusy: true }
    )
    expect(second).toMatchObject({ queued: true })
    expect(third).toMatchObject({ queued: true })
    if ('queued' in second) expect(second.userMessage.content).toBe('also this')

    // Without opting in, a busy send still throws (internal callers).
    await expect(
      service.send({ conversationId: conversation.id, content: 'no queue' })
    ).rejects.toThrow(/already streaming/)

    adapter.release()
    // The drained turn starts ~500 ms after completion and covers the queue.
    await vi.waitFor(() => expect(adapter.invocations).toHaveLength(2), { timeout: 5000 })
    await vi.waitFor(
      () => {
        const messages = db.messages.listByConversation(conversation.id)
        expect(
          messages.filter((m) => m.role === 'assistant' && m.status === 'complete')
        ).toHaveLength(2)
      },
      { timeout: 5000 }
    )

    // The coalesced turn's request contains BOTH queued user messages.
    const drained = adapter.invocations[1]
    const userTexts = drained.messages
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
    expect(userTexts).toContain('also this')
    expect(userTexts).toContain('and this')

    // The final transcript: q1, a1, queued x2 (one 'no queue' never persisted), a2.
    const all = db.messages.listByConversation(conversation.id)
    expect(all.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'user',
      'assistant',
    ])
  })
})
