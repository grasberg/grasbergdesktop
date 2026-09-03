/**
 * Bot Mode (v46): bot profiles as a roster, canonical bot chats, fire-and-
 * forget bot-to-bot deliveries with reply routing + hop caps, and group rooms
 * running Hermes-style reply-or-pass rounds with settlement and hard caps.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../src/shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import {
  botSlug,
  isPassReply,
  matchBotName,
  mentionsUser,
  parseBotMentions,
  planRoundParticipants,
} from '../../src/main/services/bot-prompts'
import { BotService, type BotChatService } from '../../src/main/services/bots'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-bots-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Pure protocol helpers
// ---------------------------------------------------------------------------

describe('bot-prompts helpers', () => {
  it('slugs names and matches aliases like Hermes (@research-buddy ≡ @researchbuddy)', () => {
    expect(botSlug('Research Buddy')).toBe('research-buddy')
    const names = ['Research Buddy', 'Editor']
    expect(matchBotName(names, 'research-buddy')).toBe('Research Buddy')
    expect(matchBotName(names, '@ResearchBuddy')).toBe('Research Buddy')
    expect(matchBotName(names, 'editor')).toBe('Editor')
    expect(matchBotName(names, 'nobody')).toBeNull()
  })

  it('parses @mentions in order, deduped, without half-matching longer names', () => {
    const names = ['Research', 'Research Buddy', 'Editor']
    expect(parseBotMentions('@editor then @research-buddy please', names)).toEqual([
      'Editor',
      'Research Buddy',
    ])
    // '@research-buddy' must not also count as a mention of 'Research'.
    expect(parseBotMentions('@research-buddy only', names)).toEqual(['Research Buddy'])
    expect(parseBotMentions('no mentions here', names)).toEqual([])
  })

  it('recognizes PASS strictly and @user escalations loosely', () => {
    expect(isPassReply('PASS')).toBe(true)
    expect(isPassReply('  pass. ')).toBe(true)
    expect(isPassReply('PASS — but one thought')).toBe(false)
    expect(mentionsUser('this needs a decision @user')).toBe(true)
    expect(mentionsUser('mail to user@example.com')).toBe(false)
  })

  it('scopes round 1 to mentioned bots, opens later rounds to everyone', () => {
    const members = ['A', 'B', 'C']
    expect(planRoundParticipants(members, ['B'], 1)).toEqual(['B'])
    expect(planRoundParticipants(members, ['B'], 2)).toEqual(members)
    expect(planRoundParticipants(members, [], 1)).toEqual(members)
  })
})

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

describe('v46 repositories', () => {
  it('round-trips the new agent fields (title, avatar, hidden, canonical chat)', () => {
    const agent = db.agents.create({
      name: 'Scout',
      systemPrompt: 'You scout.',
      title: 'Field researcher',
      avatar: { emoji: '🔎', color: '#4169d8' },
      hidden: true,
    })
    const loaded = db.agents.getById(agent.id)!
    expect(loaded.title).toBe('Field researcher')
    expect(loaded.avatar).toEqual({ emoji: '🔎', color: '#4169d8' })
    expect(loaded.hidden).toBe(true)
    expect(loaded.chatConversationId).toBeNull()

    db.agents.setChatConversation(agent.id, 'conv-1')
    expect(db.agents.getById(agent.id)!.chatConversationId).toBe('conv-1')

    db.agents.update(agent.id, { avatar: null, hidden: false, title: '' })
    const cleared = db.agents.getById(agent.id)!
    expect(cleared.avatar).toBeNull()
    expect(cleared.hidden).toBe(false)
    expect(cleared.title).toBe('')
  })

  it('hides bot-owned conversations from the sidebar listing, keeps them for backups', () => {
    const agent = db.agents.create({ name: 'Scout', systemPrompt: 'p' })
    db.conversations.create({ mode: 'chat', title: 'plain chat' })
    db.conversations.create({ mode: 'chat', title: 'Scout', agentId: agent.id })
    const room = db.conversations.create({ mode: 'chat', title: 'Room' })
    db.botGroups.create({ name: 'Room', memberIds: [agent.id], conversationId: room.id })

    expect(db.conversations.list().map((c) => c.title)).toEqual(['plain chat'])
    expect(db.conversations.list({ includeBots: true })).toHaveLength(3)
  })

  it('bot_groups CRUD: members, needs-user, member cleanup on agent delete', () => {
    const a = db.agents.create({ name: 'A', systemPrompt: 'p' })
    const b = db.agents.create({ name: 'B', systemPrompt: 'p' })
    const conv = db.conversations.create({ mode: 'chat', title: 'Room' })
    const group = db.botGroups.create({
      name: 'Room',
      memberIds: [a.id, b.id],
      conversationId: conv.id,
    })
    expect(group.memberIds).toEqual([a.id, b.id])
    expect(group.needsUser).toBe(false)

    db.botGroups.setNeedsUser(group.id, true)
    expect(db.botGroups.getById(group.id)!.needsUser).toBe(true)

    db.botGroups.removeMemberEverywhere(a.id)
    expect(db.botGroups.getById(group.id)!.memberIds).toEqual([b.id])

    expect(db.botGroups.listConversationIds()).toEqual([conv.id])
    db.botGroups.remove(group.id)
    expect(db.botGroups.list()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// BotService
// ---------------------------------------------------------------------------

interface FakeChatCall {
  conversationId: string
  content: string
}

function makeFakeChat(overrides?: Partial<BotChatService>): BotChatService & {
  sends: FakeChatCall[]
  turns: string[]
} {
  const sends: FakeChatCall[] = []
  const turns: string[] = []
  return {
    sends,
    turns,
    async send({ conversationId, content }) {
      sends.push({ conversationId, content })
      const now = Date.now()
      const userMessage: Message = {
        id: randomUUID(),
        conversationId,
        role: 'user',
        content,
        status: 'complete',
        seq: 1,
        createdAt: now,
      }
      const assistantMessage: Message = {
        id: randomUUID(),
        conversationId,
        role: 'assistant',
        content: `reply to: ${content}`,
        status: 'complete',
        seq: 2,
        createdAt: now,
      }
      return { userMessage, assistantMessage }
    },
    isConversationActive: () => false,
    async compactNow() {
      return { compacted: true }
    },
    async generateForWorkflow(prompt) {
      turns.push(prompt)
      return 'PASS'
    },
    ...overrides,
  }
}

function makeService(chat: BotChatService): {
  service: BotService
  broadcasts: Array<{ channel: string; payload: unknown }>
  notifications: Array<{ title: string; status: string }>
} {
  const broadcasts: Array<{ channel: string; payload: unknown }> = []
  const notifications: Array<{ title: string; status: string }> = []
  const service = new BotService({
    db,
    chat,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    notify: ({ title, status }) => notifications.push({ title, status }),
  })
  return { service, broadcasts, notifications }
}

describe('BotService canonical chats', () => {
  it('creates the canonical chat lazily, once, and links it to the profile', () => {
    const agent = db.agents.create({ name: 'Scout', systemPrompt: 'p' })
    const { service } = makeService(makeFakeChat())
    const first = service.ensureBotChat(agent.id)
    const second = service.ensureBotChat(agent.id)
    expect(second.id).toBe(first.id)
    expect(first.agentId).toBe(agent.id)
    expect(db.agents.getById(agent.id)!.chatConversationId).toBe(first.id)
    // Hidden from the sidebar, present for backup.
    expect(db.conversations.list().find((c) => c.id === first.id)).toBeUndefined()
  })

  it('cleanup on delete removes the chat and group memberships', () => {
    const a = db.agents.create({ name: 'A', systemPrompt: 'p' })
    const b = db.agents.create({ name: 'B', systemPrompt: 'p' })
    const { service } = makeService(makeFakeChat())
    const chat = service.ensureBotChat(a.id)
    const room = db.conversations.create({ mode: 'chat', title: 'Room' })
    const group = db.botGroups.create({
      name: 'Room',
      memberIds: [a.id, b.id],
      conversationId: room.id,
    })
    const agent = db.agents.getById(a.id)!
    db.agents.remove(a.id)
    service.cleanupDeletedAgent(agent)
    expect(db.conversations.getById(chat.id)).toBeNull()
    expect(db.botGroups.getById(group.id)!.memberIds).toEqual([b.id])
  })
})

describe('BotService messaging', () => {
  it('delivers into the target chat and routes the reply back to the sender', async () => {
    const sender = db.agents.create({ name: 'Scout', systemPrompt: 'p' })
    const target = db.agents.create({ name: 'Editor', systemPrompt: 'p' })
    const chat = makeFakeChat()
    const { service, notifications } = makeService(chat)
    const senderChat = service.ensureBotChat(sender.id)

    const ack = await service.messengerSend(senderChat.id, '@editor', 'please review chapter 2')
    expect(ack).toContain('Editor')
    expect(ack).not.toContain('Error')
    await vi.waitFor(() => expect(chat.sends).toHaveLength(1))

    const targetChatId = db.agents.getById(target.id)!.chatConversationId!
    expect(chat.sends[0].conversationId).toBe(targetChatId)
    expect(chat.sends[0].content).toContain('Message from 🤖 Scout (@scout):')
    expect(chat.sends[0].content).toContain('please review chapter 2')

    // The completion hook fires for the target's finished turn.
    const targetConv = db.conversations.getById(targetChatId)!
    const assistant: Message = {
      id: 'am-1',
      conversationId: targetChatId,
      role: 'assistant',
      content: 'Looks good, ship it.',
      status: 'complete',
      seq: 2,
      createdAt: Date.now(),
    }
    // Match the in-flight assistant message id recorded from send().
    const recorded = chat.sends[0]
    expect(recorded).toBeDefined()
    // handleCompletion with the actual in-flight id: re-send via the service's
    // recorded id by completing with the message the fake send returned.
    // The fake send created its own id, so complete using a message with that id.
    const inFlightId = await getInFlightAssistantId(service, targetChatId)
    service.handleCompletion(targetConv, { ...assistant, id: inFlightId })

    // The sender's chat: the handoff marker (system, invisible to the model)
    // plus the routed reply as a user-role row.
    const senderMessages = db.messages.listByConversation(senderChat.id)
    expect(senderMessages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(senderMessages[0].handoff?.status).toBe('replied')
    expect(senderMessages[1].content).toContain('Reply from 🤖 Editor (@editor):')
    expect(senderMessages[1].content).toContain('Looks good, ship it.')
    expect(notifications.some((n) => n.title.includes('Editor replied'))).toBe(true)
  })

  it('rejects unknown targets, self-messaging, and non-bot conversations', async () => {
    const sender = db.agents.create({ name: 'Scout', systemPrompt: 'p' })
    const { service } = makeService(makeFakeChat())
    const senderChat = service.ensureBotChat(sender.id)
    const plain = db.conversations.create({ mode: 'chat', title: 'plain' })

    expect(await service.messengerSend(plain.id, 'Scout', 'hi')).toContain('only available')
    expect(await service.messengerSend(senderChat.id, 'Scout', 'hi')).toContain(
      'cannot message yourself'
    )
    expect(await service.messengerSend(senderChat.id, 'Ghost', 'hi')).toContain('no bot named')
  })

  it('caps delivery chains at the hop limit', async () => {
    const a = db.agents.create({ name: 'A', systemPrompt: 'p' })
    db.agents.create({ name: 'B', systemPrompt: 'p' })
    const chat = makeFakeChat()
    const { service } = makeService(chat)
    const aChat = service.ensureBotChat(a.id)

    // Simulate a turn already at the cap: the internal hop tracker is fed by
    // deliveries; emulate by sending MAX times through the private map via
    // repeated handleCompletion-free deliveries is complex — instead verify
    // the first hop passes and a synthetic deep chain refuses.
    const ok = await service.messengerSend(aChat.id, 'B', 'hop 1')
    expect(ok).not.toContain('Error')
    // Drive the hop counter to the cap through the internal seam.
    setTurnHop(service, aChat.id, 6)
    const refused = await service.messengerSend(aChat.id, 'B', 'too deep')
    expect(refused).toContain('too deep')
  })
})

/** Test seam: the in-flight assistant-message id for a target conversation. */
async function getInFlightAssistantId(service: BotService, conversationId: string): Promise<string> {
  const inFlight = (service as unknown as { inFlight: Map<string, { assistantMessageId: string }> })
    .inFlight
  await vi.waitFor(() => expect(inFlight.get(conversationId)).toBeDefined())
  return inFlight.get(conversationId)!.assistantMessageId
}

