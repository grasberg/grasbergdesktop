/**
 * Mixture of Agents end-to-end over the real db + ChatService (no Electron):
 * advisor (reference) models are called in parallel via chat(), their outputs
 * are streamed as moa-reference events and injected into the aggregator's last
 * user turn, and the aggregator streams the final answer through the ordinary
 * runStream pipeline. A failing advisor is captured, never fatal.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AppSettings,
  Conversation,
  ModelInfo,
  MoaPreset,
  StreamEventEnvelope,
  TestConnectionResult,
} from '@shared/types'
import { CHANNELS } from '@shared/ipc'
import { moaPresetSchema } from '@shared/schemas'
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
  dir = mkdtempSync(join(tmpdir(), 'uld-moa-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * One adapter instance serves every provider (all openai-compatible): advisor
 * calls hit chat() keyed by modelId; the aggregator hits chatStream().
 */
class MoaAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  readonly chatRequests: AdapterChatRequest[] = []
  readonly streamRequests: AdapterChatRequest[] = []
  streamText = 'Final synthesized answer.'

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
    yield { type: 'text', text: this.streamText }
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
    'insecure:' + Buffer.from('sk-moa', 'utf8').toString('base64'),
    'sk-…moa'
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
  adapter: MoaAdapter
  envelopes: StreamEventEnvelope[]
  done: Promise<StreamEventEnvelope>
}
function makeHarness(chatFor: (modelId: string) => Promise<AdapterChatResult>): Harness {
  const adapter = new MoaAdapter(chatFor)
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

function moaReferenceEvents(
  envelopes: StreamEventEnvelope[]
): Extract<StreamEventEnvelope['event'], { type: 'moa-reference' }>[] {
  return envelopes
    .map((e) => e.event)
    .filter((e): e is Extract<typeof e, { type: 'moa-reference' }> => e.type === 'moa-reference')
}

describe('ChatService — Mixture of Agents', () => {
  it('fans advisors out in parallel and synthesizes with the aggregator', async () => {
    const providerId = seedProvider()
    const preset = makePreset(providerId, ['ref-a', 'ref-b'])
    db.settings.update({ moaPresets: [preset] })
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'MoA',
      moaPresetId: preset.id,
    })

    const { service, adapter, envelopes, done } = makeHarness(async (modelId) => ({
      text: modelId === 'ref-a' ? 'Advisor A says X.' : 'Advisor B says Y.',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    }))

    const start = await service.send({ conversationId: conversation.id, content: 'Compare X and Y' })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    // Two advisors were called via chat(), with NO system prompt and NO tools.
    expect(adapter.chatRequests).toHaveLength(2)
    for (const req of adapter.chatRequests) {
      expect(req.tools).toBeUndefined()
      expect(req.messages.every((m) => m.role !== 'system')).toBe(true)
      expect(req.stream).toBe(false)
    }

    // Each advisor emitted a running + done moa-reference event.
    const refs = moaReferenceEvents(envelopes)
    const finalPerIndex = new Map<number, string>()
    for (const e of refs) finalPerIndex.set(e.reference.index, e.reference.status)
    expect(finalPerIndex.get(0)).toBe('done')
    expect(finalPerIndex.get(1)).toBe('done')

    // The aggregator streamed once; its last user turn carries both analyses.
    expect(adapter.streamRequests).toHaveLength(1)
    const aggMessages = adapter.streamRequests[0].messages
    const lastUser = [...aggMessages].reverse().find((m) => m.role === 'user')
    const lastUserText = typeof lastUser?.content === 'string' ? lastUser.content : ''
    expect(lastUserText).toContain('Compare X and Y')
    expect(lastUserText).toContain('Advisor A says X.')
    expect(lastUserText).toContain('Advisor B says Y.')

    // Final assistant message: aggregator text + persisted advisor blocks.
    const finalMessage = doneEnvelope.event.message
    expect(finalMessage.id).toBe(start.assistantMessage.id)
    expect(finalMessage.status).toBe('complete')
    expect(finalMessage.content).toBe('Final synthesized answer.')
    expect(finalMessage.providerId).toBe(providerId)
    expect(finalMessage.modelId).toBe('agg')
    expect(finalMessage.moaReferences).toHaveLength(2)
    expect(finalMessage.moaReferences?.map((r) => r.text).sort()).toEqual([
      'Advisor A says X.',
      'Advisor B says Y.',
    ])

    // Persisted to the db (survives reload).
    const stored = db.messages.listByConversation(conversation.id)
    expect(stored[stored.length - 1].moaReferences).toHaveLength(2)
  })

  it('captures a failing advisor without aborting the aggregator', async () => {
    const providerId = seedProvider()
    const preset = makePreset(providerId, ['ref-a', 'bad'])
    db.settings.update({ moaPresets: [preset] })
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'MoA',
      moaPresetId: preset.id,
    })

    const { service, envelopes, done } = makeHarness(async (modelId) => {
      if (modelId === 'bad') throw new Error('boom: model unavailable')
      return { text: 'Advisor A is fine.', toolCalls: [], finishReason: 'stop' }
    })

    await service.send({ conversationId: conversation.id, content: 'Hi' })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    // The generation still completed with the aggregator answer.
    expect(doneEnvelope.event.message.status).toBe('complete')
    expect(doneEnvelope.event.message.content).toBe('Final synthesized answer.')

    const references = doneEnvelope.event.message.moaReferences ?? []
    const failed = references.find((r) => r.status === 'error')
    expect(failed?.modelId).toBe('bad')
    expect(failed?.error).toBeTruthy()
    // The advisor error surfaced in the moa-reference stream too.
    expect(moaReferenceEvents(envelopes).some((e) => e.reference.status === 'error')).toBe(true)
  })

  it('runs a one-shot preset from overrides without a stored conversation preset', async () => {
    const providerId = seedProvider()
    const preset = makePreset(providerId, ['ref-a'])
    db.settings.update({ moaPresets: [preset], defaultMoaPresetId: preset.id })
    // No moaPresetId on the conversation — the override alone drives MoA.
    const conversation = db.conversations.create({ mode: 'chat', title: 'One-shot' })

    const { service, adapter, done } = makeHarness(async () => ({
      text: 'One advisor.',
      toolCalls: [],
      finishReason: 'stop',
    }))

    await service.send({
      conversationId: conversation.id,
      content: 'quick',
      overrides: { moaPresetId: preset.id },
    })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    expect(adapter.chatRequests).toHaveLength(1)
    expect(doneEnvelope.event.message.moaReferences).toHaveLength(1)
  })

  it('a non-MoA conversation streams normally with no advisor blocks', async () => {
    const providerId = seedProvider()
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Plain',
      providerId,
      modelId: 'agg',
    })

    const { service, adapter, envelopes, done } = makeHarness(async () => ({
      text: 'unused',
      toolCalls: [],
      finishReason: 'stop',
    }))

    await service.send({ conversationId: conversation.id, content: 'hello' })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    expect(adapter.chatRequests).toHaveLength(0) // no advisors
    expect(moaReferenceEvents(envelopes)).toHaveLength(0)
    expect(doneEnvelope.event.message.moaReferences).toBeUndefined()
    expect(doneEnvelope.event.message.content).toBe('Final synthesized answer.')
  })

  it('aborting during fan-out finalizes stopped and still persists advisor blocks', async () => {
    const providerId = seedProvider()
    const preset = makePreset(providerId, ['ref-a', 'ref-b'])
    db.settings.update({ moaPresets: [preset] })
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Stop',
      moaPresetId: preset.id,
    })

    const gate = deferred<void>()
    const { service, adapter, done } = makeHarness(async (modelId) => {
      await gate.promise
      return { text: `Advisor ${modelId}.`, toolCalls: [], finishReason: 'stop' }
    })

    const start = await service.send({ conversationId: conversation.id, content: 'wait' })
    // Advisors are gated (in-flight): stop before they resolve.
    service.stop(start.streamId)
    gate.resolve()

    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')
    expect(doneEnvelope.event.finishReason).toBe('aborted')
    expect(doneEnvelope.event.message.status).toBe('stopped')
    // The aggregator never produced text (its stream saw the aborted signal).
    expect(adapter.streamRequests.length).toBeLessThanOrEqual(1)
    expect(doneEnvelope.event.message.content).toBe('')
    // Advisor blocks were still captured/persisted.
    expect(doneEnvelope.event.message.moaReferences).toHaveLength(2)
  })

  it('contains a DB failure in the advisor phase instead of wedging the conversation', async () => {
    const aggregatorId = seedProvider()
    const advisorId = seedProvider()
    const preset: MoaPreset = {
      id: randomUUID(),
      name: 'Panel',
      referenceModels: [{ providerId: advisorId, modelId: 'ref-a' }],
      aggregator: { providerId: aggregatorId, modelId: 'agg' },
      enabled: true,
    }
    db.settings.update({ moaPresets: [preset] })
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'MoA',
      moaPresetId: preset.id,
    })

    // The advisor label is built from a providers read; make that read throw
    // (the aggregator's own resolution still works).
    const getById = db.providers.getById.bind(db.providers)
    db.providers.getById = (id: string) => {
      if (id === advisorId) throw new Error('db read failed')
      return getById(id)
    }

    const { service, done } = makeHarness(async () => ({
      text: 'unused',
      toolCalls: [],
      finishReason: 'stop',
    }))
    await service.send({ conversationId: conversation.id, content: 'hello' })
    const doneEnvelope = await done

    // The aggregator still answered; the placeholder never stays 'streaming'.
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')
    expect(doneEnvelope.event.message.status).toBe('complete')
    expect(doneEnvelope.event.message.content).toBe('Final synthesized answer.')
    // And the conversation's generation slot was released: a new send works.
    await expect(
      service.send({ conversationId: conversation.id, content: 'again' })
    ).resolves.toBeTruthy()
  })
})

