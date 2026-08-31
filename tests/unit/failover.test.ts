/**
 * Reliability Autopilot: failover chains over the real db + ChatService (no
 * Electron). Interactive streams walk the chain on transient provider errors
 * and empty replies (never after an executed tool round, never on stop or
 * auth); headless funnels walk their own chain; failedOverFrom rides inside
 * usage_json and is split back out by the messages repository.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  Message,
  ModelInfo,
  StreamEventEnvelope,
  TestConnectionResult,
  ToolDefinition,
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
import { ProviderError } from '../../src/main/providers/errors'
import { ChatService, type ChatToolSystem } from '../../src/main/services/chat-service'
import {
  FAILOVER_ERROR_CODES,
  isFailoverEligible,
  nextChainEntry,
} from '../../src/main/services/failover'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-failover-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** chatStream/chat behavior keyed off the request (throw / partial / empty). */
class ScriptedAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  readonly streamRequests: AdapterChatRequest[] = []
  readonly chatRequests: AdapterChatRequest[] = []

  constructor(
    private readonly streamScript?: (req: AdapterChatRequest) => Iterable<AdapterStreamEvent>,
    private readonly chatScript?: (req: AdapterChatRequest) => AdapterChatResult
  ) {}

  async chat(req: AdapterChatRequest): Promise<AdapterChatResult> {
    this.chatRequests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
    if (!this.chatScript) throw new Error('chat not scripted')
    return this.chatScript(req)
  }

  async *chatStream(
    req: AdapterChatRequest,
    _ctx: AdapterContext
  ): AsyncGenerator<AdapterStreamEvent> {
    this.streamRequests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
    if (!this.streamScript) throw new Error('chatStream not scripted')
    for (const event of this.streamScript(req)) yield event
  }

  async listModels(): Promise<ModelInfo[]> {
    return []
  }
  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'ok' }
  }
}

function seedProvider(label = 'Primary', withKey = true): string {
  const provider = db.providers.create({
    id: randomUUID(),
    type: 'openai-compatible',
    label,
    baseUrl: 'https://fake.example/v1',
    defaultModelId: 'default-model',
    enabled: true,
  })
  if (withKey) {
    db.providers.setKeyRow(
      provider.id,
      'insecure:' + Buffer.from('sk-failover', 'utf8').toString('base64'),
      'sk-…ver'
    )
  }
  return provider.id
}

interface Harness {
  service: ChatService
  envelopes: StreamEventEnvelope[]
  done: Promise<StreamEventEnvelope>
}
function makeHarness(adapter: ProviderAdapter, tools?: ChatToolSystem): Harness {
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
    { resolveAdapter: () => adapter, ...(tools ? { tools } : {}) }
  )
  return { service, envelopes, done }
}

function failoverActivityEntries() {
  return db.activity.list().entries.filter((e) => e.toolName === 'provider_failover')
}

function lastAssistantMessage(conversationId: string): Message {
  const messages = db.messages.listByConversation(conversationId)
  const assistant = [...messages].reverse().find((m) => m.role === 'assistant')
  if (!assistant) throw new Error('no assistant message')
  return assistant
}

