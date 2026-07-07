import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, Message } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import { ImBridgeManager } from '../../../src/main/im/manager'

let dir: string
let db: AppDatabase

const keystore = {
  encryptKey: (v: string) => ({ encryptedBase64: `x:${Buffer.from(v).toString('base64')}`, preview: '…' }),
  decryptKey: (s: string) => Buffer.from(s.slice(2), 'base64').toString('utf8'),
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-im-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function conv(): Conversation {
  return db.conversations.create({ mode: 'chat', title: 'Bridge chat' })
}

describe('ImBridgeManager', () => {
  it('stores the Telegram token encrypted and reports status (token never returned)', () => {
    const manager = new ImBridgeManager({
      db,
      keystore,
      generateReply: async () => 'ok',
    })
    // enabled:false so no poll loop starts in the test.
    const status = manager.setTelegram({ token: 'secret-bot-token', conversationId: 'c1', enabled: false })
    expect(status.hasToken).toBe(true)
    expect(status.telegramEnabled).toBe(false)
    expect(status.telegramConversationId).toBe('c1')
    // The stored value is ciphertext, not the plaintext token.
    const ciphers = db.secrets.listCiphers('im_bridge', 'telegram')
    expect(ciphers[0].encryptedValue).not.toContain('secret-bot-token')
    // Status never carries the token itself.
    expect(JSON.stringify(status)).not.toContain('secret-bot-token')
  })

  it('posts to the outbound webhook on an assistant completion', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok'))
    const manager = new ImBridgeManager({
      db,
      keystore,
      generateReply: async () => 'ok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    manager.setWebhook('https://hook.example/incoming')

    const conversation = conv()
    const message: Message = {
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Hello from the assistant',
      status: 'complete',
      seq: 1,
      createdAt: 0,
    }
    await manager.onCompletion(conversation, message)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://hook.example/incoming')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toMatchObject({
      type: 'assistant_message',
      conversationId: conversation.id,
      content: 'Hello from the assistant',
    })
  })

  it('pairs the first sender only with the one-time code and refuses everyone else', async () => {
    const generateReply = vi.fn(async () => 'reply')
    const manager = new ImBridgeManager({ db, keystore, generateReply })
    const conversation = conv()
    // Enable the bridge to provision a pairing code (enabled:false in setTelegram
    // would not need one; use enabled:true, poll loop is skipped under SMOKE, but
    // here we call handleInbound directly regardless).
    const status = manager.setTelegram({
      token: 'bot-token',
      conversationId: conversation.id,
      enabled: true,
    })
    const code = status.telegramPairingCode
    expect(code).toMatch(/^\d{6}$/)

    // Reach the private inbound handler without starting the poll loop.
    const inbound = (chatId: number, text: string): Promise<string> =>
      (
        manager as unknown as {
          handleInbound(chatId: number, text: string, conversationId: string): Promise<string>
        }
      ).handleInbound(chatId, text, conversation.id)

    // A stranger who does not know the code cannot pair and is never forwarded.
    const wrong = await inbound(999, 'let me in')
    expect(wrong).toMatch(/pairing code/i)
    expect(db.settings.get().telegramBridgeAllowedChatId).toBeNull()
    expect(generateReply).not.toHaveBeenCalled()

    // The owner echoes the code: their chat is pinned, code is consumed, and the
    // pairing message is acked (not forwarded to the model).
    const linked = await inbound(100, code!)
    expect(linked).toMatch(/linked/i)
    expect(db.settings.get().telegramBridgeAllowedChatId).toBe(100)
    expect(db.settings.get().telegramBridgePairingCode).toBeNull()
    expect(generateReply).not.toHaveBeenCalled()

    // The paired chat now works; other chats stay refused.
    expect(await inbound(100, 'hi')).toBe('reply')
    expect(generateReply).toHaveBeenCalledTimes(1)
    const refusal = await inbound(200, 'hi')
    expect(refusal).toMatch(/private/i)
    expect(generateReply).toHaveBeenCalledTimes(1)
  })

  it('drops the pinned chat and issues a new pairing code when a new bot token is set', () => {
    const manager = new ImBridgeManager({ db, keystore, generateReply: async () => 'ok' })
    db.settings.update({ telegramBridgeAllowedChatId: 100 })
    const status = manager.setTelegram({ token: 'new-token', conversationId: 'c1', enabled: true })
    expect(db.settings.get().telegramBridgeAllowedChatId).toBeNull()
    expect(status.telegramPairingCode).toMatch(/^\d{6}$/)
  })

  it('does not post when no webhook is configured or for non-assistant messages', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok'))
    const manager = new ImBridgeManager({
      db,
      keystore,
      generateReply: async () => 'ok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const conversation = conv()
    const userMsg: Message = {
      id: 'u',
      conversationId: conversation.id,
      role: 'user',
      content: 'hi',
      status: 'complete',
      seq: 1,
      createdAt: 0,
    }
    await manager.onCompletion(conversation, userMsg) // no webhook set + user role
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
