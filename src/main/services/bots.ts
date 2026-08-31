/**
 * Bot Mode (v46) — the service behind the Bots pane, modeled on Hermes
 * Desktop's Bot Mode:
 *
 * - Canonical bot chats: one persistent conversation per agent profile
 *   (conversations.agent_id), created lazily. User turns in it ride the
 *   ordinary interactive send() pipeline; the bot's persona/memories/model
 *   pin/toolset are applied there by the chat service.
 * - Bot-to-bot messaging (`message_agent`): fire-and-forget deliveries. A
 *   delivery becomes a turn in the target's canonical chat; the completed
 *   reply is routed back into the sender's chat as an incoming message plus a
 *   desktop notification. One retry for transient provider failures; a hop
 *   counter stops ping-pong chains.
 * - Group rooms: one shared conversation, serial reply-or-pass rounds with
 *   Hermes caps (3 rounds / 10 messages per user send), @mention scoping and
 *   @user escalation ("needs you").
 * - Routine mirroring: a scheduled task owned by an agent reports its result
 *   into the bot's canonical chat.
 */

import { randomUUID } from 'node:crypto'
import { CHANNELS } from '@shared/ipc'
import type {
  AgentProfile,
  BotGroup,
  BotRoster,
  Conversation,
  Message,
  ProviderErrorCode,
  ScheduledTask,
} from '@shared/types'
import type { AppDatabase } from '../db/database'
import {
  buildGroupTurnPrompt,
  botSlug,
  formatBotReply,
  formatDeliveryFailure,
  formatIncomingBotMessage,
  GROUP_MAX_MEMBERS,
  GROUP_MAX_MESSAGES,
  GROUP_MAX_ROUNDS,
  GROUP_MIN_MEMBERS,
  isPassReply,
  matchBotName,
  MAX_BOT_HOPS,
  mentionsUser,
  parseBotMentions,
  planRoundParticipants,
  type BotIdentity,
} from './bot-prompts'

/** A delivery not answered within this window fails as delivery_timeout. */
const DELIVERY_TIMEOUT_MS = 10 * 60_000
/** Backoff before the single transient-failure retry. */
const RETRY_DELAY_MS = 10_000
/** "Wrote within the last 90 s" half of the active-now strip (Hermes). */
const ACTIVE_RECENT_MS = 90_000

/** The narrow chat-service surface the bot service needs (test seam). */
export interface BotChatService {
  send(req: {
    conversationId: string
    content: string
  }): Promise<{ assistantMessage: Message }>
  isConversationActive(conversationId: string): boolean
  generateForWorkflow(
    prompt: string,
    providerId?: string,
    modelId?: string,
    opts?: {
      useTools?: boolean
      agentId?: string
      signal?: AbortSignal
      usage?: { runKind: 'other'; refId?: string | null }
    }
  ): Promise<string>
}

export interface BotServiceDeps {
  db: AppDatabase
  chat: BotChatService
  broadcast: (channel: string, payload: unknown) => void
  /** Desktop notification sink (index.ts wires the DesktopNotifier). */
  notify?: (input: {
    title: string
    body: string
    status: 'ok' | 'error'
    conversationId?: string | null
    groupId?: string | null
  }) => void
}

interface PendingDelivery {
  id: string
  senderAgentId: string
  senderName: string
  senderConversationId: string
  targetAgentId: string
  message: string
  hop: number
  attempts: number
}

interface InFlightDelivery {
  delivery: PendingDelivery
  assistantMessageId: string
  timer: NodeJS.Timeout
}

/** Hermes-style typed failure reasons, mapped from normalized provider codes. */
function failureReason(code: ProviderErrorCode | 'target_busy' | 'unknown'): string {
  switch (code) {
    case 'auth':
      return 'provider_auth_or_access'
    case 'rate_limit':
      return 'provider_rate_limit'
    case 'server':
      return 'provider_server_error'
    case 'context_length':
      return 'context_overflow'
    case 'timeout':
      return 'delivery_timeout'
    case 'network':
      return 'runtime_offline'
    case 'invalid_request':
    case 'not_supported':
      return 'missing_config'
    case 'target_busy':
      return 'target_busy'
    default:
      return 'unknown'
  }
}

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'rate_limit',
  'server',
  'network',
  'timeout',
])