describe('Reliability Autopilot — interactive stream', () => {
  it('server error on the primary walks to the chain entry', async () => {
    const primaryId = seedProvider('Primary')
    const fallbackId = seedProvider('Fallback')
    db.settings.update({
      failoverChains: { interactive: [{ providerId: fallbackId, modelId: 'fallback-model' }] },
    })
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Failover',
      providerId: primaryId,
      modelId: 'primary-model',
    })
    const adapter = new ScriptedAdapter(function* (req) {
      if (req.modelId === 'primary-model') throw new ProviderError('server', 'boom')
      yield { type: 'text', text: `Answer from ${req.modelId}.` }
      yield { type: 'finish', reason: 'stop' }
    })

    const { service, envelopes, done } = makeHarness(adapter)
    await service.send({ conversationId: conversation.id, content: 'Q?' })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    const failoverIndex = envelopes.findIndex((e) => e.event.type === 'failover')
    const doneIndex = envelopes.findIndex((e) => e.event.type === 'done')
    expect(failoverIndex).toBeGreaterThanOrEqual(0)
    expect(failoverIndex).toBeLessThan(doneIndex)
    const failoverEvent = envelopes[failoverIndex]!.event
    if (failoverEvent.type !== 'failover') throw new Error('expected failover')
    expect(failoverEvent.message.content).toBe('')
    expect(failoverEvent.message.modelId).toBe('fallback-model')

    const message = doneEnvelope.event.message
    expect(message.content).toBe('Answer from fallback-model.')
    expect(message.providerId).toBe(fallbackId)
    expect(message.modelId).toBe('fallback-model')
    expect(message.failedOverFrom).toEqual([
      { providerId: primaryId, modelId: 'primary-model', code: 'server' },
    ])

    const stored = lastAssistantMessage(conversation.id)
    expect(stored.status).toBe('complete')
    expect(stored.failedOverFrom).toEqual(message.failedOverFrom)
    expect(stored.modelId).toBe('fallback-model')

    const activity = failoverActivityEntries()
    expect(activity).toHaveLength(1)
    expect(activity[0]!.decision).toBe('auto')
    expect(activity[0]!.conversationId).toBe(conversation.id)
  })

  it('partial streamed text is cleared, not concatenated', async () => {
    const primaryId = seedProvider('Primary')
    const fallbackId = seedProvider('Fallback')
    db.settings.update({
      failoverChains: { interactive: [{ providerId: fallbackId, modelId: 'fallback-model' }] },
    })
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Partial',
      providerId: primaryId,
      modelId: 'primary-model',
    })
    const adapter = new ScriptedAdapter(function* (req) {
      if (req.modelId === 'primary-model') {
        yield { type: 'text', text: 'Half an ans' }
        throw new ProviderError('network', 'gone')
      }
      yield { type: 'text', text: 'Whole answer.' }
      yield { type: 'finish', reason: 'stop' }
    })

    const { service, envelopes, done } = makeHarness(adapter)
    await service.send({ conversationId: conversation.id, content: 'Q?' })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    const failover = envelopes.find((e) => e.event.type === 'failover')?.event
    if (failover?.type !== 'failover') throw new Error('expected failover')
    expect(failover.message.content).toBe('')
    expect(doneEnvelope.event.message.content).toBe('Whole answer.')
    expect(doneEnvelope.event.message.content).not.toContain('Half')
  })

  it('auth and invalid_request never fail over', async () => {
    const primaryId = seedProvider('Primary')
    const fallbackId = seedProvider('Fallback')
    db.settings.update({
      failoverChains: { interactive: [{ providerId: fallbackId, modelId: 'fallback-model' }] },
    })
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Auth',
      providerId: primaryId,
      modelId: 'primary-model',
    })
    const adapter = new ScriptedAdapter(function* () {
      throw new ProviderError('auth', 'bad key')
    })

    const { service, done } = makeHarness(adapter)
    await service.send({ conversationId: conversation.id, content: 'Q?' })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'error') throw new Error('expected error')

    expect(doneEnvelope.event.error.code).toBe('auth')
    expect(doneEnvelope.event.message.status).toBe('error')
    expect(doneEnvelope.event.message.failedOverFrom).toBeUndefined()
    expect(adapter.streamRequests).toHaveLength(1)
    expect(failoverActivityEntries()).toHaveLength(0)
  })

  it('stop never fails over', async () => {
    const primaryId = seedProvider('Primary')
    const fallbackId = seedProvider('Fallback')
    db.settings.update({
      failoverChains: { interactive: [{ providerId: fallbackId, modelId: 'fallback-model' }] },
    })
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Stop',
      providerId: primaryId,
      modelId: 'primary-model',
    })

    let streamEntered: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      streamEntered = resolve
    })
    class HangingAdapter extends ScriptedAdapter {
      override async *chatStream(
        req: AdapterChatRequest,
        ctx: AdapterContext
      ): AsyncGenerator<AdapterStreamEvent> {
        this.streamRequests.push(req)
        yield { type: 'text', text: 'partial' }
        streamEntered()
        await new Promise<never>((_, reject) => {
          const abort = (): void => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          }
          if (ctx.signal?.aborted) abort()
          else ctx.signal?.addEventListener('abort', abort, { once: true })
        })
      }
    }
    const adapter = new HangingAdapter()

    const { service, done } = makeHarness(adapter)
    const start = await service.send({ conversationId: conversation.id, content: 'Q?' })
    await entered
    service.stop(start.streamId)
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    expect(doneEnvelope.event.finishReason).toBe('aborted')
    expect(doneEnvelope.event.message.status).toBe('stopped')
    expect(doneEnvelope.event.message.failedOverFrom).toBeUndefined()
    expect(adapter.streamRequests).toHaveLength(1)
    expect(failoverActivityEntries()).toHaveLength(0)
  })

  it('no failover after an executed tool round', async () => {
    const primaryId = seedProvider('Primary')
    const fallbackId = seedProvider('Fallback')
    db.settings.update({
      failoverChains: { interactive: [{ providerId: fallbackId, modelId: 'fallback-model' }] },
    })
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Tool gate',
      providerId: primaryId,
      modelId: 'primary-model',
    })

    const def: ToolDefinition = {
      id: 'fake_tool',
      name: 'fake_tool',
      description: 'test tool',
      parameters: { type: 'object', properties: {} },
      risk: 'safe',
      builtin: true,
      enabled: true,
    }
    const tools: ChatToolSystem = {
      registry: { listEnabledDefinitions: () => [def] },
      executor: { execute: async () => 'ok' },
      broker: { request: async () => ({ approved: true, scope: 'once' as const }) },
    }
    const adapter = new ScriptedAdapter(function* (this: void, req) {
      // Round 2 has the fed-back tool result in the transcript.
      const hasToolRound = req.messages.some((m) => m.role === 'tool')
      if (hasToolRound) throw new ProviderError('server', 'flaked after tools')
      yield {
        type: 'tool_call',
        toolCall: { id: 'call-1', name: 'fake_tool', arguments: '{}', status: 'proposed' },
      }
      yield { type: 'finish', reason: 'tool_calls' }
    })

    const { service, done } = makeHarness(adapter, tools)
    await service.send({ conversationId: conversation.id, content: 'Q?' })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'error') throw new Error('expected error')

    expect(doneEnvelope.event.error.code).toBe('server')
    expect(doneEnvelope.event.message.status).toBe('error')
    expect(doneEnvelope.event.message.failedOverFrom).toBeUndefined()
    // The executed call survived on the persisted message.
    expect(doneEnvelope.event.message.toolCalls?.[0]).toMatchObject({
      id: 'call-1',
      result: 'ok',
      status: 'done',
    })
    expect(failoverActivityEntries()).toHaveLength(0)
  })

  it('empty reply fails over exactly once', async () => {
    const primaryId = seedProvider('Primary')
    const fallbackId = seedProvider('Fallback')
    db.settings.update({
      failoverChains: { interactive: [{ providerId: fallbackId, modelId: 'fallback-model' }] },
    })
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Empty',
      providerId: primaryId,
      modelId: 'primary-model',
    })
    // Every model completes with nothing at all.
    const adapter = new ScriptedAdapter(function* () {
      yield { type: 'finish', reason: 'stop' }
    })

    const { service, done } = makeHarness(adapter)
    await service.send({ conversationId: conversation.id, content: 'Q?' })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    // Exactly one retry — the second empty completion does not walk again.
    expect(adapter.streamRequests).toHaveLength(2)
    expect(doneEnvelope.event.message.content).toBe('')
    expect(doneEnvelope.event.message.status).toBe('complete')
    expect(doneEnvelope.event.message.failedOverFrom).toEqual([
      { providerId: primaryId, modelId: 'primary-model', code: 'empty_reply' },
    ])
  })

  it('unresolvable chain entries are skipped; exhaustion surfaces the last error', async () => {
    const primaryId = seedProvider('Primary')
    const keylessId = seedProvider('Keyless', false)
    const goodId = seedProvider('Good')
    db.settings.update({
      failoverChains: {
        interactive: [
          { providerId: keylessId, modelId: 'keyless-model' },
          { providerId: goodId, modelId: 'good-model' },
        ],
      },
    })
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Skip',
      providerId: primaryId,
      modelId: 'primary-model',
    })
    const adapter = new ScriptedAdapter(function* (req) {
      if (req.modelId !== 'good-model') throw new ProviderError('server', 'down')
      yield { type: 'text', text: 'Good answer.' }
      yield { type: 'finish', reason: 'stop' }
    })

    const { service, done } = makeHarness(adapter)
    await service.send({ conversationId: conversation.id, content: 'Q?' })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    // The keyless entry never reached the adapter — it was skipped at resolve.
    expect(adapter.streamRequests.map((r) => r.modelId)).toEqual(['primary-model', 'good-model'])
    expect(doneEnvelope.event.message.content).toBe('Good answer.')
    expect(doneEnvelope.event.message.failedOverFrom).toEqual([
      { providerId: primaryId, modelId: 'primary-model', code: 'server' },
    ])

    // Exhaustion: a chain whose only entry also fails ends as an error.
    const conversation2 = db.conversations.create({
      mode: 'chat',
      title: 'Exhausted',
      providerId: primaryId,
      modelId: 'primary-model',
    })
    db.settings.update({
      failoverChains: { interactive: [{ providerId: goodId, modelId: 'also-bad-model' }] },
    })
    const adapter2 = new ScriptedAdapter(function* () {
      throw new ProviderError('server', 'everything down')
    })
    const { service: service2, done: done2 } = makeHarness(adapter2)
    await service2.send({ conversationId: conversation2.id, content: 'Q?' })
    const errorEnvelope = await done2
    if (errorEnvelope.event.type !== 'error') throw new Error('expected error')
    expect(errorEnvelope.event.error.code).toBe('server')
    expect(errorEnvelope.event.message.failedOverFrom).toEqual([
      { providerId: primaryId, modelId: 'primary-model', code: 'server' },
    ])
  })
})

