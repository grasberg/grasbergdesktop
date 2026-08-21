/**
 * Keyless loopback providers (Ollama, LM Studio, …) over the real db +
 * ChatService: a provider WITHOUT a stored key generates fine when its base
 * URL is a loopback host (placeholder bearer 'local'), and is refused with
 * the normal auth error everywhere else — the placeholder must never travel
 * to a remote endpoint.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModelInfo, StreamEventEnvelope, TestConnectionResult } from '@shared/types'
import { CHANNELS } from '@shared/ipc'
import { isLoopbackBaseUrl } from '@shared/schemas'
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
  dir = mkdtempSync(join(tmpdir(), 'uld-keyless-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Records the AdapterContext of every stream so tests can inspect the key. */
class CtxRecordingAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  readonly contexts: AdapterContext[] = []

  async chat(_req: AdapterChatRequest, ctx: AdapterContext): Promise<AdapterChatResult> {
    this.contexts.push(ctx)
    return { text: 'ok', toolCalls: [], finishReason: 'stop' }
  }

  async *chatStream(
    _req: AdapterChatRequest,
    ctx: AdapterContext
  ): AsyncGenerator<AdapterStreamEvent> {
    this.contexts.push(ctx)
    yield { type: 'text', text: 'Local answer.' }
    yield { type: 'finish', reason: 'stop' }
  }

  async listModels(): Promise<ModelInfo[]> {
    return []
  }
  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'ok' }
  }
}

function seedKeylessProvider(baseUrl: string): string {
  const provider = db.providers.create({
    id: randomUUID(),
    type: 'openai-compatible',
    label: 'Local',
    baseUrl,
    defaultModelId: 'llama3.2',
    enabled: true,
  })
  // Deliberately NO setKeyRow — the provider has no stored key.
  return provider.id
}

function makeHarness(): {
  service: ChatService
  adapter: CtxRecordingAdapter
  done: Promise<StreamEventEnvelope>
} {
  const adapter = new CtxRecordingAdapter()
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

describe('keyless loopback providers', () => {
  it('generates against a keyless localhost provider with the placeholder bearer', async () => {
    const providerId = seedKeylessProvider('http://localhost:11434/v1')
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Local',
      providerId,
      modelId: 'llama3.2',
    })

    const { service, adapter, done } = makeHarness()
    await service.send({ conversationId: conversation.id, content: 'Hi' })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    expect(doneEnvelope.event.message.content).toBe('Local answer.')
    // The placeholder bearer went only to the provider's own loopback URL.
    expect(adapter.contexts).toHaveLength(1)
    expect(adapter.contexts[0]!.apiKey).toBe('local')
    expect(isLoopbackBaseUrl(adapter.contexts[0]!.baseUrl)).toBe(true)
  })

  it('refuses a keyless provider whose base URL is NOT loopback', async () => {
    const providerId = seedKeylessProvider('https://api.example.com/v1')
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Remote',
      providerId,
      modelId: 'some-model',
    })

    const { service, adapter } = makeHarness()
    await expect(
      service.send({ conversationId: conversation.id, content: 'Hi' })
    ).rejects.toThrow(/No API key configured/)
    // Nothing ever reached the adapter — no placeholder leaked.
    expect(adapter.contexts).toHaveLength(0)
  })
})

describe('isLoopbackBaseUrl', () => {
  it('accepts loopback hosts over http and https only', () => {
    expect(isLoopbackBaseUrl('http://localhost:11434/v1')).toBe(true)
    expect(isLoopbackBaseUrl('http://127.0.0.1:1234/v1')).toBe(true)
    expect(isLoopbackBaseUrl('http://[::1]:8080/v1')).toBe(true)
    expect(isLoopbackBaseUrl('https://localhost/v1')).toBe(true)
  })

  it('rejects remote hosts, lookalikes and junk', () => {
    expect(isLoopbackBaseUrl('https://api.example.com/v1')).toBe(false)
    expect(isLoopbackBaseUrl('http://localhost.evil.com/v1')).toBe(false)
    expect(isLoopbackBaseUrl('http://192.168.1.10:11434/v1')).toBe(false)
    expect(isLoopbackBaseUrl('file:///etc/passwd')).toBe(false)
    expect(isLoopbackBaseUrl('')).toBe(false)
    expect(isLoopbackBaseUrl(null)).toBe(false)
    expect(isLoopbackBaseUrl(undefined)).toBe(false)
    expect(isLoopbackBaseUrl('not a url')).toBe(false)
  })
})
