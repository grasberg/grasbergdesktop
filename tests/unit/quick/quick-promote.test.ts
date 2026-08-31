/**
 * Quick assistant — promoteQuick: a finished quick exchange becomes a real
 * chat conversation (user seq 1 + assistant seq 2, both complete), the
 * fallback title derives from the prompt, push:quickPromoted broadcasts once,
 * and the promoted conversation accepts a follow-up send (linear history).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  ModelInfo,
  StreamEventEnvelope,
  TestConnectionResult,
} from '@shared/types'
import { CHANNELS } from '@shared/ipc'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import type {
  AdapterChatRequest,
  AdapterChatResult,
  AdapterContext,
  AdapterStreamEvent,
  ProviderAdapter,
} from '../../../src/main/providers/adapter'
import { ChatService } from '../../../src/main/services/chat-service'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-promote-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

class SimpleAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const

  async *chatStream(
    _req: AdapterChatRequest,
    _ctx: AdapterContext
  ): AsyncGenerator<AdapterStreamEvent> {
    yield { type: 'text', text: 'Follow-up answer.' }
    yield { type: 'finish', reason: 'stop' }
  }
  async chat(): Promise<AdapterChatResult> {
    throw new Error('not used in this test')
  }
  async listModels(): Promise<ModelInfo[]> {
    return []
  }
  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'ok' }
  }
}

function seedProvider(): string {
  const provider = db.providers.create({
    id: randomUUID(),
    type: 'openai-compatible',
    label: 'Fake',
    baseUrl: 'https://fake.example/v1',
    defaultModelId: 'quick-model',
    enabled: true,
  })
  db.providers.setKeyRow(
    provider.id,
    'insecure:' + Buffer.from('sk-promote', 'utf8').toString('base64'),
    'sk-…ote'
  )
  return provider.id
}

interface Harness {
  service: ChatService
  broadcasts: Array<{ channel: string; payload: unknown }>
  streamDone: Promise<StreamEventEnvelope>
}

function makeHarness(): Harness {
  const broadcasts: Array<{ channel: string; payload: unknown }> = []
  let resolveDone: (env: StreamEventEnvelope) => void = () => undefined
  const streamDone = new Promise<StreamEventEnvelope>((resolve) => {
    resolveDone = resolve
  })
  const service = new ChatService(
    db,
    (channel, payload) => {
      broadcasts.push({ channel, payload })
      if (channel !== CHANNELS.streamEvent) return
      const envelope = payload as StreamEventEnvelope
      if (envelope.event.type === 'done' || envelope.event.type === 'error') resolveDone(envelope)
    },
    { resolveAdapter: () => new SimpleAdapter() }
  )
  return { service, broadcasts, streamDone }
}

describe('ChatService.promoteQuick', () => {
  it('creates a chat conversation with a complete user/assistant pair', () => {
    const providerId = seedProvider()
    const { service } = makeHarness()

    const conversation = service.promoteQuick({
      userText: 'Explain this:\n\nsome text',
      answer: 'It means…',
      providerId,
      modelId: 'quick-model',
      title: 'Explain: some text',
    })

    expect(conversation.mode).toBe('chat')
    expect(conversation.title).toBe('Explain: some text')
    expect(conversation.providerId).toBe(providerId)
    expect(conversation.modelId).toBe('quick-model')

    const messages = db.messages.listByConversation(conversation.id)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: 'Explain this:\n\nsome text',
      status: 'complete',
      seq: 1,
    })
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'It means…',
      status: 'complete',
      providerId,
      modelId: 'quick-model',
      seq: 2,
    })
  })

  it('derives the fallback title from whitespace-collapsed userText, capped at 60', () => {
    const providerId = seedProvider()
    const { service } = makeHarness()

    const longText = `first line\n\n  ${'word '.repeat(30)}`
    const conversation = service.promoteQuick({
      userText: longText,
      answer: 'answer',
      providerId,
      modelId: 'quick-model',
    })
    expect(conversation.title).toBe(longText.replace(/\s+/g, ' ').trim().slice(0, 60))
    expect(conversation.title.length).toBeLessThanOrEqual(60)
    expect(conversation.title).not.toContain('\n')
  })

  it('broadcasts push:quickPromoted exactly once with the conversation id', () => {
    const providerId = seedProvider()
    const { service, broadcasts } = makeHarness()

    const conversation = service.promoteQuick({
      userText: 'question',
      answer: 'answer',
      providerId,
      modelId: 'quick-model',
    })
    const promoted = broadcasts.filter((b) => b.channel === CHANNELS.quickPromoted)
    expect(promoted).toHaveLength(1)
    expect(promoted[0].payload).toEqual({ conversationId: conversation.id })
  })

  it('accepts a follow-up send — the linear-history invariant holds', async () => {
    const providerId = seedProvider()
    const { service, streamDone } = makeHarness()

    const conversation = service.promoteQuick({
      userText: 'question',
      answer: 'answer',
      providerId,
      modelId: 'quick-model',
    })
    await service.send({ conversationId: conversation.id, content: 'follow up' })
    const doneEnvelope = await streamDone
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done event')
    expect(doneEnvelope.event.message.content).toBe('Follow-up answer.')

    const messages = db.messages.listByConversation(conversation.id)
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3, 4])
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })
})