describe('Reliability Autopilot — headless funnels', () => {
  it('generateForWorkflow walks the headless chain (activity has no conversation)', async () => {
    const primaryId = seedProvider('Primary')
    const fallbackId = seedProvider('Fallback')
    db.settings.update({
      failoverChains: { headless: [{ providerId: fallbackId, modelId: 'fallback-model' }] },
    })
    const adapter = new ScriptedAdapter(undefined, (req) => {
      if (req.modelId === 'primary-model') throw new ProviderError('rate_limit', 'slow down')
      return { text: 'Fallback answer.', toolCalls: [], finishReason: 'stop' }
    })
    const service = new ChatService(db, () => undefined, { resolveAdapter: () => adapter })

    const text = await service.generateForWorkflow('prompt', primaryId, 'primary-model')
    expect(text).toBe('Fallback answer.')
    expect(adapter.chatRequests.map((r) => r.modelId)).toEqual(['primary-model', 'fallback-model'])

    const activity = failoverActivityEntries()
    expect(activity).toHaveLength(1)
    expect(activity[0]!.conversationId).toBeNull()
    expect(activity[0]!.decision).toBe('auto')
  })

  it('generateHeadless annotates the bridge reply', async () => {
    const primaryId = seedProvider('Primary')
    const fallbackId = seedProvider('Fallback')
    db.settings.update({
      failoverChains: { headless: [{ providerId: fallbackId, modelId: 'fallback-model' }] },
    })
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Bridge',
      providerId: primaryId,
      modelId: 'primary-model',
    })
    const adapter = new ScriptedAdapter(undefined, (req) => {
      if (req.modelId === 'primary-model') throw new ProviderError('server', 'boom')
      return { text: 'Bridge reply.', toolCalls: [], finishReason: 'stop' }
    })
    const service = new ChatService(db, () => undefined, { resolveAdapter: () => adapter })

    const text = await service.generateHeadless(conversation.id, 'ping')
    expect(text).toBe('Bridge reply.')

    const assistant = lastAssistantMessage(conversation.id)
    expect(assistant.content).toBe('Bridge reply.')
    expect(assistant.providerId).toBe(fallbackId)
    expect(assistant.modelId).toBe('fallback-model')
    expect(assistant.failedOverFrom).toEqual([
      { providerId: primaryId, modelId: 'primary-model', code: 'server' },
    ])

    const activity = failoverActivityEntries()
    expect(activity).toHaveLength(1)
    expect(activity[0]!.conversationId).toBe(conversation.id)
  })
})

