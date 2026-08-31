/**
 * Quick assistant — the ephemeral streaming path: events reach ONLY the given
 * emit callback, nothing is ever persisted, chat-stop-by-streamId aborts it,
 * thrown adapter errors are normalized and key-redacted, and a second run
 * aborts the first (single quick stream at a time).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  ModelInfo,
  QuickAction,
  QuickStreamEventEnvelope,
  TestConnectionResult,
} from '@shared/types'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import type {
  AdapterChatRequest,
  AdapterChatResult,
  AdapterContext,
  AdapterStreamEvent,
  ProviderAdapter,
} from '../../../src/main/providers/adapter'
import { ChatService } from '../../../src/main/services/chat-service'
import { QUICK_SYSTEM_PROMPT } from '../../../src/main/prompts'

const API_KEY = 'sk-quick-secret-123'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-quick-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

type StreamBehavior = (
  req: AdapterChatRequest,
  ctx: AdapterContext
) => AsyncGenerator<AdapterStreamEvent>

class FakeQuickAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  requests: AdapterChatRequest[] = []

  constructor(private behavior: StreamBehavior) {}

  setBehavior(behavior: StreamBehavior): void {
    this.behavior = behavior
  }

  chatStream(req: AdapterChatRequest, ctx: AdapterContext): AsyncGenerator<AdapterStreamEvent> {
    this.requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
    return this.behavior(req, ctx)
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

function seedProvider(defaultModelId = 'quick-model'): string {
  const provider = db.providers.create({
    id: randomUUID(),
    type: 'openai-compatible',
    label: 'Fake',
    baseUrl: 'https://fake.example/v1',
    defaultModelId,
    enabled: true,
  })
  db.providers.setKeyRow(
    provider.id,
    'insecure:' + Buffer.from(API_KEY, 'utf8').toString('base64'),
    'sk-…123'
  )
  db.settings.update({ defaultProviderId: provider.id })
  return provider.id
}

function makeService(adapter: FakeQuickAdapter): ChatService {
  return new ChatService(db, () => undefined, { resolveAdapter: () => adapter })
}

interface Collector {
  envelopes: QuickStreamEventEnvelope[]
  emit: (envelope: QuickStreamEventEnvelope) => void
  done: Promise<QuickStreamEventEnvelope>
}

function makeCollector(): Collector {
  const envelopes: QuickStreamEventEnvelope[] = []
  let resolveDone: (env: QuickStreamEventEnvelope) => void = () => undefined
  const done = new Promise<QuickStreamEventEnvelope>((resolve) => {
    resolveDone = resolve
  })
  const emit = (envelope: QuickStreamEventEnvelope): void => {
    envelopes.push(envelope)
    if (envelope.event.type === 'done' || envelope.event.type === 'error') resolveDone(envelope)
  }
  return { envelopes, emit, done }
}

const action = (overrides: Partial<QuickAction> = {}): QuickAction => ({
  id: 'explain',
  label: 'Explain',
  prompt: 'Explain this:\n\n{selection}',
  ...overrides,
})

async function* happyStream(): AsyncGenerator<AdapterStreamEvent> {
  yield { type: 'text', text: 'Hello ' }
  yield { type: 'text', text: 'world.' }
  yield { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
  yield { type: 'finish', reason: 'stop' }
}

describe('ChatService.startQuickStream', () => {
  it('streams deltas then done with the full text and usage — persisting nothing', async () => {
    seedProvider()
    const adapter = new FakeQuickAdapter(happyStream)
    const service = makeService(adapter)
    const collector = makeCollector()

    const result = await service.startQuickStream({
      action: action(),
      selection: 'some copied text',
      emit: collector.emit,
    })
    const doneEnvelope = await collector.done

    expect(doneEnvelope.streamId).toBe(result.streamId)
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done event')
    expect(doneEnvelope.event.finishReason).toBe('stop')
    expect(doneEnvelope.event.text).toBe('Hello world.')
    expect(doneEnvelope.event.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    })
    // The deltas that streamed concatenate to the final text.
    const deltaText = collector.envelopes
      .map((e) => (e.event.type === 'text-delta' ? e.event.text : ''))
      .join('')
    expect(deltaText).toBe('Hello world.')

    // NOTHING was persisted: no conversation, no message rows.
    expect(db.conversations.list()).toHaveLength(0)
    const [row] = db.driver.all<{ n: number }>('SELECT COUNT(*) AS n FROM messages')
    expect(row.n).toBe(0)

    // …but the spend landed in the headless ledger as run_kind 'other'.
    const ledger = db.headlessUsage.summarySince(0)
    expect(ledger).toHaveLength(1)
    expect(ledger[0].runKind).toBe('other')
    expect(ledger[0].promptTokens).toBe(10)
    expect(ledger[0].completionTokens).toBe(5)
  })

  it('chat-stop by streamId aborts mid-stream and keeps the partial text', async () => {
    seedProvider()
    let releaseGate: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const adapter = new FakeQuickAdapter(async function* (_req, ctx) {
      yield { type: 'text', text: 'partial' }
      await gate
      if (ctx.signal?.aborted) {
        const e = new Error('The operation was aborted.')
        e.name = 'AbortError'
        throw e
      }
      yield { type: 'finish', reason: 'stop' }
    })
    const service = makeService(adapter)
    const collector = makeCollector()

    const result = await service.startQuickStream({
      action: action(),
      selection: 'text',
      emit: collector.emit,
    })
    // The existing chat:stop surface reaches quick streams too.
    service.stop(result.streamId)
    releaseGate()

    const doneEnvelope = await collector.done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done event')
    expect(doneEnvelope.event.finishReason).toBe('aborted')
    expect(doneEnvelope.event.text).toBe('partial')
    expect(db.conversations.list()).toHaveLength(0)
  })

  it('normalizes a thrown adapter error and redacts the API key', async () => {
    seedProvider()
    const adapter = new FakeQuickAdapter(async function* () {
      yield { type: 'text', text: 'x' }
      throw new Error(`upstream exploded with key ${API_KEY}`)
    })
    const service = makeService(adapter)
    const collector = makeCollector()

    await service.startQuickStream({ action: action(), selection: 'text', emit: collector.emit })
    const errorEnvelope = await collector.done
    if (errorEnvelope.event.type !== 'error') throw new Error('expected error event')
    expect(errorEnvelope.event.error.code).toBeTruthy()
    expect(errorEnvelope.event.error.message).not.toContain(API_KEY)
  })

  it('starting a second quick run aborts the first', async () => {
    seedProvider()
    let releaseGate: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const adapter = new FakeQuickAdapter(async function* (_req, ctx) {
      yield { type: 'text', text: 'first' }
      await gate
      if (ctx.signal?.aborted) {
        const e = new Error('The operation was aborted.')
        e.name = 'AbortError'
        throw e
      }
      yield { type: 'finish', reason: 'stop' }
    })
    const service = makeService(adapter)
    const first = makeCollector()
    await service.startQuickStream({ action: action(), selection: 'one', emit: first.emit })

    adapter.setBehavior(happyStream)
    const second = makeCollector()
    await service.startQuickStream({ action: action(), selection: 'two', emit: second.emit })
    releaseGate()

    const firstDone = await first.done
    if (firstDone.event.type !== 'done') throw new Error('expected done event')
    expect(firstDone.event.finishReason).toBe('aborted')

    const secondDone = await second.done
    if (secondDone.event.type !== 'done') throw new Error('expected done event')
    expect(secondDone.event.finishReason).toBe('stop')
    expect(secondDone.event.text).toBe('Hello world.')
  })

  it('per-action provider/model overrides beat the settings default', async () => {
    seedProvider() // the default provider
    const override = db.providers.create({
      id: randomUUID(),
      type: 'openai-compatible',
      label: 'Override',
      baseUrl: 'https://override.example/v1',
      defaultModelId: 'override-default',
      enabled: true,
    })
    db.providers.setKeyRow(
      override.id,
      'insecure:' + Buffer.from('sk-override', 'utf8').toString('base64'),
      'sk-…ide'
    )
    const adapter = new FakeQuickAdapter(happyStream)
    const service = makeService(adapter)
    const collector = makeCollector()

    const result = await service.startQuickStream({
      action: action({ providerId: override.id, modelId: 'special-model' }),
      selection: 'text',
      emit: collector.emit,
    })
    await collector.done

    expect(result.providerId).toBe(override.id)
    expect(result.modelId).toBe('special-model')
    expect(adapter.requests[0].modelId).toBe('special-model')
  })

  it('returns the composed prompt and sends system + user messages', async () => {
    seedProvider()
    const adapter = new FakeQuickAdapter(happyStream)
    const service = makeService(adapter)
    const collector = makeCollector()

    const result = await service.startQuickStream({
      action: action(),
      selection: 'the copied bit',
      emit: collector.emit,
    })
    await collector.done

    expect(result.prompt).toBe('Explain this:\n\nthe copied bit')
    const [request] = adapter.requests
    expect(request.messages).toEqual([
      { role: 'system', content: QUICK_SYSTEM_PROMPT },
      { role: 'user', content: 'Explain this:\n\nthe copied bit' },
    ])
    expect(request.tools).toBeUndefined()
  })
})
