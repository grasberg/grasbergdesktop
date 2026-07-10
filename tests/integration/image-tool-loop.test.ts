/**
 * generate_image end-to-end over the real db + ChatService + real tool
 * system: the model calls the tool, ChatService.generateImage resolves the
 * configured image provider and stores the adapter's bytes on disk, the
 * attachment streams as an 'attachment' event, and the final assistant
 * message persists it (attachments_json round-trip).
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModelInfo, StreamEventEnvelope, TestConnectionResult } from '@shared/types'
import { CHANNELS } from '@shared/ipc'
import { isValidStorageKey } from '@shared/schemas'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import type {
  AdapterChatRequest,
  AdapterContext,
  AdapterGeneratedImage,
  AdapterImageRequest,
  AdapterStreamEvent,
  ProviderAdapter,
} from '../../src/main/providers/adapter'
import { collectStream } from '../../src/main/providers/native'
import { ChatService } from '../../src/main/services/chat-service'
import { createToolSystem } from '../../src/main/tools'

let dir: string
let db: AppDatabase
let imageDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-image-loop-'))
  db = openDatabase(join(dir, 'app.db'))
  imageDir = join(dir, 'attachments')
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

/**
 * Chat side: first round calls generate_image, second round closes with text.
 * Image side: returns fixture PNG bytes for the requested model.
 */
class ImageAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  readonly imageRequests: AdapterImageRequest[] = []

  async *chatStream(
    req: AdapterChatRequest,
    _ctx: AdapterContext
  ): AsyncGenerator<AdapterStreamEvent> {
    const hadToolRound = req.messages.some((m) => m.role === 'tool')
    if (!hadToolRound) {
      yield {
        type: 'tool_call',
        toolCall: {
          id: 'call-img-1',
          name: 'generate_image',
          arguments: JSON.stringify({ prompt: 'a red fox in snow', size: 'square' }),
          status: 'proposed',
        },
      }
      yield { type: 'finish', reason: 'tool_calls' }
      return
    }
    yield { type: 'text', text: 'Here is your fox.' }
    yield { type: 'finish', reason: 'stop' }
  }

  async chat(req: AdapterChatRequest, ctx: AdapterContext) {
    return collectStream(this.chatStream(req, ctx))
  }

  async generateImage(
    req: AdapterImageRequest,
    _ctx: AdapterContext
  ): Promise<AdapterGeneratedImage[]> {
    this.imageRequests.push(req)
    return [{ bytes: new Uint8Array(PNG_BYTES), mimeType: 'image/png' }]
  }

  async listModels(): Promise<ModelInfo[]> {
    return []
  }
  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'ok' }
  }
}