function errorCodeOf(e: unknown): ProviderErrorCode | 'unknown' {
  if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
    return (e as { code: ProviderErrorCode }).code
  }
  return 'unknown'
}

function errorMessageOf(e: unknown): string {
  return e instanceof Error ? e.message : 'Unknown error'
}

function identity(agent: AgentProfile): BotIdentity {
  return { name: agent.name, title: agent.title, description: agent.description }
}

export class BotService {
  /** Queued deliveries per target agent id (FIFO). */
  private readonly queues = new Map<string, PendingDelivery[]>()
  /** The delivery whose turn is currently running, keyed by target CONVERSATION id. */
  private readonly inFlight = new Map<string, InFlightDelivery>()
  /** Delivery hop depth of the turn currently running in a conversation. */
  private readonly turnHops = new Map<string, number>()
  /** One active round-runner per group room. */
  private readonly activeGroups = new Map<string, AbortController>()

  constructor(private readonly deps: BotServiceDeps) {}

  // -- canonical bot chats ------------------------------------------------------

  /** Get-or-create the bot's canonical chat conversation. */
  ensureBotChat(agentId: string): Conversation {
    const agent = this.deps.db.agents.getById(agentId)
    if (!agent) throw new Error('Unknown agent profile.')
    if (agent.chatConversationId) {
      const existing = this.deps.db.conversations.getById(agent.chatConversationId)
      if (existing) return existing
    }
    const conversation = this.deps.db.conversations.create({
      mode: 'chat',
      title: agent.name,
      agentId: agent.id,
    })
    this.deps.db.agents.setChatConversation(agent.id, conversation.id)
    this.botsChanged({ agentId: agent.id })
    return conversation
  }

  /**
   * Full cleanup when a profile is deleted: its canonical chat (transcript
   * included — Hermes "Delete Profile" semantics) and every group membership.
   * Queued deliveries to it fail out quietly.
   */
  cleanupDeletedAgent(agent: AgentProfile): void {
    if (agent.chatConversationId) {
      this.inFlight.delete(agent.chatConversationId)
      this.turnHops.delete(agent.chatConversationId)
      this.deps.db.conversations.remove(agent.chatConversationId)
    }
    this.queues.delete(agent.id)
    this.deps.db.botGroups.removeMemberEverywhere(agent.id)
    this.botsChanged({ agentId: agent.id })
  }

  // -- roster -------------------------------------------------------------------

  roster(): BotRoster {
    const db = this.deps.db
    const now = Date.now()
    const bots = db.agents.list().map((agent) => {
      const conversationId = agent.chatConversationId
      const last = conversationId ? db.messages.lastSnippet(conversationId) : null
      const active =
        (conversationId !== null && this.deps.chat.isConversationActive(conversationId ?? '')) ||
        (last !== null && now - last.createdAt < ACTIVE_RECENT_MS)
      return {
        agent,
        conversationId,
        lastMessageAt: last?.createdAt ?? null,
        snippet: last ? last.content.replace(/\s+/g, ' ').trim().slice(0, 100) : null,
        active,
      }
    })
    const groups = db.botGroups.list().map((group) => {
      const last = db.messages.lastSnippet(group.conversationId)
      return {
        group,
        lastMessageAt: last?.createdAt ?? null,
        snippet: last ? last.content.replace(/\s+/g, ' ').trim().slice(0, 100) : null,
        active: this.activeGroups.has(group.id),
      }
    })
    return { bots, groups }
  }

  // -- bot-to-bot messaging (`message_agent`) -----------------------------------