describe('Reliability Autopilot — persistence and helpers', () => {
  it('failedOverFrom rides usage_json and round-trips with undefined-keeps-value', () => {
    const providerId = seedProvider()
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'RT',
      providerId,
      modelId: 'm',
    })
    const hops = [{ providerId, modelId: 'dead-model', code: 'server' as const }]
    const id = randomUUID()
    db.messages.insert({
      id,
      conversationId: conversation.id,
      role: 'assistant',
      content: 'hi',
      status: 'complete',
      providerId,
      modelId: 'm',
      usage: { promptTokens: 5, completionTokens: 3 },
      failedOverFrom: hops,
      seq: db.messages.nextSeq(conversation.id),
      createdAt: Date.now(),
    })

    // Read-back splits the two halves.
    let stored = lastAssistantMessage(conversation.id)
    expect(stored.usage).toEqual({ promptTokens: 5, completionTokens: 3 })
    expect(stored.failedOverFrom).toEqual(hops)

    // Patching only usage keeps the stored hops…
    db.messages.update(id, { usage: { promptTokens: 9 } })
    stored = lastAssistantMessage(conversation.id)
    expect(stored.usage).toEqual({ promptTokens: 9 })
    expect(stored.failedOverFrom).toEqual(hops)

    // …and patching only hops keeps the stored usage.
    const hops2 = [...hops, { providerId, modelId: 'dead-2', code: 'empty_reply' as const }]
    db.messages.update(id, { failedOverFrom: hops2 })
    stored = lastAssistantMessage(conversation.id)
    expect(stored.usage).toEqual({ promptTokens: 9 })
    expect(stored.failedOverFrom).toEqual(hops2)

    // null clears just its half.
    db.messages.update(id, { failedOverFrom: null })
    stored = lastAssistantMessage(conversation.id)
    expect(stored.usage).toEqual({ promptTokens: 9 })
    expect(stored.failedOverFrom).toBeUndefined()
  })

  it('a failover-only row is excluded from usageSince; legacy rows parse as before', () => {
    const providerId = seedProvider()
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Usage',
      providerId,
      modelId: 'm',
    })
    // Failover-only: hops but no token counts (e.g. an errored fallback walk).
    db.messages.insert({
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'assistant',
      content: '',
      status: 'error',
      providerId,
      modelId: 'm',
      failedOverFrom: [{ providerId, modelId: 'dead', code: 'network' }],
      seq: db.messages.nextSeq(conversation.id),
      createdAt: Date.now(),
    })
    // Legacy shape: bare TokenUsage in usage_json.
    db.messages.insert({
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'assistant',
      content: 'counted',
      status: 'complete',
      providerId,
      modelId: 'm',
      usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
      seq: db.messages.nextSeq(conversation.id),
      createdAt: Date.now(),
    })

    const rows = db.messages.usageSince(0)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.usage.totalTokens).toBe(9)

    const legacy = lastAssistantMessage(conversation.id)
    expect(legacy.usage).toEqual({ promptTokens: 7, completionTokens: 2, totalTokens: 9 })
    expect(legacy.failedOverFrom).toBeUndefined()
  })

  it('nextChainEntry skips attempted pairs; isFailoverEligible is exact', () => {
    const chain = [
      { providerId: 'a', modelId: 'm1' },
      { providerId: 'b', modelId: 'm2' },
    ]
    expect(nextChainEntry(chain, [])).toEqual({ providerId: 'a', modelId: 'm1' })
    expect(nextChainEntry(chain, [{ providerId: 'a', modelId: 'm1' }])).toEqual({
      providerId: 'b',
      modelId: 'm2',
    })
    // Same provider, different model, is a different entry.
    expect(nextChainEntry(chain, [{ providerId: 'a', modelId: 'other' }])).toEqual({
      providerId: 'a',
      modelId: 'm1',
    })
    expect(
      nextChainEntry(chain, [
        { providerId: 'a', modelId: 'm1' },
        { providerId: 'b', modelId: 'm2' },
      ])
    ).toBeNull()
    expect(nextChainEntry(undefined, [])).toBeNull()

    expect([...FAILOVER_ERROR_CODES].sort()).toEqual(['network', 'rate_limit', 'server', 'timeout'])
    expect(isFailoverEligible('rate_limit')).toBe(true)
    expect(isFailoverEligible('server')).toBe(true)
    expect(isFailoverEligible('network')).toBe(true)
    expect(isFailoverEligible('timeout')).toBe(true)
    expect(isFailoverEligible('auth')).toBe(false)
    expect(isFailoverEligible('aborted')).toBe(false)
    expect(isFailoverEligible('invalid_request')).toBe(false)
    expect(isFailoverEligible('context_length')).toBe(false)
    expect(isFailoverEligible('not_supported')).toBe(false)
    expect(isFailoverEligible('unknown')).toBe(false)
  })
})
