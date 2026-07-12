/**
 * Stop during the PENDING reservation phase: a send reserves the conversation's
 * single-generation slot BEFORE resolveTarget's async work (an OAuth token
 * refresh can hit the network). The reservation carries the generation's
 * AbortController, so a Stop issued while the token is still resolving is not
 * dropped — the generation aborts as soon as it reaches the adapter.
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
  AdapterContext,
  AdapterStreamEvent,
  ProviderAdapter,
} from '../../src/main/providers/adapter'
import { ChatService } from '../../src/main/services/chat-service'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-stop-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Streams text only when its signal is clear; honours abort like the real ones. */
class AbortAwareAdapter implements ProviderAdapter {
  readonly type = 'openai' as const
  streamed = 0

  async *chatStream(
    _req: AdapterChatRequest,
    ctx: AdapterContext
  ): AsyncGenerator<AdapterStreamEvent> {
    if (ctx.signal?.aborted) throw new Error('The operation was aborted.')
    this.streamed += 1
    yield { type: 'text', text: 'Hello.' }
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

function seed(): Conversation {
  const provider = db.providers.create({
    id: randomUUID(),
    type: 'openai',
    label: 'ChatGPT',
    baseUrl: 'https://chatgpt.example/v1',
    defaultModelId: 'gpt-5.5',
    enabled: true,
    authMode: 'chatgpt_oauth',
  })
  return db.conversations.create({
    mode: 'chat',
    title: 'OAuth',
    providerId: provider.id,
    modelId: 'gpt-5.5',
  })
}

describe('ChatService stop during the pending reservation', () => {
  it('aborts a send whose OAuth token refresh is still in flight', async () => {
    const conversation = seed()
    const adapter = new AbortAwareAdapter()

    // The token refresh hangs: the send is parked in the PENDING phase, which
    // is exactly where Stop used to be a no-op.
    let releaseToken: () => void = () => undefined
    const tokenGate = new Promise<void>((resolve) => {
      releaseToken = resolve
    })

    let resolveDone: (env: StreamEventEnvelope) => void = () => undefined
    const done = new Promise<StreamEventEnvelope>((resolve) => {
      resolveDone = resolve
    })
    const service = new ChatService(
      db,
      (channel, payload) => {
        if (channel !== CHANNELS.streamEvent) return
        const envelope = payload as StreamEventEnvelope
        if (envelope.event.type === 'done' || envelope.event.type === 'error') {
          resolveDone(envelope)
        }
      },
      {
        resolveAdapter: () => adapter,
        getAccessToken: async () => {
          await tokenGate
          return { accessToken: 'oauth-token', accountId: 'acct' }
        },
      }
    )

    const sent = service.send({ conversationId: conversation.id, content: 'hi' })
    // No stream registered yet — only the reservation exists.
    service.stopConversation(conversation.id)
    releaseToken()
    await sent

    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done event')
    expect(doneEnvelope.event.finishReason).toBe('aborted')
    expect(doneEnvelope.event.message.status).toBe('stopped')
    // The provider was never actually called.
    expect(adapter.streamed).toBe(0)

    // The slot is free again: the conversation is not locked.
    await expect(
      service.send({ conversationId: conversation.id, content: 'retry' })
    ).resolves.toBeTruthy()
  })

  it('a stop during a HUNG token refresh unblocks the send and frees the slot', async () => {
    const conversation = seed()
    const adapter = new AbortAwareAdapter()

    let resolveDone: (env: StreamEventEnvelope) => void = () => undefined
    const done = new Promise<StreamEventEnvelope>((resolve) => {
      resolveDone = resolve
    })

    let call = 0
    const service = new ChatService(
      db,
      (channel, payload) => {
        if (channel !== CHANNELS.streamEvent) return
        const envelope = payload as StreamEventEnvelope
        if (envelope.event.type === 'done' || envelope.event.type === 'error') {
          resolveDone(envelope)
        }
      },
      {
        resolveAdapter: () => adapter,
        // First call: the token endpoint hangs and only ever settles when the
        // caller's Stop aborts the signal. Before the fix the reservation's
        // signal was not threaded into getAccessToken, so this awaited forever
        // and the conversation stayed locked (PENDING) indefinitely.
        getAccessToken: (_providerId, signal) => {
          call += 1
          if (call === 1) {
            return new Promise((_resolve, reject) => {
              if (signal?.aborted) return reject(new Error('The operation was aborted.'))
              signal?.addEventListener(
                'abort',
                () => reject(new Error('The operation was aborted.')),
                { once: true }
              )
            })
          }
          return Promise.resolve({ accessToken: 'oauth-token', accountId: 'acct' })
        },
      }
    )

    const sent = service.send({ conversationId: conversation.id, content: 'hi' })
    // No stream registered yet — the send is parked awaiting the hung token.
    service.stopConversation(conversation.id)
    await expect(sent).rejects.toThrow()
    // The provider was never reached — the abort landed in the pending phase.
    expect(adapter.streamed).toBe(0)

    // The slot is free: a fresh send is accepted (it would throw "already
    // streaming" had the hung generation never released the reservation).
    await expect(
      service.send({ conversationId: conversation.id, content: 'retry' })
    ).resolves.toBeTruthy()
    // Let the retry's stream finish so afterEach can close the db cleanly.
    await done
  })
})