  /**
   * Tool entry: queue a fire-and-forget delivery. Returns the acknowledgement
   * (or error) string shown to the calling model.
   */
  async messengerSend(
    senderConversationId: string,
    target: string,
    message: string
  ): Promise<string> {
    const db = this.deps.db
    const senderConversation = db.conversations.getById(senderConversationId)
    const senderAgent = senderConversation?.agentId
      ? db.agents.getById(senderConversation.agentId)
      : null
    if (!senderAgent) {
      return 'Error: message_agent is only available inside a bot chat (Bot Mode).'
    }
    const enabled = db.agents.listEnabled()
    const matched = matchBotName(
      enabled.map((agent) => agent.name),
      target
    )
    const targetAgent = matched ? enabled.find((agent) => agent.name === matched) : undefined
    if (!targetAgent) {
      const teammates = enabled
        .filter((agent) => agent.id !== senderAgent.id)
        .map((agent) => agent.name)
      return `Error: no bot named '${target}'. Teammates: ${teammates.join(', ') || '(none)'}.`
    }
    if (targetAgent.id === senderAgent.id) {
      return 'Error: you cannot message yourself.'
    }
    const hop = (this.turnHops.get(senderConversationId) ?? 0) + 1
    if (hop > MAX_BOT_HOPS) {
      return (
        'Error: this bot-to-bot chain is too deep. Let the thread end — summarize for the user ' +
        'instead of messaging further.'
      )
    }
    const delivery: PendingDelivery = {
      id: randomUUID(),
      senderAgentId: senderAgent.id,
      senderName: senderAgent.name,
      senderConversationId,
      targetAgentId: targetAgent.id,
      message,
      hop,
      attempts: 0,
    }
    const queue = this.queues.get(targetAgent.id) ?? []
    queue.push(delivery)
    this.queues.set(targetAgent.id, queue)
    // Fire and forget: the sender's turn continues; delivery pumps async.
    void this.pump(targetAgent.id)
    return (
      `Message queued for 🤖 ${targetAgent.name} (@${botSlug(targetAgent.name)}). ` +
      'Their reply will arrive in this chat later as an incoming message — finish your turn.'
    )
  }

  /** Starts the next queued delivery for a target, if its chat is free. */
  private async pump(targetAgentId: string): Promise<void> {
    const queue = this.queues.get(targetAgentId)
    if (!queue || queue.length === 0) return
    let chat: Conversation
    try {
      chat = this.ensureBotChat(targetAgentId)
    } catch {
      // Profile deleted while queued: fail every pending delivery for it.
      for (const dropped of queue.splice(0)) {
        this.deliverFailure(dropped, 'missing_config', 'the bot no longer exists')
      }
      return
    }
    if (this.inFlight.has(chat.id) || this.deps.chat.isConversationActive(chat.id)) {
      return // the completion hook pumps again when the current turn ends
    }
    const delivery = queue.shift()
    if (!delivery) return
    const content = formatIncomingBotMessage(delivery.senderName, delivery.message)
    this.turnHops.set(chat.id, delivery.hop)
    try {
      const result = await this.deps.chat.send({ conversationId: chat.id, content })
      this.inFlight.set(chat.id, {
        delivery,
        assistantMessageId: result.assistantMessage.id,
        timer: setTimeout(() => this.expire(chat.id, targetAgentId), DELIVERY_TIMEOUT_MS),
      })
      this.botsChanged({ agentId: targetAgentId })
    } catch (e) {
      this.turnHops.delete(chat.id)
      const text = errorMessageOf(e)
      if (text.includes('already streaming')) {
        // Lost the race with a user turn — requeue untouched; the completion
        // hook for that turn drains the queue.
        queue.unshift(delivery)
        return
      }
      const code = errorCodeOf(e)
      if (TRANSIENT_CODES.has(code) && delivery.attempts < 1) {
        // Hermes retry policy: transient failures retry ONCE, same chat,
        // history intact; auth/quota/config never retry.
        delivery.attempts += 1
        queue.unshift(delivery)
        setTimeout(() => void this.pump(targetAgentId), RETRY_DELAY_MS)
        return
      }
      this.deliverFailure(delivery, failureReason(code), text)
      void this.pump(targetAgentId)
    }
  }