function setTurnHop(service: BotService, conversationId: string, hop: number): void {
  ;(service as unknown as { turnHops: Map<string, number> }).turnHops.set(conversationId, hop)
}

describe('BotService group rooms', () => {
  function makeRoom(replies: Record<string, string[]>): {
    service: BotService
    groupId: string
    conversationId: string
    notifications: Array<{ title: string; status: string }>
  } {
    const a = db.agents.create({ name: 'Alpha', systemPrompt: 'p' })
    const b = db.agents.create({ name: 'Beta', systemPrompt: 'p' })
    const counters = new Map<string, number>()
    const chat = makeFakeChat({
      async generateForWorkflow(prompt, _p, _m, opts) {
        const agent = db.agents.getById(opts!.agentId!)!
        const list = replies[agent.name] ?? []
        const n = counters.get(agent.name) ?? 0
        counters.set(agent.name, n + 1)
        void prompt
        return list[n] ?? 'PASS'
      },
    })
    const built = makeService(chat)
    const group = built.service.createGroup({ name: 'Council', memberIds: [a.id, b.id] })
    return {
      service: built.service,
      groupId: group.id,
      conversationId: group.conversationId,
      notifications: built.notifications,
    }
  }

  async function settled(service: BotService, groupId: string): Promise<void> {
    const active = (service as unknown as { activeGroups: Map<string, unknown> }).activeGroups
    await vi.waitFor(() => expect(active.has(groupId)).toBe(false), { timeout: 5000 })
  }

  it('runs reply-or-pass rounds and settles on a silent round', async () => {
    const { service, groupId, conversationId } = makeRoom({
      Alpha: ['I think we should ship.', 'PASS'],
      Beta: ['PASS', 'PASS'],
    })
    service.groupSend(groupId, 'Should we ship this week?')
    await settled(service, groupId)

    const messages = db.messages.listByConversation(conversationId)
    // 1 user + 1 Alpha reply; Beta passed everywhere; round 2 silent → settle.
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('user')
    expect(messages[1].agentId).toBeDefined()
    expect(messages[1].content).toBe('I think we should ship.')
  })

  it('scopes round 1 to @mentioned members', async () => {
    const { service, groupId, conversationId } = makeRoom({
      Alpha: ['Only me.', 'PASS'],
      Beta: ['I should not speak first.', 'PASS'],
    })
    service.groupSend(groupId, '@alpha what do you think?')
    await settled(service, groupId)

    const messages = db.messages.listByConversation(conversationId)
    const speakers = messages.filter((m) => m.role === 'assistant').map((m) => m.agentId)
    const alpha = db.agents.getByName('Alpha')!
    // Round 1: Alpha only. Round 2 opens to everyone (Beta may then speak).
    expect(speakers[0]).toBe(alpha.id)
  })

  it('flags needs-you when a member escalates with @user', async () => {
    const { service, groupId, notifications } = makeRoom({
      Alpha: ['This is a judgment call — @user should decide.', 'PASS'],
      Beta: ['PASS', 'PASS'],
    })
    service.groupSend(groupId, 'Delete the legacy data?')
    await settled(service, groupId)

    expect(db.botGroups.getById(groupId)!.needsUser).toBe(true)
    expect(notifications.some((n) => n.title.includes('needs you'))).toBe(true)

    service.markGroupSeen(groupId)
    expect(db.botGroups.getById(groupId)!.needsUser).toBe(false)
  })

  it('enforces the 2–6 member bounds and disbands rooms permanently', () => {
    const a = db.agents.create({ name: 'Solo', systemPrompt: 'p' })
    const { service } = makeService(makeFakeChat())
    expect(() => service.createGroup({ name: 'Tiny', memberIds: [a.id] })).toThrow(/2–6/)

    const b = db.agents.create({ name: 'Duo', systemPrompt: 'p' })
    const group = service.createGroup({ name: 'Pair', memberIds: [a.id, b.id] })
    service.deleteGroup(group.id)
    expect(db.botGroups.getById(group.id)).toBeNull()
    expect(db.conversations.getById(group.conversationId)).toBeNull()
  })
})

describe('BotService routine mirroring', () => {
  it('mirrors an owned task result into the bot chat, and skips ownerless tasks', () => {
    const agent = db.agents.create({ name: 'Watcher', systemPrompt: 'p' })
    const { service } = makeService(makeFakeChat())
    const owned = db.scheduledTasks.create({
      title: 'Nightly check',
      prompt: 'check things',
      recurrence: 'once',
      runAt: Date.now(),
      agentId: agent.id,
    })
    const ownerless = db.scheduledTasks.create({
      title: 'Plain task',
      prompt: 'do things',
      recurrence: 'once',
      runAt: Date.now(),
    })

    service.mirrorRoutineResult(owned, 'ok', 'All systems normal.')
    service.mirrorRoutineResult(ownerless, 'ok', 'irrelevant')

    const chatId = db.agents.getById(agent.id)!.chatConversationId!
    const messages = db.messages.listByConversation(chatId)
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toContain('Routine "Nightly check" ran')
    expect(messages[1].content).toBe('All systems normal.')
    expect(messages[1].agentId).toBe(agent.id)
  })
})
