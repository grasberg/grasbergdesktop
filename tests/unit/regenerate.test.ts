/**
 * Regenerate over the real db + ChatService (no Electron): plain regenerate
 * reuses the conversation's model, while a one-off override ("regenerate
 * with…") targets the picked model WITHOUT touching the conversation's own
 * model choice — and bypasses a MoA preset, because the user explicitly asked
 * that one model to retry.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  Message,
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
  dir = mkdtempSync(join(tmpdir(), 'uld-regen-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Streams a canned answer; records every stream/chat request it receives. */
class RecordingAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  readonly chatRequests: AdapterChatRequest[] = []
  readonly streamRequests: AdapterChatRequest[] = []

  async chat(req: AdapterChatRequest): Promise<AdapterChatResult> {
    this.chatRequests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
    return { text: `Advisor ${req.modelId}.`, toolCalls: [], finishReason: 'stop' }
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
    yield { type: 'text', text: `Answer from ${req.modelId}.` }
    yield { type: 'finish', reason: 'stop' }
  }

  async listModels(): Promise<ModelInfo[]> {
    return []
  }
  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'ok' }
  }
}

function seedProvider(label = 'Fake'): string {
  const provider = db.providers.create({
    id: randomUUID(),
    type: 'openai-compatible',
    label,
    baseUrl: 'https://fake.example/v1',
    defaultModelId: 'default-model',
    enabled: true,
  })
  db.providers.setKeyRow(
    provider.id,
    'insecure:' + Buffer.from('sk-regen', 'utf8').toString('base64'),
    'sk-…gen'
  )
  return provider.id
}

function insertTurn(conversationId: string): Message {
  const user: Message = {
    id: randomUUID(),
    conversationId,
    role: 'user',
    content: 'Question?',
    status: 'complete',
    seq: db.messages.nextSeq(conversationId),
    createdAt: Date.now(),
  }
  db.messages.insert(user)
  const assistant: Message = {
    id: randomUUID(),
    conversationId,
    role: 'assistant',
    content: 'Weak answer.',
    status: 'complete',
    modelId: 'orig-model',
    seq: db.messages.nextSeq(conversationId),
    createdAt: Date.now(),
  }
  db.messages.insert(assistant)
  return assistant
}

interface Harness {
  service: ChatService
  adapter: RecordingAdapter
  done: Promise<StreamEventEnvelope>
}
function makeHarness(): Harness {
  const adapter = new RecordingAdapter()
  let resolveDone: (env: StreamEventEnvelope) => void = () => undefined
  const done = new Promise<StreamEventEnvelope>((resolve) => {
    resolveDone = resolve
  })
  const service = new ChatService(
    db,
    (channel, payload) => {
      if (channel !== CHANNELS.streamEvent) return
      const envelope = payload as StreamEventEnvelope
      if (envelope.event.type === 'done' || envelope.event.type === 'error') resolveDone(envelope)
    },
    { resolveAdapter: () => adapter }
  )
  return { service, adapter, done }
}

