/**
 * Compare ("Arena") runs over the real db + ChatService (no Electron): the
 * preset's advisor models are fanned out in parallel and ARE the result — no
 * aggregator runs. The message finalizes with empty content plus the advisor
 * blocks; pickCompareWinner promotes one advisor's text to the answer and
 * switches the conversation to that model.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  ModelInfo,
  MoaPreset,
  StreamEventEnvelope,
  TestConnectionResult,
} from '@shared/types'
import { CHANNELS } from '@shared/ipc'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import type {
  AdapterChatRequest,
  AdapterChatResult,
  AdapterContext,
  AdapterStreamEvent,
  ProviderAdapter,
} from '../../src/main/providers/adapter'
import { ChatService } from '../../src/main/services/chat-service'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-compare-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Advisors hit chat() keyed by modelId; an aggregator would hit chatStream(). */
class CompareAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  readonly chatRequests: AdapterChatRequest[] = []
  readonly streamRequests: AdapterChatRequest[] = []

  constructor(private readonly chatFor: (modelId: string) => Promise<AdapterChatResult>) {}

  async chat(req: AdapterChatRequest): Promise<AdapterChatResult> {
    this.chatRequests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
    return this.chatFor(req.modelId)
  }

  async *chatStream(
    req: AdapterChatRequest,
    ctx: AdapterContext
  ): AsyncGenerator<AdapterStreamEvent> {
    this.streamRequests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
    if (ctx.signal?.aborted) {
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    }
    yield { type: 'text', text: 'Aggregator answer.' }
    yield { type: 'finish', reason: 'stop' }
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
    defaultModelId: 'agg',
    enabled: true,
  })
  db.providers.setKeyRow(
    provider.id,
    'insecure:' + Buffer.from('sk-cmp', 'utf8').toString('base64'),
    'sk-…cmp'
  )
  return provider.id
}

function makePreset(providerId: string, referenceModels: string[]): MoaPreset {
  return {
    id: randomUUID(),
    name: 'Panel',
    referenceModels: referenceModels.map((modelId) => ({ providerId, modelId })),
    aggregator: { providerId, modelId: 'agg' },
    enabled: true,
  }
}

interface Harness {
  service: ChatService
  adapter: CompareAdapter
  envelopes: StreamEventEnvelope[]
  done: Promise<StreamEventEnvelope>
}
function makeHarness(chatFor: (modelId: string) => Promise<AdapterChatResult>): Harness {
  const adapter = new CompareAdapter(chatFor)
  const envelopes: StreamEventEnvelope[] = []
  let resolveDone: (env: StreamEventEnvelope) => void = () => undefined
  const done = new Promise<StreamEventEnvelope>((resolve) => {
    resolveDone = resolve
  })
  const service = new ChatService(
    db,
    (channel, payload) => {
      if (channel !== CHANNELS.streamEvent) return
      const envelope = payload as StreamEventEnvelope
      envelopes.push(envelope)
      if (envelope.event.type === 'done' || envelope.event.type === 'error') resolveDone(envelope)
    },
    { resolveAdapter: () => adapter }
  )
  return { service, adapter, envelopes, done }
}