describe('ChatService — generate_image tool loop', () => {
  it('generates, streams the attachment event, persists and writes the file', async () => {
    // Chat provider + a separate configured image provider (both fake).
    const provider = db.providers.create({
      id: randomUUID(),
      type: 'openai-compatible',
      label: 'Fake',
      baseUrl: 'https://fake.example/v1',
      defaultModelId: 'chat-model',
      enabled: true,
    })
    db.providers.setKeyRow(
      provider.id,
      'insecure:' + Buffer.from('sk-img', 'utf8').toString('base64'),
      'sk-…img'
    )
    db.settings.update({
      defaultImageProviderId: provider.id,
      defaultImageModelId: 'img-model',
    })
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'Fox',
      providerId: provider.id,
      modelId: 'chat-model',
    })

    const adapter = new ImageAdapter()
    const envelopes: StreamEventEnvelope[] = []
    let resolveDone: (env: StreamEventEnvelope) => void = () => undefined
    const done = new Promise<StreamEventEnvelope>((resolve) => {
      resolveDone = resolve
    })

    // The tool system's generate is wired to the real ChatService.generateImage
    // (declared before the service exists — main/index.ts does the same).
    let service: ChatService | null = null
    const toolSystem = createToolSystem(db, null, {
      imageGeneration: {
        generate: (req) =>
          service
            ? service.generateImage(req)
            : Promise.reject(new Error('unavailable during startup')),
      },
    })

    service = new ChatService(
      db,
      (channel, payload) => {
        if (channel !== CHANNELS.streamEvent) return
        const envelope = payload as StreamEventEnvelope
        envelopes.push(envelope)
        if (envelope.event.type === 'done' || envelope.event.type === 'error') {
          resolveDone(envelope)
        }
      },
      {
        resolveAdapter: () => adapter,
        imageDir,
        tools: {
          registry: toolSystem.registry,
          executor: toolSystem.executor,
          broker: { request: async () => ({ approved: true, scope: 'once' as const }) },
        },
      }
    )

    await service.send({ conversationId: conversation.id, content: 'draw me a fox' })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') {
      throw new Error(`expected done, got error: ${JSON.stringify(doneEnvelope.event)}`)
    }

    // The adapter was asked with the configured image model + size.
    expect(adapter.imageRequests).toEqual([
      { modelId: 'img-model', prompt: 'a red fox in snow', count: 1, size: 'square' },
    ])

    // The attachment streamed live and carries generation metadata.
    const attachmentEvents = envelopes
      .map((e) => e.event)
      .filter((e): e is Extract<typeof e, { type: 'attachment' }> => e.type === 'attachment')
    expect(attachmentEvents).toHaveLength(1)
    const streamed = attachmentEvents[0].attachment
    expect(streamed.kind).toBe('image')
    expect(streamed.generatedBy).toEqual({ modelId: 'img-model', size: 'square' })
    expect(streamed.storageKey && isValidStorageKey(streamed.storageKey)).toBe(true)

    // The bytes landed on disk under the attachments dir.
    expect(existsSync(join(imageDir, streamed.storageKey as string))).toBe(true)

    // The final message persists the attachment + the closing text, and the
    // tool result told the model the image is already visible.
    const finalMessage = doneEnvelope.event.message
    expect(finalMessage.status).toBe('complete')
    expect(finalMessage.content).toContain('Here is your fox.')
    expect(finalMessage.attachments).toHaveLength(1)
    expect(finalMessage.toolCalls?.[0]?.result).toContain('Generated 1 image')

    // attachments_json round-trips through the repository.
    const stored = db.messages.listByConversation(conversation.id)
    const storedFinal = stored[stored.length - 1]
    expect(storedFinal.attachments?.[0]?.storageKey).toBe(streamed.storageKey)
  })

  it('a provider without generateImage yields a friendly not-supported tool result', async () => {
    const provider = db.providers.create({
      id: randomUUID(),
      type: 'openai-compatible',
      label: 'Fake',
      baseUrl: 'https://fake.example/v1',
      defaultModelId: 'chat-model',
      enabled: true,
    })
    db.providers.setKeyRow(
      provider.id,
      'insecure:' + Buffer.from('sk-img', 'utf8').toString('base64'),
      'sk-…img'
    )
    db.settings.update({
      defaultImageProviderId: provider.id,
      defaultImageModelId: 'img-model',
    })
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'NoImg',
      providerId: provider.id,
      modelId: 'chat-model',
    })

    // Same chat behaviour, but no generateImage on the adapter at all.
    const adapter = new ImageAdapter()
    ;(adapter as { generateImage?: unknown }).generateImage = undefined

    const envelopes: StreamEventEnvelope[] = []
    let resolveDone: (env: StreamEventEnvelope) => void = () => undefined
    const done = new Promise<StreamEventEnvelope>((resolve) => {
      resolveDone = resolve
    })
    let service: ChatService | null = null
    const toolSystem = createToolSystem(db, null, {
      imageGeneration: {
        generate: (req) =>
          service ? service.generateImage(req) : Promise.reject(new Error('unavailable')),
      },
    })
    service = new ChatService(
      db,
      (channel, payload) => {
        if (channel !== CHANNELS.streamEvent) return
        const envelope = payload as StreamEventEnvelope
        envelopes.push(envelope)
        if (envelope.event.type === 'done' || envelope.event.type === 'error') {
          resolveDone(envelope)
        }
      },
      {
        resolveAdapter: () => adapter,
        imageDir,
        tools: {
          registry: toolSystem.registry,
          executor: toolSystem.executor,
          broker: { request: async () => ({ approved: true, scope: 'once' as const }) },
        },
      }
    )

    await service.send({ conversationId: conversation.id, content: 'draw' })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    const result = doneEnvelope.event.message.toolCalls?.[0]?.result ?? ''
    expect(result).toContain('Image generation failed')
    expect(result).toContain('cannot generate images')
    expect(doneEnvelope.event.message.attachments).toBeUndefined()
  })
})
