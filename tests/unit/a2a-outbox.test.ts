/**
 * Durable bot-to-bot deliveries (v48): the a2a_outbox repository, the
 * outbox-backed delivery pump in BotService (FIFO per target, retry budget,
 * failure paths, maintenance drain, cleanup on delete) and — the reason the
 * table exists — recovery after an app restart.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, MessageStatus } from '../../src/shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { BotService, type BotChatService } from '../../src/main/services/bots'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-a2a-outbox-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  vi.useRealTimers()
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface ChatOptions {
  /** The target chat reports busy (pump defers). */
  active?: boolean
  /** Status the persisted assistant row gets (default 'complete'). */
  assistantStatus?: MessageStatus
  reply?: string
  /** Thrown by the next send() call, once. */
  throwOnce?: unknown
}

interface FakeChat extends BotChatService {
  sends: Array<{ conversationId: string; content: string }>
  opts: ChatOptions
}

/** Persists the turn like the real pipeline: user row + assistant row. */
function makeChat(opts: ChatOptions = {}): FakeChat {
  const fake: FakeChat = {
    sends: [],
    opts,
    async send({ conversationId, content }) {
      if (fake.opts.throwOnce !== undefined) {
        const error = fake.opts.throwOnce
        fake.opts.throwOnce = undefined
        throw error
      }
      fake.sends.push({ conversationId, content })
      const now = Date.now()
      const userMessage: Message = {
        id: randomUUID(),
        conversationId,
        role: 'user',
        content,
        status: 'complete',
        seq: db.messages.nextSeq(conversationId),
        createdAt: now,
      }
      db.messages.insert(userMessage)
      const assistantMessage: Message = {
        id: randomUUID(),
        conversationId,
        role: 'assistant',
        content: fake.opts.reply ?? 'Looks good, ship it.',
        status: fake.opts.assistantStatus ?? 'complete',
        seq: db.messages.nextSeq(conversationId),
        createdAt: now,
      }
      db.messages.insert(assistantMessage)
      return { userMessage, assistantMessage }
    },
    isConversationActive: () => fake.opts.active === true,
    async compactNow() {
      return { compacted: false }
    },
    async generateForWorkflow() {
      return 'PASS'
    },
  }
  return fake
}

function makeService(chat: BotChatService): {
  service: BotService
  notifications: Array<{ title: string; status: string }>
} {
  const notifications: Array<{ title: string; status: string }> = []
  const service = new BotService({
    db,
    chat,
    broadcast: () => undefined,
    notify: ({ title, status }) => notifications.push({ title, status }),
  })
  return { service, notifications }
}

function seedPair(): { scout: string; editor: string } {
  const scout = db.agents.create({ name: 'Scout', systemPrompt: 'p' })
  const editor = db.agents.create({ name: 'Editor', systemPrompt: 'p' })
  return { scout: scout.id, editor: editor.id }
}

function inFlightOf(service: BotService): Map<string, { assistantMessageId: string }> {
  return (service as unknown as { inFlight: Map<string, { assistantMessageId: string }> }).inFlight
}

function editorChatId(editor: string): string {
  return db.agents.getById(editor)!.chatConversationId!
}

/** Completes the target's in-flight turn through the hook, like the chat service does. */
function completeTurn(service: BotService, targetChatId: string): void {
  const conversation = db.conversations.getById(targetChatId)!
  const assistant = db.messages
    .listByConversation(targetChatId)
    .filter((m) => m.role === 'assistant')
    .at(-1)!
  service.handleCompletion(conversation, assistant)
}