describe('MoA preset schema + settings round-trip', () => {
  it('validates a well-formed preset and rejects one with no advisors', () => {
    const good: MoaPreset = {
      id: 'p1',
      name: 'Panel',
      referenceModels: [{ providerId: 'a', modelId: 'm1' }],
      aggregator: { providerId: 'a', modelId: 'm2' },
      enabled: true,
    }
    expect(moaPresetSchema.safeParse(good).success).toBe(true)
    expect(moaPresetSchema.safeParse({ ...good, referenceModels: [] }).success).toBe(false)
  })

  it('persists moaPresets and defaultMoaPresetId through the settings repo', () => {
    const preset: MoaPreset = {
      id: 'p1',
      name: 'Panel',
      referenceModels: [{ providerId: 'a', modelId: 'm1' }],
      aggregator: { providerId: 'a', modelId: 'm2' },
      referenceTemperature: 0.5,
      enabled: true,
    }
    const saved: AppSettings = db.settings.update({
      moaPresets: [preset],
      defaultMoaPresetId: 'p1',
    })
    expect(saved.moaPresets).toEqual([preset])
    expect(saved.defaultMoaPresetId).toBe('p1')
    // A fresh read merges over defaults identically.
    expect(db.settings.get().moaPresets).toEqual([preset])
  })
})
