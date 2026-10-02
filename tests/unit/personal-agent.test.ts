/**
 * Personal-agent layer (v53, dots / Grok Bot / Muse parity), part A:
 * proactive heartbeats run read-only under an autonomous invocation policy,
 * turn origins reach the approval gate, bots can be paused / resumed / reset,
 * and suggest_action turns proactive findings into proposals the user decides.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, Message, ToolApprovalAnswer, ToolCallRecord } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { BotService, type BotChatService } from '../../src/main/services/bots'
import {
  currentInvocationPolicy,
  withInvocationPolicy,
  withoutInvocationPolicy,
} from '../../src/main/invocation-context'
import {
  clearCompletionHooks,
  registerCompletionHook,
  runCompletionHooks,
} from '../../src/main/services/completion-hooks'
import { buildHeartbeatPrompt, buildBotChatSection } from '../../src/main/services/bot-prompts'
import { createToolSystem } from '../../src/main/tools'
import { isOutwardTool } from '@shared/tool-classes'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-personal-agent-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  clearCompletionHooks()
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
})

interface RecordingChat extends BotChatService {
  sends: Array<{
    conversationId: string
    content: string
    policy: string | null
    queueIfBusy: boolean
  }>
  active: Set<string>
  nextReply: string
}

/** Persists each turn like the real pipeline and records the policy it ran under. */
function makeChat(): RecordingChat {
  const fake: RecordingChat = {
    sends: [],
    active: new Set(),
    nextReply: 'NO_REPLY',
    async send({ conversationId, content }, opts) {
      const policy = currentInvocationPolicy()
      fake.sends.push({
        conversationId,
        content,
        policy: policy ? `${policy.origin}:${policy.sandboxLevel}` : null,
        queueIfBusy: opts?.queueIfBusy === true,
      })
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
        content: fake.nextReply,
        status: 'complete',
        seq: db.messages.nextSeq(conversationId),
        createdAt: now,
      }
      db.messages.insert(assistantMessage)
      return { userMessage, assistantMessage }
    },
    isConversationActive: (id) => fake.active.has(id),
    async compactNow() {
      return { compacted: true }
    },
    async generateForWorkflow() {
      return 'PASS'
    },
  }
  return fake
}

function makeService(chat: BotChatService) {
  const notifications: Array<{ title: string; body: string }> = []
  const broadcasts: string[] = []
  const service = new BotService({
    db,
    chat,
    broadcast: (channel) => broadcasts.push(channel),
    notify: ({ title, body }) => notifications.push({ title, body }),
  })
  return { service, notifications, broadcasts }
}

const later = (minutes: number): number => Date.now() + minutes * 60_000

describe('proactive heartbeats (dots read-only posture)', () => {
  it('runs a heartbeat read-only by default and marks the turn proactive', async () => {
    const agent = db.agents.create({
      name: 'Scout',
      systemPrompt: 'p',
      goal: 'Keep an eye on competitor pricing',
      heartbeat: { everyMinutes: 15, deliver: 'chat' },
    })
    const recorder = makeChat()
    let originDuringTurn: string | null = null
    const chat: BotChatService = {
      ...recorder,
      send: (req, opts) => {
        originDuringTurn = service.turnOrigin(req.conversationId)
        return recorder.send(req, opts)
      },
    }
    const { service } = makeService(chat)

    await service.maintenanceTick(later(16))
    expect(recorder.sends).toHaveLength(1)
    expect(recorder.sends[0].policy).toBe('autonomous:read-only')
    expect(recorder.sends[0].content).toContain('READ-ONLY')
    expect(recorder.sends[0].content).toContain('suggest_action')
    expect(recorder.sends[0].content).toContain('competitor pricing')
    expect(originDuringTurn).toBe('proactive')

    const chatId = db.agents.getById(agent.id)!.chatConversationId!
    const assistant = db.messages.listByConversation(chatId).find((m) => m.role === 'assistant')!
    service.handleCompletion(db.conversations.getById(chatId)!, assistant)
    expect(service.turnOrigin(chatId)).toBeNull()
  })

  it("lets the user opt a bot's heartbeat into acting (no policy)", async () => {
    db.agents.create({
      name: 'Doer',
      systemPrompt: 'p',
      heartbeat: { everyMinutes: 15, deliver: 'chat', posture: 'act' },
    })
    const chat = makeChat()
    const { service } = makeService(chat)
    await service.maintenanceTick(later(16))
    expect(chat.sends).toHaveLength(1)
    expect(chat.sends[0].policy).toBeNull()
    expect(chat.sends[0].content).not.toContain('READ-ONLY')
  })

  it('prompt helpers carry the goal and the personal-agent protocol', () => {
    expect(buildHeartbeatPrompt(null, { readOnly: false })).not.toContain('READ-ONLY')
    const section = buildBotChatSection(
      { name: 'Scout', title: 'Researcher', description: '', goal: 'Track flights to Lisbon' },
      []
    )
    expect(section).toContain('Track flights to Lisbon')
    expect(section).toContain('suggest_action')
    expect(section).toContain('[Approved suggestion]')
  })
})