/** A user turn (not a delivery) finishing in the target chat: the hook only pumps. */
function completeUserTurn(service: BotService, targetChatId: string): void {
  service.handleCompletion(db.conversations.getById(targetChatId)!, {
    id: `user-turn-${randomUUID()}`,
    conversationId: targetChatId,
    role: 'assistant',
    content: 'done',
    status: 'complete',
    seq: 0,
    createdAt: Date.now(),
  })
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe('a2a_outbox repository', () => {
  it('round-trips a queued row and serves targets strictly FIFO', () => {
    const first = db.a2aOutbox.insert({
      id: 'r1',
      fromAgentId: 'a',
      toAgentId: 'b',
      conversationId: 'c',
      body: 'one',
      hop: 1,
    })
    db.a2aOutbox.insert({ id: 'r2', fromAgentId: 'a', toAgentId: 'b', conversationId: 'c', body: 'two', hop: 2 })
    db.a2aOutbox.insert({ id: 'r3', fromAgentId: null, toAgentId: 'z', conversationId: null, body: 'ev', hop: 1 })
    expect(first.status).toBe('queued')
    expect(first.attempts).toBe(0)
    expect(first.targetConversationId).toBeNull()
    expect(first.deliveredAt).toBeNull()
    expect(db.a2aOutbox.nextQueued('b')!.id).toBe('r1')
    expect(db.a2aOutbox.countQueued('b')).toBe(2)
    expect(db.a2aOutbox.queuedTargets().sort()).toEqual(['b', 'z'])
    expect(db.a2aOutbox.getById('r3')!.fromAgentId).toBeNull()
  })

  it('tracks the lifecycle: delivered → replied / failed, requeue, cancel, prune', () => {
    db.a2aOutbox.insert({ id: 'r1', fromAgentId: 'a', toAgentId: 'b', conversationId: 'c', body: 'x', hop: 1 })
    db.a2aOutbox.markDelivered('r1', { targetConversationId: 'tc', assistantMessageId: 'am' })
    let row = db.a2aOutbox.getById('r1')!
    expect(row.status).toBe('delivered')
    expect(row.attempts).toBe(1)
    expect(row.deliveredAt).not.toBeNull()
    expect(db.a2aOutbox.inFlightFor('tc')!.id).toBe('r1')
    expect(db.a2aOutbox.nextQueued('b')).toBeNull()

    db.a2aOutbox.requeue('r1')
    row = db.a2aOutbox.getById('r1')!
    expect(row.status).toBe('queued')
    expect(row.assistantMessageId).toBeNull()
    expect(row.attempts).toBe(1) // a requeue does not forgive the attempt already made
    expect(db.a2aOutbox.inFlightFor('tc')).toBeNull()

    db.a2aOutbox.markDelivered('r1', { targetConversationId: 'tc', assistantMessageId: 'am2' })
    db.a2aOutbox.markReplied('r1')
    expect(db.a2aOutbox.getById('r1')!.status).toBe('replied')
    expect(db.a2aOutbox.listOpen()).toHaveLength(0)

    db.a2aOutbox.insert({ id: 'r2', fromAgentId: 'a', toAgentId: 'b', conversationId: 'c', body: 'y', hop: 1 })
    db.a2aOutbox.markFailed('r2', 'provider_auth_or_access: nope')
    expect(db.a2aOutbox.getById('r2')!.error).toBe('provider_auth_or_access: nope')

    db.a2aOutbox.insert({ id: 'r3', fromAgentId: 'a', toAgentId: 'b', conversationId: 'c', body: 'z', hop: 1 })
    expect(db.a2aOutbox.cancelForSender('a').map((r) => r.id)).toEqual(['r3'])
    expect(db.a2aOutbox.getById('r3')!.status).toBe('cancelled')
    expect(db.a2aOutbox.listForAgent('b').map((r) => r.id).sort()).toEqual(['r1', 'r2', 'r3'])

    expect(db.a2aOutbox.pruneTerminal(Date.now() + 1)).toBe(3)
    expect(db.a2aOutbox.listForAgent('b')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Delivery pump
// ---------------------------------------------------------------------------

describe('BotService durable deliveries', () => {
  it('persists a delivery, marks it delivered on send and replied when the reply routes', async () => {
    const { scout, editor } = seedPair()
    const chat = makeChat()
    const { service, notifications } = makeService(chat)
    const scoutChat = service.ensureBotChat(scout)

    const ack = await service.messengerSend(scoutChat.id, '@editor', 'please review chapter 2')
    expect(ack).toContain('Message queued')
    await vi.waitFor(() => expect(chat.sends).toHaveLength(1))

    const rows = db.a2aOutbox.listForAgent(editor)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('delivered')
    expect(rows[0].targetConversationId).toBe(editorChatId(editor))
    expect(rows[0].attempts).toBe(1)
    expect(service.roster().bots.find((b) => b.agent.id === editor)!.inFlight).toBe(true)

    completeTurn(service, editorChatId(editor))
    expect(db.a2aOutbox.getById(rows[0].id)!.status).toBe('replied')
    const reply = db.messages.listByConversation(scoutChat.id).find((m) => m.role === 'user')!
    expect(reply.content).toContain('Reply from 🤖 Editor')
    expect(reply.agentId).toBe(editor)
    expect(notifications.some((n) => n.title.includes('Editor replied'))).toBe(true)
    expect(inFlightOf(service).size).toBe(0)
  })

  it('keeps deliveries FIFO while the target is busy and drains one per completion', async () => {
    const { scout, editor } = seedPair()
    const chat = makeChat({ active: true })
    const { service } = makeService(chat)
    const scoutChat = service.ensureBotChat(scout)

    await service.messengerSend(scoutChat.id, 'Editor', 'first')
    await service.messengerSend(scoutChat.id, 'Editor', 'second')
    expect(chat.sends).toHaveLength(0)
    expect(db.a2aOutbox.countQueued(editor)).toBe(2)
    expect(service.roster().bots.find((b) => b.agent.id === editor)!.queuedCount).toBe(2)

    // The busy user turn ends: the hook drains exactly one delivery.
    chat.opts.active = false
    const target = editorChatId(editor)
    completeUserTurn(service, target)
    await vi.waitFor(() => expect(chat.sends).toHaveLength(1))
    expect(chat.sends[0].content).toContain('first')
    expect(db.a2aOutbox.countQueued(editor)).toBe(1)

    completeTurn(service, target)
    await vi.waitFor(() => expect(chat.sends).toHaveLength(2))
    expect(chat.sends[1].content).toContain('second')
  })

  it('leaves the row queued without spending an attempt when it loses the race with a user turn', async () => {
    const { scout, editor } = seedPair()
    const chat = makeChat({ throwOnce: new Error('Conversation already streaming') })
    const { service } = makeService(chat)
    const scoutChat = service.ensureBotChat(scout)

    await service.messengerSend(scoutChat.id, 'Editor', 'hello')
    await vi.waitFor(() => expect(db.a2aOutbox.nextQueued(editor)).not.toBeNull())
    expect(db.a2aOutbox.nextQueued(editor)!.attempts).toBe(0)
    expect(chat.sends).toHaveLength(0)

    completeUserTurn(service, editorChatId(editor)) // the racing user turn ends → the hook pumps
    await vi.waitFor(() => expect(chat.sends).toHaveLength(1))
  })

  it('retries a transient failure once, then fails with a typed reason', async () => {
    vi.useFakeTimers()
    const { scout, editor } = seedPair()
    const rateLimited = Object.assign(new Error('429'), { code: 'rate_limit' })
    const chat = makeChat({ throwOnce: rateLimited })
    const { service, notifications } = makeService(chat)
    const scoutChat = service.ensureBotChat(scout)

    await service.messengerSend(scoutChat.id, 'Editor', 'hello')
    await vi.waitFor(() => expect(db.a2aOutbox.nextQueued(editor)!.attempts).toBe(1))
    chat.opts.throwOnce = rateLimited
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => expect(db.a2aOutbox.listForAgent(editor)[0].status).toBe('failed'))
    expect(db.a2aOutbox.listForAgent(editor)[0].error).toContain('provider_rate_limit')
    const failure = db.messages.listByConversation(scoutChat.id).find((m) => m.role === 'user')!
    expect(failure.content).toContain('failed (provider_rate_limit)')
    expect(notifications.some((n) => n.status === 'error')).toBe(true)
    expect(chat.sends).toHaveLength(0)
  })

  it('never retries an auth failure', async () => {
    const { scout, editor } = seedPair()
    const chat = makeChat({ throwOnce: Object.assign(new Error('401'), { code: 'auth' }) })
    const { service } = makeService(chat)
    const scoutChat = service.ensureBotChat(scout)
    await service.messengerSend(scoutChat.id, 'Editor', 'hello')
    await vi.waitFor(() => expect(db.a2aOutbox.listForAgent(editor)[0].status).toBe('failed'))
    expect(db.a2aOutbox.listForAgent(editor)[0].error).toContain('provider_auth_or_access')
  })

  it('drains a stranded queue on the maintenance tick', async () => {
    const { scout, editor } = seedPair()
    const chat = makeChat({ active: true })
    const { service } = makeService(chat)
    const scoutChat = service.ensureBotChat(scout)
    await service.messengerSend(scoutChat.id, 'Editor', 'hello')
    expect(chat.sends).toHaveLength(0)

    chat.opts.active = false // the busy turn ended as stopped/error → no hook
    await service.maintenanceTick()
    await vi.waitFor(() => expect(chat.sends).toHaveLength(1))
  })

  it('persists the hop so the chain cap survives, and refuses past it', async () => {
    const { scout, editor } = seedPair()
    const chat = makeChat({ active: true })
    const { service } = makeService(chat)
    const scoutChat = service.ensureBotChat(scout)
    ;(service as unknown as { turnHops: Map<string, number> }).turnHops.set(scoutChat.id, 3)
    await service.messengerSend(scoutChat.id, 'Editor', 'deep')
    expect(db.a2aOutbox.listForAgent(editor)[0].hop).toBe(4)
    ;(service as unknown as { turnHops: Map<string, number> }).turnHops.set(scoutChat.id, 6)
    expect(await service.messengerSend(scoutChat.id, 'Editor', 'deeper')).toContain('too deep')
  })

  it('on delete, fails deliveries addressed to the bot and cancels the ones it sent', async () => {
    const { scout, editor } = seedPair()
    const chat = makeChat({ active: true })
    const { service } = makeService(chat)
    const scoutChat = service.ensureBotChat(scout)
    const editorChat = service.ensureBotChat(editor)
    await service.messengerSend(scoutChat.id, 'Editor', 'to editor')
    await service.messengerSend(editorChat.id, 'Scout', 'to scout')

    const profile = db.agents.getById(editor)!
    db.agents.remove(editor)
    service.cleanupDeletedAgent(profile)

    const rows = db.a2aOutbox.listForAgent(editor)
    expect(rows.find((r) => r.toAgentId === editor)!.status).toBe('failed')
    expect(rows.find((r) => r.toAgentId === editor)!.error).toContain('missing_config')
    expect(rows.find((r) => r.fromAgentId === editor)!.status).toBe('cancelled')
    const notice = db.messages.listByConversation(scoutChat.id).find((m) => m.role === 'user')!
    expect(notice.content).toContain('no longer exists')
    expect(db.a2aOutbox.listOpen()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Visible handoff rows — both transcripts carry the delivery's status
// ---------------------------------------------------------------------------

describe('BotService visible handoffs', () => {
  it('writes a sender-side marker the model never sees, and moves it queued → delivered → replied', async () => {
    const { scout, editor } = seedPair()
    const chat = makeChat({ active: true })
    const { service } = makeService(chat)
    const scoutChat = service.ensureBotChat(scout)
    await service.messengerSend(scoutChat.id, 'Editor', 'please review')

    const marker = db.messages.listByConversation(scoutChat.id)[0]
    expect(marker.role).toBe('system')
    expect(marker.content).toContain('Sent to 🤖 Editor')
    expect(marker.handoff).toMatchObject({
      direction: 'out',
      fromAgentId: scout,
      toAgentId: editor,
      fromName: 'Scout',
      toName: 'Editor',
      status: 'queued',
    })
    const row = db.a2aOutbox.listForAgent(editor)[0]
    expect(row.handoffMessageId).toBe(marker.id)
    expect(marker.handoff!.outboxId).toBe(row.id)

    chat.opts.active = false
    completeUserTurn(service, editorChatId(editor))
    await vi.waitFor(() => expect(chat.sends).toHaveLength(1))
    expect(db.messages.getById(marker.id)!.handoff!.status).toBe('delivered')
    // The target's incoming turn is tagged too (rendered as a card, still a user row for the model).
    const incoming = db.messages
      .listByConversation(editorChatId(editor))
      .find((m) => m.role === 'user')!
    expect(incoming.handoff).toMatchObject({ direction: 'in', status: 'delivered', fromName: 'Scout' })

    completeTurn(service, editorChatId(editor))
    expect(db.messages.getById(marker.id)!.handoff!.status).toBe('replied')
    const reply = db.messages.listByConversation(scoutChat.id).find((m) => m.role === 'user')!
    expect(reply.handoff).toMatchObject({ direction: 'reply', status: 'replied', toName: 'Editor' })
  })

  it('marks the marker and the failure row failed with the typed reason', async () => {
    const { scout, editor } = seedPair()
    const chat = makeChat({ throwOnce: Object.assign(new Error('401'), { code: 'auth' }) })
    const { service } = makeService(chat)
    const scoutChat = service.ensureBotChat(scout)
    await service.messengerSend(scoutChat.id, 'Editor', 'hello')
    await vi.waitFor(() => expect(db.a2aOutbox.listForAgent(editor)[0].status).toBe('failed'))
    const rows = db.messages.listByConversation(scoutChat.id)
    const marker = rows.find((m) => m.role === 'system')!
    expect(marker.handoff).toMatchObject({ status: 'failed', reason: 'provider_auth_or_access' })
    const failure = rows.find((m) => m.role === 'user')!
    expect(failure.handoff).toMatchObject({ direction: 'reply', status: 'failed', reason: 'provider_auth_or_access' })
  })

  it('moves the marker back to queued on restart recovery and tolerates a deleted marker', async () => {
    const { scout, editor } = seedPair()
    const a = makeService(makeChat({ assistantStatus: 'streaming' }))
    const scoutChat = a.service.ensureBotChat(scout)
    await a.service.messengerSend(scoutChat.id, 'Editor', 'ping')
    await vi.waitFor(() => expect(inFlightOf(a.service).size).toBe(1))
    const marker = db.messages.listByConversation(scoutChat.id).find((m) => m.role === 'system')!
    expect(marker.handoff!.status).toBe('delivered')

    db.messages.markDanglingStreamingAsStopped()
    const b = makeService(makeChat({ active: true }))
    expect(b.service.recover().requeued).toBe(1)
    expect(db.messages.getById(marker.id)!.handoff!.status).toBe('queued')

    // Edit-and-rerun truncation removed the marker: the row still settles.
    db.messages.deleteById(marker.id)
    const row = db.a2aOutbox.listForAgent(editor)[0]
    const profile = db.agents.getById(editor)!
    db.agents.remove(editor)
    b.service.cleanupDeletedAgent(profile)
    expect(db.a2aOutbox.getById(row.id)!.status).toBe('failed')
    expect(db.messages.listByConversation(scoutChat.id).some((m) => m.role === 'system')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Restart recovery — the reason the outbox exists
// ---------------------------------------------------------------------------

describe('BotService restart recovery', () => {
  it('delivers rows that were still queued when the app died', async () => {
    const { scout, editor } = seedPair()
    const before = makeService(makeChat({ active: true }))
    const scoutChat = before.service.ensureBotChat(scout)
    await before.service.messengerSend(scoutChat.id, 'Editor', 'survive me')
    expect(db.a2aOutbox.countQueued(editor)).toBe(1)

    // "Restart": a fresh service over the same database.
    const chat = makeChat()
    const after = makeService(chat)
    expect(after.service.recover()).toEqual({ routed: 0, requeued: 0, failed: 0 })
    await vi.waitFor(() => expect(chat.sends).toHaveLength(1))
    expect(chat.sends[0].content).toContain('survive me')
    expect(db.a2aOutbox.listForAgent(editor)[0].status).toBe('delivered')
  })

  it('routes a reply that completed while the app was down', async () => {
    const { scout, editor } = seedPair()
    const chatBefore = makeChat()
    const before = makeService(chatBefore)
    const scoutChat = before.service.ensureBotChat(scout)
    await before.service.messengerSend(scoutChat.id, 'Editor', 'ping')
    await vi.waitFor(() => expect(inFlightOf(before.service).size).toBe(1))
    // The hook never fired: the process died right after the reply persisted.

    expect(db.messages.markDanglingStreamingAsStopped()).toBe(0)
    const chatAfter = makeChat()
    const after = makeService(chatAfter)
    expect(after.service.recover()).toEqual({ routed: 1, requeued: 0, failed: 0 })
    expect(db.a2aOutbox.listForAgent(editor)[0].status).toBe('replied')
    const reply = db.messages.listByConversation(scoutChat.id).find((m) => m.role === 'user')!
    expect(reply.content).toContain('Reply from 🤖 Editor')
    expect(chatAfter.sends).toHaveLength(0)
    expect(inFlightOf(after.service).size).toBe(0)
    expect(after.service.recover()).toEqual({ routed: 0, requeued: 0, failed: 0 }) // idempotent
  })

  it('redelivers an interrupted delivery once, then fails it as runtime_offline', async () => {
    const { scout, editor } = seedPair()
    const chatA = makeChat({ assistantStatus: 'streaming' })
    const a = makeService(chatA)
    const scoutChat = a.service.ensureBotChat(scout)
    await a.service.messengerSend(scoutChat.id, 'Editor', 'ping')
    await vi.waitFor(() => expect(inFlightOf(a.service).size).toBe(1))

    // Crash #1 mid-reply.
    expect(db.messages.markDanglingStreamingAsStopped()).toBe(1)
    const chatB = makeChat({ assistantStatus: 'streaming' })
    const b = makeService(chatB)
    expect(b.service.recover()).toEqual({ routed: 0, requeued: 1, failed: 0 })
    await vi.waitFor(() => expect(chatB.sends).toHaveLength(1))
    const row = db.a2aOutbox.listForAgent(editor)[0]
    expect(row.status).toBe('delivered')
    expect(row.attempts).toBe(2)
    const target = editorChatId(editor)
    expect(db.messages.listByConversation(target).filter((m) => m.role === 'user')).toHaveLength(2)
    expect(db.messages.listByConversation(target).some((m) => m.status === 'stopped')).toBe(true)

    // Crash #2: the retry budget is spent.
    expect(db.messages.markDanglingStreamingAsStopped()).toBe(1)
    const chatC = makeChat()
    const c = makeService(chatC)
    expect(c.service.recover()).toEqual({ routed: 0, requeued: 0, failed: 1 })
    expect(db.a2aOutbox.listForAgent(editor)[0].status).toBe('failed')
    expect(db.a2aOutbox.listForAgent(editor)[0].error).toMatch(/^runtime_offline/)
    const notice = db.messages.listByConversation(scoutChat.id).find((m) => m.role === 'user')!
    expect(notice.content).toContain('runtime_offline')
    expect(chatC.sends).toHaveLength(0)
    expect(c.notifications.some((n) => n.status === 'error')).toBe(true)
  })
})