describe('ChatService — compare ("Arena") runs', () => {
  it('fans advisors out side by side without running an aggregator', async () => {
    const providerId = seedProvider()
    const preset = makePreset(providerId, ['ref-a', 'ref-b'])
    db.settings.update({ moaPresets: [preset] })
    const conversation = db.conversations.create({ mode: 'chat', title: 'Arena' })

    const { service, adapter, done } = makeHarness(async (modelId) => ({
      text: modelId === 'ref-a' ? 'Answer from A.' : 'Answer from B.',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    }))

    const start = await service.send({
      conversationId: conversation.id,
      content: 'Which is better?',
      overrides: { moaPresetId: preset.id, compare: true },
    })
    // The placeholder is marked at insert so the renderer lays out columns.
    expect(start.assistantMessage.compare).toEqual({ pickedIndex: null })

    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    // Both advisors ran; the aggregator never streamed.
    expect(adapter.chatRequests).toHaveLength(2)
    expect(adapter.streamRequests).toHaveLength(0)

    const message = doneEnvelope.event.message
    expect(message.status).toBe('complete')
    expect(message.content).toBe('')
    expect(message.compare).toEqual({ pickedIndex: null })
    expect(message.moaReferences).toHaveLength(2)
    expect(message.moaReferences?.every((r) => r.status === 'done')).toBe(true)

    // Persisted (survives reload).
    const stored = db.messages.listByConversation(conversation.id)
    const last = stored[stored.length - 1]
    expect(last.compare).toEqual({ pickedIndex: null })
    expect(last.moaReferences).toHaveLength(2)
  })

  it('pickCompareWinner promotes the text and switches the conversation model', async () => {
    const providerId = seedProvider()
    const preset = makePreset(providerId, ['ref-a', 'ref-b'])
    db.settings.update({ moaPresets: [preset] })
    const conversation = db.conversations.create({ mode: 'chat', title: 'Arena' })

    const { service, done } = makeHarness(async (modelId) => ({
      text: `Answer from ${modelId}.`,
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    }))

    const start = await service.send({
      conversationId: conversation.id,
      content: 'Go',
      overrides: { moaPresetId: preset.id, compare: true },
    })
    await done

    const result = service.pickCompareWinner({
      conversationId: conversation.id,
      messageId: start.assistantMessage.id,
      referenceIndex: 1,
    })
    expect(result.message.content).toBe('Answer from ref-b.')
    expect(result.message.compare).toEqual({ pickedIndex: 1 })
    expect(result.message.modelId).toBe('ref-b')
    expect(result.message.usage?.totalTokens).toBe(3)
    // The conversation continues with the winning model.
    expect(result.conversation.providerId).toBe(providerId)
    expect(result.conversation.modelId).toBe('ref-b')

    // Persisted on both rows.
    expect(db.conversations.getById(conversation.id)?.modelId).toBe('ref-b')
    const stored = db.messages.listByConversation(conversation.id)
    expect(stored[stored.length - 1].content).toBe('Answer from ref-b.')
  })

  it('rejects picking an advisor that produced no answer', async () => {
    const providerId = seedProvider()
    const preset = makePreset(providerId, ['ref-a', 'bad'])
    db.settings.update({ moaPresets: [preset] })
    const conversation = db.conversations.create({ mode: 'chat', title: 'Arena' })

    const { service, done } = makeHarness(async (modelId) => {
      if (modelId === 'bad') throw new Error('boom')
      return { text: 'Fine.', toolCalls: [], finishReason: 'stop' }
    })

    const start = await service.send({
      conversationId: conversation.id,
      content: 'Go',
      overrides: { moaPresetId: preset.id, compare: true },
    })
    await done

    expect(() =>
      service.pickCompareWinner({
        conversationId: conversation.id,
        messageId: start.assistantMessage.id,
        referenceIndex: 1,
      })
    ).toThrow(/no answer/)
    // Picking the healthy advisor still works.
    const result = service.pickCompareWinner({
      conversationId: conversation.id,
      messageId: start.assistantMessage.id,
      referenceIndex: 0,
    })
    expect(result.message.content).toBe('Fine.')
  })

  it('finalizes as error when every advisor fails', async () => {
    const providerId = seedProvider()
    const preset = makePreset(providerId, ['a', 'b'])
    db.settings.update({ moaPresets: [preset] })
    const conversation = db.conversations.create({ mode: 'chat', title: 'Arena' })

    const { service, done } = makeHarness(async () => {
      throw new Error('everything is down')
    })

    await service.send({
      conversationId: conversation.id,
      content: 'Go',
      overrides: { moaPresetId: preset.id, compare: true },
    })
    const doneEnvelope = await done
    expect(doneEnvelope.event.type).toBe('error')
    if (doneEnvelope.event.type !== 'error') throw new Error('expected error')
    expect(doneEnvelope.event.message.status).toBe('error')
    expect(doneEnvelope.event.message.moaReferences).toHaveLength(2)
  })

  it('compare without a resolvable preset degrades to a normal send', async () => {
    const providerId = seedProvider()
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Plain',
      providerId,
      modelId: 'agg',
    })

    const { service, adapter, done } = makeHarness(async () => ({
      text: 'unused',
      toolCalls: [],
      finishReason: 'stop',
    }))

    await service.send({
      conversationId: conversation.id,
      content: 'hello',
      overrides: { compare: true },
    })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    expect(adapter.chatRequests).toHaveLength(0)
    expect(adapter.streamRequests).toHaveLength(1)
    expect(doneEnvelope.event.message.compare).toBeUndefined()
    expect(doneEnvelope.event.message.content).toBe('Aggregator answer.')
  })
})
