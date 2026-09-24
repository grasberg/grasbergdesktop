import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { ChatService } from '../../src/main/services/chat-service'
import type { ProviderAdapter } from '../../src/main/providers/adapter'

let dir: string
let db: AppDatabase
let service: ChatService
let calls: number
const adapter: ProviderAdapter = {
  type: 'openai-compatible',
  async chat() { return { text: 'Done', toolCalls: [], finishReason: 'stop' } },
  async *chatStream() { calls++; yield { type: 'text', text: 'Done' }; yield { type: 'finish', reason: 'stop' } },
  async listModels() { return [] },
  async testConnection() { return { ok: true, message: 'ok' } },
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grasberg-ack-'))
  db = openDatabase(join(dir, 'test.sqlite'))
  const p = db.providers.create({ id: 'p', type: 'openai-compatible', label: 'test', baseUrl: 'https://example.test/v1', defaultModelId: 'm', enabled: true })
  db.providers.setKeyRow(p.id, 'insecure:' + Buffer.from('fake-test-key').toString('base64'), 'test')
  db.settings.update({ defaultProviderId: p.id, defaultModelId: 'm' })
  calls = 0
  service = new ChatService(db, () => {}, { resolveAdapter: () => adapter })
})
afterEach(async () => { await service.stopAll(); db.close(); rmSync(dir, { recursive: true, force: true }) })

it('concurrent retries persist one user message and invoke the provider only once', async () => {
  const conv = db.conversations.create({ mode: 'chat', title: 'test' })
  const req = { conversationId: conv.id, content: 'hello', clientRequestId: randomUUID() }
  const [first, second] = await Promise.all([service.sendIdempotent(req), service.sendIdempotent(req)])
  expect(second).toEqual(first)
  await new Promise(r => setTimeout(r, 20))
  expect(db.messages.listByConversation(conv.id).filter(m => m.role === 'user')).toHaveLength(1)
  expect(calls).toBe(1)
  await expect(service.sendIdempotent({ ...req, content: 'different' })).rejects.toThrow('already used')
})

it('replays the durable acknowledgment after reopening the database', async () => {
  const conv = db.conversations.create({ mode: 'chat', title: 'test' })
  const req = { conversationId: conv.id, content: 'hello', clientRequestId: randomUUID() }
  const first = await service.sendIdempotent(req)
  await new Promise(r => setTimeout(r, 20))
  await service.stopAll(); db.close()
  db = openDatabase(join(dir, 'test.sqlite'))
  service = new ChatService(db, () => {}, { resolveAdapter: () => adapter })
  expect(await service.sendIdempotent(req)).toEqual({ queued: true, replayed: true, userMessage: first.userMessage })
  expect(calls).toBe(1)
})

it('allows the same request to retry when validation failed before persistence', async () => {
  const conv = db.conversations.create({ mode: 'chat', title: 'test', providerId: 'missing', modelId: 'm' })
  const req = { conversationId: conv.id, content: 'hello', clientRequestId: randomUUID() }
  await expect(service.sendIdempotent(req)).rejects.toThrow()
  db.conversations.update(conv.id, { providerId: 'p' })
  await expect(service.sendIdempotent(req)).resolves.toHaveProperty('userMessage')
  expect(db.messages.listByConversation(conv.id).filter(m => m.role === 'user')).toHaveLength(1)
})