  /**
   * Completion hook (registered in index.ts): fires after any assistant
   * message persists as 'complete'. Routes a finished delivery's reply back
   * to the sender and drains the target's queue.
   */
  handleCompletion(conversation: Conversation, message: Message): void {
    if (message.role !== 'assistant' || !conversation.agentId) return
    this.turnHops.delete(conversation.id)
    const entry = this.inFlight.get(conversation.id)
    if (entry && entry.assistantMessageId === message.id) {
      clearTimeout(entry.timer)
      this.inFlight.delete(conversation.id)
      this.routeReply(entry.delivery, message)
    }
    void this.pump(conversation.agentId)
    this.botsChanged({ agentId: conversation.agentId })
  }

  private routeReply(delivery: PendingDelivery, message: Message): void {
    const db = this.deps.db
    const targetAgent = db.agents.getById(delivery.targetAgentId)
    const targetName = targetAgent?.name ?? 'unknown bot'
    const senderChat = db.conversations.getById(delivery.senderConversationId)
    if (!senderChat) return // sender's chat was deleted meanwhile
    const reply = message.content.trim() || '[the bot returned no text]'
    this.insertMessage(senderChat.id, 'user', formatBotReply(targetName, reply))
    this.deps.broadcast(CHANNELS.conversationsChanged, { conversationId: senderChat.id })
    this.botsChanged({ agentId: senderChat.agentId ?? undefined })
    this.deps.notify?.({
      title: `🤖 ${targetName} replied`,
      body: reply,
      status: 'ok',
      conversationId: senderChat.id,
    })
  }

  private expire(conversationId: string, targetAgentId: string): void {
    const entry = this.inFlight.get(conversationId)
    if (!entry) return
    this.inFlight.delete(conversationId)
    this.turnHops.delete(conversationId)
    // The turn may have finished as 'complete' with the hook lost (e.g. app
    // relaunch mid-delivery leaves no hook at all) — check before failing.
    const message = this.deps.db.messages.getById(entry.assistantMessageId)
    if (message && message.status === 'complete') {
      this.routeReply(entry.delivery, message)
    } else {
      this.deliverFailure(
        entry.delivery,
        'delivery_timeout',
        'the reply did not arrive in time'
      )
    }
    void this.pump(targetAgentId)
  }

  private deliverFailure(delivery: PendingDelivery, reason: string, detail: string): void {
    const db = this.deps.db
    const senderChat = db.conversations.getById(delivery.senderConversationId)
    if (!senderChat) return
    const targetName = db.agents.getById(delivery.targetAgentId)?.name ?? 'unknown bot'
    this.insertMessage(
      senderChat.id,
      'user',
      formatDeliveryFailure(targetName, reason, detail)
    )
    this.deps.broadcast(CHANNELS.conversationsChanged, { conversationId: senderChat.id })
    this.botsChanged({})
    this.deps.notify?.({
      title: `🤖 message to ${targetName} failed`,
      body: `${reason}: ${detail}`,
      status: 'error',
      conversationId: senderChat.id,
    })
  }

  // -- group rooms --------------------------------------------------------------

  createGroup(input: { name: string; memberIds: string[] }): BotGroup {
    const members = this.resolveMembers(input.memberIds)
    const name = input.name.trim() || 'Group chat'
    const conversation = this.deps.db.conversations.create({ mode: 'chat', title: name })
    const group = this.deps.db.botGroups.create({
      name,
      memberIds: members.map((member) => member.id),
      conversationId: conversation.id,
    })
    this.botsChanged({ groupId: group.id })
    return group
  }