describe('invocation policy does not leak into follow-up work', () => {
  it('completion hooks run outside the finished turn policy', async () => {
    let seen: string | null = 'unset'
    registerCompletionHook(() => {
      seen = currentInvocationPolicy()?.origin ?? null
    })
    const conversation = { id: 'c' } as Conversation
    const message = { id: 'm', role: 'assistant' } as Message
    await withInvocationPolicy(
      { origin: 'autonomous', autoAcceptEdits: false, sandboxLevel: 'read-only' },
      () => runCompletionHooks(conversation, message)
    )
    expect(seen).toBeNull()
  })

  it('withoutInvocationPolicy clears the store for timers created inside it', async () => {
    const result = await withInvocationPolicy(
      { origin: 'autonomous', autoAcceptEdits: false, sandboxLevel: 'read-only' },
      () =>
        new Promise<string | null>((resolve) => {
          withoutInvocationPolicy(() =>
            setTimeout(() => resolve(currentInvocationPolicy()?.origin ?? null), 1)
          )
        })
    )
    expect(result).toBeNull()
  })
})

describe('pause / resume / reset', () => {
  it('a paused bot gets no heartbeat and no deliveries until resumed', async () => {
    const agent = db.agents.create({
      name: 'Sleepy',
      systemPrompt: 'p',
      heartbeat: { everyMinutes: 15, deliver: 'chat' },
    })
    const chat = makeChat()
    const { service } = makeService(chat)
    service.pauseAgent(agent.id)
    expect(db.agents.getById(agent.id)!.paused).toBe(true)

    await service.maintenanceTick(later(16))
    expect(chat.sends).toHaveLength(0)

    await service.wake(agent.id, { source: 'manual', label: 'test', payload: 'hello' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(chat.sends).toHaveLength(0)
    expect(db.a2aOutbox.countQueued(agent.id)).toBe(1)

    service.resumeAgent(agent.id)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(db.agents.getById(agent.id)!.paused).toBe(false)
    expect(chat.sends).toHaveLength(1)
    expect(chat.sends[0].content).toContain('hello')
  })

  it('an anomaly pause records its reason and notifies', () => {
    const agent = db.agents.create({ name: 'Loopy', systemPrompt: 'p' })
    const { service, notifications } = makeService(makeChat())
    const paused = service.pauseAgent(agent.id, '12 refused tool calls in a row')
    expect(paused.pausedReason).toBe('12 refused tool calls in a row')
    expect(notifications.some((n) => n.title.includes('Loopy'))).toBe(true)
    expect(service.resumeAgent(agent.id).pausedReason).toBeNull()
  })

  it('reset wipes chat, own memories, routines and suggestions but keeps the profile', async () => {
    const agent = db.agents.create({ name: 'Fresh', systemPrompt: 'persona', goal: 'g' })
    const other = db.agents.create({ name: 'Other', systemPrompt: 'p' })
    const chat = makeChat()
    const { service } = makeService(chat)
    const conversation = service.ensureBotChat(agent.id)
    db.memories.create({ title: 'mine', content: 'x', agentId: agent.id })
    db.memories.create({ title: 'theirs', content: 'y', agentId: other.id })
    db.memories.create({ title: 'shared', content: 'z' })
    db.scheduledTasks.create({
      title: 'daily',
      prompt: 'do it',
      recurrence: 'daily',
      runAt: Date.now() + 60_000,
      agentId: agent.id,
    })
    service.suggest(conversation.id, { title: 'Do a thing', action: 'thing' })

    const after = service.resetAgent(agent.id)
    expect(after.systemPrompt).toBe('persona')
    expect(after.goal).toBe('g')
    expect(after.chatConversationId).toBeNull()
    expect(db.conversations.getById(conversation.id)).toBeNull()
    expect(db.memories.listForAgent(agent.id)).toHaveLength(0)
    expect(db.memories.listForAgent(other.id)).toHaveLength(1)
    expect(db.memories.listForAgent(null)).toHaveLength(1)
    expect(db.scheduledTasks.list().filter((t) => t.agentId === agent.id)).toHaveLength(0)
    expect(db.botSuggestions.listForAgent(agent.id)).toHaveLength(0)
  })

  it('refuses to reset while a turn is running', () => {
    const agent = db.agents.create({ name: 'Busy', systemPrompt: 'p' })
    const chat = makeChat()
    const { service } = makeService(chat)
    const conversation = service.ensureBotChat(agent.id)
    chat.active.add(conversation.id)
    expect(() => service.resetAgent(agent.id)).toThrow(/stop the turn/)
  })
})

describe('suggestions', () => {
  it('records, dedupes, surfaces in the roster, and runs as a user turn on accept', async () => {
    const agent = db.agents.create({ name: 'Helper', systemPrompt: 'p' })
    const chat = makeChat()
    const { service, notifications, broadcasts } = makeService(chat)
    const conversation = service.ensureBotChat(agent.id)

    const first = service.suggest(conversation.id, {
      title: 'Reply to Anna',
      action: 'Draft and send a reply to Anna confirming Friday',
      reason: 'She asked twice',
    })
    expect(first).toContain('Suggestion recorded')
    expect(service.suggest(conversation.id, { title: 'reply to anna', action: 'x' })).toContain(
      'already waiting'
    )
    expect(notifications.some((n) => n.title.includes('Reply to Anna'))).toBe(true)
    expect(broadcasts).toContain('push:botSuggestionsChanged')

    const row = service.roster().bots.find((b) => b.agent.id === agent.id)!
    expect(row.openSuggestions).toBe(1)
    expect(row.attention).toBe('needs_you')

    const [open] = service.listSuggestions(agent.id)
    await service.acceptSuggestion(open.id)
    expect(chat.sends).toHaveLength(1)
    expect(chat.sends[0].content).toMatch(/^\[Approved suggestion\] Reply to Anna/)
    expect(chat.sends[0].queueIfBusy).toBe(true)
    expect(chat.sends[0].policy).toBeNull()
    expect(service.turnOrigin(conversation.id)).toBeNull() // a user turn
    expect(db.botSuggestions.getById(open.id)!.status).toBe('accepted')
    await expect(service.acceptSuggestion(open.id)).rejects.toThrow(/no longer open/)
  })

  it('dismisses, caps open suggestions per bot, and refuses outside bot chats', () => {
    const agent = db.agents.create({ name: 'Eager', systemPrompt: 'p' })
    const { service } = makeService(makeChat())
    const conversation = service.ensureBotChat(agent.id)
    for (let i = 0; i < 20; i++) {
      service.suggest(conversation.id, { title: `Idea ${i}`, action: 'a' })
    }
    expect(service.suggest(conversation.id, { title: 'One more', action: 'a' })).toContain(
      'many open suggestions'
    )
    const [latest] = service.listSuggestions(agent.id)
    service.dismissSuggestion(latest.id)
    expect(db.botSuggestions.countOpen(agent.id)).toBe(19)

    const plain = db.conversations.create({ mode: 'chat', title: 'plain' })
    expect(service.suggest(plain.id, { title: 't', action: 'a' })).toContain('only available')
  })
})

describe('projects and feedback (v53)', () => {
  it('update_project upserts by title, and heartbeats carry the open projects', async () => {
    const agent = db.agents.create({
      name: 'Planner',
      systemPrompt: 'p',
      heartbeat: { everyMinutes: 15, deliver: 'chat' },
    })
    const chat = makeChat()
    const { service } = makeService(chat)
    const conversation = service.ensureBotChat(agent.id)
    expect(
      service.updateProject(conversation.id, {
        title: 'Lisbon trip',
        summary: 'Flights shortlisted',
        nextStep: 'Pick a hotel',
      })
    ).toContain('active')
    service.updateProject(conversation.id, { title: 'lisbon trip', status: 'waiting' })
    service.updateProject(conversation.id, { title: 'Old thing', status: 'done' })
    const projects = service.listProjects(agent.id)
    expect(projects.map((p) => [p.title, p.status])).toEqual([
      ['Lisbon trip', 'waiting'],
      ['Old thing', 'done'],
    ])
    expect(projects[0].summary).toBe('Flights shortlisted')

    await service.maintenanceTick(later(16))
    expect(chat.sends[0].content).toContain('Lisbon trip [waiting]')
    expect(chat.sends[0].content).not.toContain('Old thing')

    service.resetAgent(agent.id)
    expect(service.listProjects(agent.id)).toHaveLength(0)
    const plain = db.conversations.create({ mode: 'chat', title: 'x' })
    expect(service.updateProject(plain.id, { title: 't' })).toContain('only available')
  })

  it('feedback is stored, attributed to the authoring bot and becomes a memory', async () => {
    const { recordFeedback, listFeedback } = await import('../../src/main/services/feedback')
    const agent = db.agents.create({ name: 'Writer', systemPrompt: 'p' })
    const { service } = makeService(makeChat())
    const conversation = service.ensureBotChat(agent.id)
    const reply: Message = {
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Here is a very long and formal answer…',
      status: 'complete',
      seq: 1,
      createdAt: Date.now(),
    }
    db.messages.insert(reply)
    const saved = recordFeedback(db, { messageId: reply.id, rating: -1, comment: 'Too formal, be brief' })
    expect(saved?.agentId).toBe(agent.id)
    const memories = db.memories.listForAgent(agent.id)
    expect(memories).toHaveLength(1)
    expect(memories[0].content).toContain('Too formal, be brief')
    expect(memories[0].content).toContain('did NOT like')
    // Changing the rating replaces the row; a bare thumbs-up writes no new memory.
    recordFeedback(db, { messageId: reply.id, rating: 1 })
    expect(listFeedback(db, conversation.id)).toEqual([
      expect.objectContaining({ rating: 1, comment: '' }),
    ])
    expect(db.memories.listForAgent(agent.id)).toHaveLength(1)
    recordFeedback(db, { messageId: reply.id, rating: 0 })
    expect(listFeedback(db, conversation.id)).toHaveLength(0)
    const userMessage: Message = { ...reply, id: randomUUID(), role: 'user', seq: 2 }
    db.messages.insert(userMessage)
    expect(() => recordFeedback(db, { messageId: userMessage.id, rating: 1 })).toThrow(/assistant/)
  })
})

describe('executor gates for proactive turns', () => {
  const botConversation = (): Conversation => ({
    id: 'bot-conv',
    mode: 'chat',
    title: 'Bot',
    providerId: null,
    modelId: null,
    systemPrompt: null,
    params: {},
    workspaceId: null,
    projectId: null,
    projectRef: null,
    moaPresetId: null,
    agentId: 'bot-1',
    createdAt: 0,
    updatedAt: 0,
  })
  const call = (name: string, args: unknown): ToolCallRecord => ({
    id: 'tc',
    name,
    arguments: JSON.stringify(args),
    status: 'proposed',
  })
  const DECLINE: ToolApprovalAnswer = { approved: false, scope: 'once' }

  it('read-only refuses outward tools that are not "mutating" and lets suggest_action run', async () => {
    const sends: string[] = []
    const suggestions: string[] = []
    const { executor } = createToolSystem(db, null, {
      botMessenger: {
        send: async (_c, target) => {
          sends.push(target)
          return 'queued'
        },
      },
      botActions: {
        suggest: (_c, input) => {
          suggestions.push(input.title)
          return 'Suggestion recorded'
        },
      },
      turnOrigin: () => 'proactive',
    })
    const approval = vi.fn(async () => DECLINE)
    const refused = await executor.execute(call('message_agent', { target: 'X', message: 'hi' }), {
      conversation: botConversation(),
      approval,
      sandboxLevel: 'read-only',
    })
    expect(refused).toMatch(/read-only/)
    expect(refused).toMatch(/suggest_action/)
    expect(sends).toEqual([])
    expect(approval).not.toHaveBeenCalled()

    const ok = await executor.execute(
      call('suggest_action', { title: 'Book table', action: 'Book a table for 2 at 19:00' }),
      { conversation: botConversation(), approval, sandboxLevel: 'read-only' }
    )
    expect(ok).toBe('Suggestion recorded')
    expect(suggestions).toEqual(['Book table'])
  })

  it('asks before an acting (non read-only) heartbeat messages a teammate', async () => {
    const { executor } = createToolSystem(db, null, {
      botMessenger: { send: async () => 'queued' },
      turnOrigin: () => 'proactive',
    })
    const approval = vi.fn(async () => DECLINE)
    await executor.execute(call('message_agent', { target: 'X', message: 'hi' }), {
      conversation: botConversation(),
      approval,
    })
    expect(approval).toHaveBeenCalledWith(
      expect.objectContaining({ note: expect.stringContaining('heartbeat') })
    )
  })

  it('classifies outward tools', () => {
    expect(isOutwardTool({ id: 'message_agent' })).toBe(true)
    expect(isOutwardTool({ id: 'read_file' })).toBe(false)
    expect(isOutwardTool({ id: 'custom:x', source: 'custom', mutating: false })).toBe(false)
    expect(isOutwardTool({ id: 'custom:y', source: 'custom', mutating: true })).toBe(true)
    expect(isOutwardTool({ id: 'mcp__s__t', source: 'mcp' })).toBe(true)
    expect(isOutwardTool({ id: 'mcp__s__r', source: 'mcp', mutating: false })).toBe(false)
  })
})

describe('bot chat tool plan (review fix)', () => {
  it("channel tools follow the bot's toolset; only the Bot Mode protocol is always on", async () => {
    const { ChatService } = await import('../../src/main/services/chat-service')
    const provider = db.providers.create({
      id: randomUUID(),
      type: 'openai-compatible',
      label: 'P',
      baseUrl: 'https://x.example/v1',
      defaultModelId: 'gpt-4o',
      enabled: true,
    })
    const def = (id: string) => ({
      id,
      name: id,
      description: id,
      parameters: { type: 'object', properties: {} },
      risk: 'safe' as const,
      builtin: true,
      enabled: true,
    })
    const ids = ['message_agent', 'suggest_action', 'update_project', 'email_read', 'email_send', 'channel_send', 'web_search']
    const service = new ChatService(db, () => undefined, {
      tools: {
        registry: { listEnabledDefinitions: () => ids.map(def) },
        executor: { execute: vi.fn(async () => '') },
        broker: { request: vi.fn(async () => ({ approved: false, scope: 'once' as const })) },
      },
    })
    const bot = db.agents.create({ name: 'Mailer', systemPrompt: 'p', toolIds: ['web_search'] })
    const chat = db.conversations.create({ mode: 'chat', title: 'Mailer', agentId: bot.id })
    db.driver.run(
      `INSERT INTO bot_channels (id, agent_id, kind, enabled, config_json, state_json, created_at, updated_at)
       VALUES (?, ?, 'email', 1, '{}', '{}', ?, ?)`,
      [randomUUID(), bot.id, Date.now(), Date.now()]
    )
    const plan = (): string[] =>
      [
        ...((
          service as unknown as {
            planTools(resolved: unknown, conversation: Conversation): { allowedToolIds?: Set<string> }
          }
        ).planTools({ provider, modelId: 'gpt-4o', params: {} }, db.conversations.getById(chat.id)!)
          .allowedToolIds ?? []),
      ].sort()
    // The user left email out of this bot's toolset: it stays out, even with
    // an email channel connected.
    expect(plan()).toEqual(['message_agent', 'suggest_action', 'update_project', 'web_search'])
    // No toolset restriction: the email tools appear (the bot has a mailbox),
    // channel_send does not (no Slack / Discord channel).
    db.agents.update(bot.id, { toolIds: null })
    expect(plan()).toEqual(
      ['email_read', 'email_send', 'message_agent', 'suggest_action', 'update_project', 'web_search'].sort()
    )
  })
})