describe('ChatService.regenerate', () => {
  it('reuses the conversation model when no override is given', async () => {
    const providerId = seedProvider()
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Plain',
      providerId,
      modelId: 'orig-model',
    })
    const assistant = insertTurn(conversation.id)

    const { service, adapter, done } = makeHarness()
    await service.regenerate({ conversationId: conversation.id, messageId: assistant.id })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    expect(adapter.streamRequests).toHaveLength(1)
    expect(adapter.streamRequests[0]!.modelId).toBe('orig-model')
    expect(doneEnvelope.event.message.content).toBe('Answer from orig-model.')
  })

  it('uses a one-off override without changing the conversation model', async () => {
    const providerId = seedProvider()
    const challengerProviderId = seedProvider('Challenger')
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Override',
      providerId,
      modelId: 'orig-model',
    })
    const assistant = insertTurn(conversation.id)

    const { service, adapter, done } = makeHarness()
    await service.regenerate({
      conversationId: conversation.id,
      messageId: assistant.id,
      overrides: { providerId: challengerProviderId, modelId: 'challenger-model' },
    })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    // The override reached the adapter…
    expect(adapter.streamRequests).toHaveLength(1)
    expect(adapter.streamRequests[0]!.modelId).toBe('challenger-model')
    // …the replacement message records what actually answered…
    expect(doneEnvelope.event.message.modelId).toBe('challenger-model')
    expect(doneEnvelope.event.message.providerId).toBe(challengerProviderId)
    // …and the conversation's own model choice is untouched.
    const stored = db.conversations.getById(conversation.id)
    expect(stored?.providerId).toBe(providerId)
    expect(stored?.modelId).toBe('orig-model')
  })

  it('a model override bypasses the conversation MoA preset', async () => {
    const providerId = seedProvider()
    const preset: MoaPreset = {
      id: randomUUID(),
      name: 'Panel',
      referenceModels: [
        { providerId, modelId: 'ref-a' },
        { providerId, modelId: 'ref-b' },
      ],
      aggregator: { providerId, modelId: 'agg' },
      enabled: true,
    }
    db.settings.update({ moaPresets: [preset] })
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'MoA',
      providerId,
      modelId: 'orig-model',
      moaPresetId: preset.id,
    })
    const assistant = insertTurn(conversation.id)

    const { service, adapter, done } = makeHarness()
    await service.regenerate({
      conversationId: conversation.id,
      messageId: assistant.id,
      overrides: { providerId, modelId: 'challenger-model' },
    })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    // No advisor fan-out ran — the picked model answered alone.
    expect(adapter.chatRequests).toHaveLength(0)
    expect(adapter.streamRequests).toHaveLength(1)
    expect(adapter.streamRequests[0]!.modelId).toBe('challenger-model')
    expect(doneEnvelope.event.message.moaReferences).toBeUndefined()
  })

  it('second opinion keeps the original answer and streams the challenger beside it', async () => {
    const providerId = seedProvider()
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Second opinion',
      providerId,
      modelId: 'orig-model',
    })
    const assistant = insertTurn(conversation.id)

    const { service, adapter, done } = makeHarness()
    const start = await service.regenerate({
      conversationId: conversation.id,
      messageId: assistant.id,
      overrides: { providerId, modelId: 'challenger-model' },
      mode: 'second-opinion',
    })
    // The SAME message row is converted — no delete, no new id.
    expect(start.assistantMessage.id).toBe(assistant.id)
    expect(start.assistantMessage.compare).toEqual({ pickedIndex: null })

    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')
    const message = doneEnvelope.event.message

    expect(message.status).toBe('complete')
    expect(message.content).toBe('')
    expect(message.compare).toEqual({ pickedIndex: null })
    expect(message.moaReferences).toHaveLength(2)
    // Block 0 = the preserved original; block 1 = the challenger's answer.
    expect(message.moaReferences?.[0]).toMatchObject({
      index: 0,
      status: 'done',
      text: 'Weak answer.',
      modelId: 'orig-model',
    })
    expect(message.moaReferences?.[1]).toMatchObject({
      index: 1,
      status: 'done',
      text: 'Advisor challenger-model.',
      modelId: 'challenger-model',
    })
    // The challenger ran as an advisor (chat), never as a stream.
    expect(adapter.chatRequests).toHaveLength(1)
    expect(adapter.streamRequests).toHaveLength(0)
    // The challenger answered the QUESTION — the original answer (now block 0,
    // status streaming during the run) never leaked into its history.
    const challengerHistory = adapter.chatRequests[0]!.messages
    expect(JSON.stringify(challengerHistory)).not.toContain('Weak answer.')
    expect(challengerHistory[challengerHistory.length - 1]).toMatchObject({
      role: 'user',
      content: 'Question?',
    })
    // The conversation's own model choice is untouched.
    expect(db.conversations.getById(conversation.id)?.modelId).toBe('orig-model')
  })

  it('picking a second-opinion winner promotes it through pickCompareWinner', async () => {
    const providerId = seedProvider()
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Pick',
      providerId,
      modelId: 'orig-model',
    })
    const assistant = insertTurn(conversation.id)

    const { service, done } = makeHarness()
    await service.regenerate({
      conversationId: conversation.id,
      messageId: assistant.id,
      overrides: { providerId, modelId: 'challenger-model' },
      mode: 'second-opinion',
    })
    await done

    // Picking the ORIGINAL restores the answer text exactly.
    const restored = service.pickCompareWinner({
      conversationId: conversation.id,
      messageId: assistant.id,
      referenceIndex: 0,
    })
    expect(restored.message.content).toBe('Weak answer.')
    expect(restored.message.compare).toEqual({ pickedIndex: 0 })
    expect(restored.message.modelId).toBe('orig-model')
  })

  it('second opinion refuses without a model pick and on compare messages', async () => {
    const providerId = seedProvider()
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Guards',
      providerId,
      modelId: 'orig-model',
    })
    const assistant = insertTurn(conversation.id)

    const { service } = makeHarness()
    await expect(
      service.regenerate({
        conversationId: conversation.id,
        messageId: assistant.id,
        mode: 'second-opinion',
      })
    ).rejects.toThrow(/Pick a model/)

    // Convert it once, then a second conversion must refuse.
    const { service: service2, done } = makeHarness()
    await service2.regenerate({
      conversationId: conversation.id,
      messageId: assistant.id,
      overrides: { providerId, modelId: 'challenger-model' },
      mode: 'second-opinion',
    })
    await done
    const { service: service3 } = makeHarness()
    await expect(
      service3.regenerate({
        conversationId: conversation.id,
        messageId: assistant.id,
        overrides: { providerId, modelId: 'other-model' },
        mode: 'second-opinion',
      })
    ).rejects.toThrow(/already a model comparison/)
  })

  it('still refuses to regenerate anything but the last assistant message', async () => {
    const providerId = seedProvider()
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Guard',
      providerId,
      modelId: 'orig-model',
    })
    const assistant = insertTurn(conversation.id)
    // A newer user message makes the assistant message non-last.
    db.messages.insert({
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'user',
      content: 'Follow-up',
      status: 'complete',
      seq: db.messages.nextSeq(conversation.id),
      createdAt: Date.now(),
    })

    const { service } = makeHarness()
    await expect(
      service.regenerate({
        conversationId: conversation.id,
        messageId: assistant.id,
        overrides: { providerId, modelId: 'challenger-model' },
      })
    ).rejects.toThrow(/last message/)
  })
})