  updateGroup(id: string, patch: { name?: string; memberIds?: string[] }): BotGroup {
    const db = this.deps.db
    let group = db.botGroups.getById(id)
    if (!group) throw new Error('Unknown group.')
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) throw new Error('A group needs a name.')
      // Renaming changes only the display name (room identity is the id).
      group = db.botGroups.rename(id, name) ?? group
      db.conversations.update(group.conversationId, { title: name })
    }
    if (patch.memberIds !== undefined) {
      const members = this.resolveMembers(patch.memberIds)
      group = db.botGroups.setMembers(id, members.map((member) => member.id)) ?? group
    }
    this.botsChanged({ groupId: id })
    return group
  }

  /** Disband: permanent — the transcript conversation goes with it (Hermes). */
  deleteGroup(id: string): void {
    const group = this.deps.db.botGroups.getById(id)
    if (!group) return
    this.stopGroup(id)
    this.deps.db.conversations.remove(group.conversationId)
    this.deps.db.botGroups.remove(id)
    this.botsChanged({ groupId: id })
  }

  markGroupSeen(id: string): void {
    this.deps.db.botGroups.setNeedsUser(id, false)
    this.botsChanged({ groupId: id })
  }

  stopGroup(id: string): void {
    this.activeGroups.get(id)?.abort()
  }

  /**
   * User message into a room: persists it and kicks off up to three serial
   * reply-or-pass rounds. Returns once the message is persisted — turns run
   * detached and stream into the transcript via push events.
   */
  groupSend(groupId: string, content: string): void {
    const db = this.deps.db
    const group = db.botGroups.getById(groupId)
    if (!group) throw new Error('Unknown group.')
    if (this.activeGroups.has(groupId)) {
      throw new Error('The room is still settling — wait for the current rounds to finish.')
    }
    const members = group.memberIds
      .map((memberId) => db.agents.getById(memberId))
      .filter((agent): agent is AgentProfile => agent !== null && agent.enabled)
    if (members.length === 0) {
      throw new Error('No enabled bots are members of this room.')
    }
    const text = content.trim()
    if (!text) throw new Error('Say something first.')
    this.insertMessage(group.conversationId, 'user', text)
    db.botGroups.setNeedsUser(group.id, false)
    db.botGroups.touch(group.id, Date.now())
    this.deps.broadcast(CHANNELS.conversationsChanged, { conversationId: group.conversationId })
    this.botsChanged({ groupId: group.id })

    const mentioned = parseBotMentions(text, members.map((member) => member.name))
    const controller = new AbortController()
    this.activeGroups.set(groupId, controller)
    void this.runGroupRounds(group, members, mentioned, controller)
      .catch((e) => {
        console.error('[bots] group rounds failed:', errorMessageOf(e))
      })
      .finally(() => {
        this.activeGroups.delete(groupId)
        this.botsChanged({ groupId: group.id })
      })
  }

  private async runGroupRounds(
    group: BotGroup,
    members: AgentProfile[],
    mentioned: string[],
    controller: AbortController
  ): Promise<void> {
    const db = this.deps.db
    const memberNames = members.map((member) => member.name)
    const identities = members.map(identity)
    const byId = new Map(members.map((member) => [member.id, member]))
    let messageCount = 0
    for (let round = 1; round <= GROUP_MAX_ROUNDS; round++) {
      const participants = planRoundParticipants(memberNames, mentioned, round)
      let spoke = false
      for (const name of participants) {
        if (controller.signal.aborted || messageCount >= GROUP_MAX_MESSAGES) return
        const agent = members.find((member) => member.name === name)
        if (!agent) continue
        const transcript = db.messages
          .listByConversation(group.conversationId)
          .filter(
            (m) =>
              (m.role === 'user' || m.role === 'assistant') &&
              (m.status === 'complete' || m.status === 'stopped') &&
              m.content.trim().length > 0
          )
          .map((m) => ({
            speaker: m.agentId ? (byId.get(m.agentId)?.name ?? 'Unknown bot') : 'User',
            text: m.content,
          }))
        const prompt = buildGroupTurnPrompt({
          self: identity(agent),
          roomName: group.name,
          members: identities,
          transcript,
        })
        let reply: string
        try {
          reply = await this.deps.chat.generateForWorkflow(prompt, undefined, undefined, {
            useTools: false,
            agentId: agent.id,
            signal: controller.signal,
            usage: { runKind: 'other', refId: group.id },
          })
        } catch (e) {
          // A member's failure is never fatal to the room (Hermes: advisor
          // failures are captured, not propagated). Aborts end the rounds.
          if (controller.signal.aborted) return
          console.error(`[bots] group turn failed for ${agent.name}:`, errorMessageOf(e))
          continue
        }
        if (isPassReply(reply) || reply.trim().length === 0) continue
        this.insertMessage(group.conversationId, 'assistant', reply.trim(), agent.id)
        messageCount += 1
        spoke = true
        db.botGroups.touch(group.id, Date.now())
        this.deps.broadcast(CHANNELS.conversationsChanged, {
          conversationId: group.conversationId,
        })
        this.botsChanged({ groupId: group.id })
        if (mentionsUser(reply)) {
          db.botGroups.setNeedsUser(group.id, true)
          this.deps.notify?.({
            title: `🤖 ${group.name} needs you`,
            body: `${agent.name}: ${reply.trim().slice(0, 200)}`,
            status: 'ok',
            groupId: group.id,
          })
        }
      }
      if (!spoke) return // a full silent round settles the room
    }
  }

  private resolveMembers(memberIds: string[]): AgentProfile[] {
    const unique = [...new Set(memberIds)]
    const members = unique
      .map((id) => this.deps.db.agents.getById(id))
      .filter((agent): agent is AgentProfile => agent !== null)
    if (members.length < GROUP_MIN_MEMBERS || members.length > GROUP_MAX_MEMBERS) {
      throw new Error(
        `A group chat holds ${GROUP_MIN_MEMBERS}–${GROUP_MAX_MEMBERS} bots (got ${members.length}).`
      )
    }
    return members
  }

  // -- routines -----------------------------------------------------------------

  /**
   * Mirrors a scheduled-task run into the owning bot's canonical chat
   * (Hermes: "routines execute runs directly into the bot's chat history").
   * Never throws — a mirroring failure must not fail the run it describes.
   */
  mirrorRoutineResult(task: ScheduledTask, outcome: 'ok' | 'error', text: string): void {
    try {
      if (!task.agentId) return
      const agent = this.deps.db.agents.getById(task.agentId)
      if (!agent) return
      const chat = this.ensureBotChat(agent.id)
      this.insertMessage(chat.id, 'user', `Routine "${task.title}" ran (scheduled).`)
      this.insertMessage(
        chat.id,
        'assistant',
        outcome === 'ok' ? text : `The routine failed: ${text}`,
        agent.id
      )
      this.deps.broadcast(CHANNELS.conversationsChanged, { conversationId: chat.id })
      this.botsChanged({ agentId: agent.id })
    } catch (e) {
      console.error('[bots] routine mirror failed:', errorMessageOf(e))
    }
  }

  // -- helpers ------------------------------------------------------------------

  private insertMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    agentId?: string
  ): Message {
    const message: Message = {
      id: randomUUID(),
      conversationId,
      role,
      content,
      status: 'complete',
      ...(agentId ? { agentId } : {}),
      seq: this.deps.db.messages.nextSeq(conversationId),
      createdAt: Date.now(),
    }
    this.deps.db.messages.insert(message)
    this.deps.db.conversations.touch(conversationId, message.createdAt)
    return message
  }

  private botsChanged(payload: { agentId?: string | null; groupId?: string | null }): void {
    this.deps.broadcast(CHANNELS.botsChanged, payload)
  }
}
