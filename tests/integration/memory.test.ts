/**
 * Memory end-to-end over the real db + ChatService. When memoryEnabled (the
 * default), saved memories ride into the streamed system prompt and
 * ```uld-memory blocks in the assistant's reply are persisted by the memory
 * completion hook (upsert by title; forget deletes). When disabled, no memory
 * text reaches the wire and emitted blocks are ignored.
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
import {
  clearCompletionHooks,
  registerCompletionHook,
} from '../../src/main/services/completion-hooks'
import { createMemoryCompletionHook } from '../../src/main/services/memory-hook'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-memory-'))
  db = openDatabase(join(dir, 'app.db'))
  registerCompletionHook(createMemoryCompletionHook(db))
})

afterEach(() => {
  clearCompletionHooks()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Streams a canned reply and records every request it saw. */
class MemoryAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  readonly invocations: AdapterChatRequest[] = []
  constructor(private readonly reply: () => string) {}

  async *chatStream(req: AdapterChatRequest): AsyncGenerator<AdapterStreamEvent> {
    this.invocations.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
    yield { type: 'text', text: this.reply() }
    yield { type: 'finish', reason: 'stop' }
  }

  async chat(): Promise<AdapterChatResult> {
    return { text: '', toolCalls: [], finishReason: 'stop' }
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
    label: 'Fake',
    baseUrl: 'https://fake.example/v1',
    defaultModelId: 'fake-model',
    enabled: true,
  })
  db.providers.setKeyRow(
    provider.id,
    'insecure:' + Buffer.from('sk-memory', 'utf8').toString('base64'),
    'sk-…mem'
  )
  return db.conversations.create({
    mode: 'chat',
    title: 'Memory chat',
    providerId: provider.id,
    modelId: 'fake-model',
  })
}

/** Sends one user message and resolves when the stream finishes. */
async function runTurn(adapter: MemoryAdapter, conversationId: string, content: string): Promise<void> {
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
  await service.send({ conversationId, content })
  await done
}

function systemPromptOf(req: AdapterChatRequest): string {
  const system = req.messages.find((m) => m.role === 'system')
  return typeof system?.content === 'string' ? system.content : ''
}

const rememberBlock = (title: string, body: string): string =>
  ['```uld-memory', `{"title":"${title}","action":"remember"}`, body, '```'].join('\n')

describe('memory system end-to-end', () => {
  it('injects saved memories and instructions into the wire system prompt by default', async () => {
    const conversation = seedConversation()
    db.memories.create({ title: 'preferred-language', content: 'Prefers Swedish.' })
    const adapter = new MemoryAdapter(() => 'Hej!')

    await runTurn(adapter, conversation.id, 'hello')

    const system = systemPromptOf(adapter.invocations[0])
    expect(system).toContain('uld-memory')
    expect(system).toContain('- "preferred-language": Prefers Swedish.')
  })

  it('persists remember blocks (upsert by title, any casing) and deletes on forget', async () => {
    const conversation = seedConversation()

    // Turn 1: the assistant saves a memory.
    const save = new MemoryAdapter(() =>
      `Noted!\n\n${rememberBlock('user-role', 'Backend developer at Acme.')}`
    )
    await runTurn(save, conversation.id, 'I am a backend developer at Acme')
    let memories = db.memories.list()
    expect(memories).toHaveLength(1)
    expect(memories[0].title).toBe('user-role')
    expect(memories[0].content).toBe('Backend developer at Acme.')
    expect(memories[0].sourceConversationId).toBe(conversation.id)

    // Turn 2: same title in different casing updates instead of duplicating.
    const update = new MemoryAdapter(() =>
      `Updated.\n\n${rememberBlock('User-Role', 'Staff engineer at Acme.')}`
    )
    await runTurn(update, conversation.id, 'I got promoted to staff engineer')
    memories = db.memories.list()
    expect(memories).toHaveLength(1)
    expect(memories[0].content).toBe('Staff engineer at Acme.')

    // Turn 3: forget deletes it.
    const forget = new MemoryAdapter(() =>
      ['Forgotten.', '```uld-memory', '{"title":"user-role","action":"forget"}', '```'].join('\n')
    )
    await runTurn(forget, conversation.id, 'forget my role')
    expect(db.memories.list()).toHaveLength(0)
  })

  it('when disabled: no memory text on the wire and emitted blocks are not persisted', async () => {
    const conversation = seedConversation()
    db.memories.create({ title: 'stale', content: 'Should not appear.' })
    db.settings.update({ memoryEnabled: false })

    const adapter = new MemoryAdapter(() =>
      `Trying anyway.\n\n${rememberBlock('sneaky', 'Should not be saved.')}`
    )
    await runTurn(adapter, conversation.id, 'hello')

    const system = systemPromptOf(adapter.invocations[0])
    expect(system).not.toContain('uld-memory')
    expect(system).not.toContain('Should not appear.')
    // The emitted block was ignored; only the pre-existing memory remains.
    expect(db.memories.list().map((m) => m.title)).toEqual(['stale'])
  })
})
