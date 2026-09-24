/**
 * Bot Mode (v46) — the service behind the Bots pane, modeled on Hermes
 * Desktop's Bot Mode:
 *
 * - Canonical bot chats: one persistent conversation per agent profile
 *   (conversations.agent_id), created lazily. User turns in it ride the
 *   ordinary interactive send() pipeline; the bot's persona/memories/model
 *   pin/toolset are applied there by the chat service.
 * - Bot-to-bot messaging (`message_agent`): fire-and-forget deliveries,
 *   durable since v48 (a2a_outbox rows pumped per target, strictly FIFO). A
 *   delivery becomes a turn in the target's canonical chat; the completed
 *   reply is routed back into the sender's chat as an incoming message plus a
 *   desktop notification. One retry for transient provider failures, one
 *   redelivery after a restart, and a hop counter that stops ping-pong chains.
 * - Group rooms: one shared conversation, serial reply-or-pass rounds with
 *   Hermes caps (3 rounds / 10 messages per user send), @mention scoping and
 *   @user escalation ("needs you").
 * - Routine mirroring: a scheduled task owned by an agent reports its result
 *   into the bot's canonical chat.
 */

import { createHash, randomUUID } from 'node:crypto'
import { CHANNELS } from '@shared/ipc'
import type {
  A2aOutboxEntry,
  AgentProfile,
  BotAttention,
  BotGroup,
  BotGroupActivation,
  BotGroupMode,
  BotModeSettings,
  BotWakeEvent,
  BotRoster,
  Conversation,
  DelegateFinishedInfo,
  DelegateHandoffInfo,
  Message,
  MessageHandoff,
  MoaModelRef,
  ProviderErrorCode,
  ScheduledTask,
} from '@shared/types'
import type { AppDatabase } from '../db/database'
import {
  buildEnsembleAdvisorPrompt,
  buildEnsembleLeadPrompt,
  buildGroupTurnPrompt,
  buildHeartbeatPrompt,
  ENSEMBLE_ADVISOR_PERSONA,
  ENSEMBLE_LEAD_PERSONA,
  botSlug,
  formatBotReply,
  formatDelegationMarker,
  formatDelegationRequest,
  formatDeliveryFailure,
  formatHandoffMarker,
  formatIncomingBotMessage,
  formatIncomingEvent,
  GROUP_MIN_MEMBERS,
  isHeartbeatQuiet,
  isPassReply,
  matchBotName,
  mentionsUser,
  parseBotMentions,
  planRoundParticipants,
  resolveBotModeLimits,
  type BotIdentity,
} from './bot-prompts'
import { sanitizeUntrusted, wrapUntrusted } from './untrusted'

/** A delivery not answered within this window fails as delivery_timeout. */
const DELIVERY_TIMEOUT_MS = 10 * 60_000
/** Backoff before the single transient-failure retry. */
const RETRY_DELAY_MS = 10_000
/**
 * Send attempts per delivery: the first one plus ONE more — a transient
 * provider failure retries once, a restart mid-reply redelivers once. Both
 * budgets come from the same persisted counter, so a row never loops.
 */
const MAX_DELIVERY_ATTEMPTS = 2
/** Settled outbox rows older than this are pruned at boot. */
const OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60_000
/** A mirrored delegation result is capped so it cannot swamp the bot's context. */
const DELEGATE_MIRROR_MAX_CHARS = 40_000
/** An event payload handed to a bot is capped the same way the trigger endpoint caps bodies. */
const WAKE_PAYLOAD_MAX_CHARS = 64_000
/** "Wrote within the last 90 s" half of the active-now strip (Hermes). */
const ACTIVE_RECENT_MS = 90_000
/** Heartbeat/auto-compact maintenance tick. */
const MAINTENANCE_TICK_MS = 60_000
/** Floor on the heartbeat cadence (cost guard; OpenClaw defaults 30–60 min). */
export const HEARTBEAT_MIN_MINUTES = 15
/** A heartbeat turn nobody finished stops being tracked after this window. */
const HEARTBEAT_TIMEOUT_MS = 10 * 60_000

/** The narrow chat-service surface the bot service needs (test seam). */
export interface BotChatService {
  /**
   * The real signature returns ChatSendResult; without `queueIfBusy` a busy
   * chat throws, so bot callers only ever see a started stream — but the
   * result type stays loose (`assistantMessage` optional) for assignability.
   */
  send(req: {
    conversationId: string
    content: string
  }): Promise<{ queued?: boolean; userMessage?: Message | null; assistantMessage?: Message }>
  isConversationActive(conversationId: string): boolean
  compactNow(conversationId: string): Promise<{ compacted: boolean }>
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
  /** A pending approval/question raised from a conversation (roster needs-you state, v49). */
  hasPendingFor?: (conversationId: string) => boolean
}

/** The delivery whose turn is running in a target chat (this process only). */
interface InFlightDelivery {
  outboxId: string
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

/** Roster attention precedence (v49): needs_you > unread > working > idle. */
export function resolveAttention(flags: {
  working: boolean
  needsYou: boolean
  unread: boolean
}): BotAttention {
  if (flags.needsYou) return 'needs_you'
  if (flags.unread) return 'unread'
  if (flags.working) return 'working'
  return 'idle'
}

/** A bot-authored message newer than the user's last look = unread. */
export function isUnread(lastBotAt: number | null, seenAt: number | null): boolean {
  return lastBotAt !== null && (seenAt === null || lastBotAt > seenAt)
}

export class BotService {
  /**
   * The delivery whose turn is currently running, keyed by target CONVERSATION
   * id. Queued deliveries live in a2a_outbox (v48), not in memory.
   */
  private readonly inFlight = new Map<string, InFlightDelivery>()
  /** Chats whose running turn was started by an outside event (v50; the approval gate reads it). */
  private readonly eventTurns = new Set<string>()
  /** Targets with a pump in progress (single-flight per target). */
  private readonly pumping = new Set<string>()
  /** Targets whose running pump was asked to go another round. */
  private readonly pumpAgain = new Set<string>()
  private recovered = false
  /** Delivery hop depth of the turn currently running in a conversation. */
  private readonly turnHops = new Map<string, number>()
  /** One active round-runner per group room. */
  private readonly activeGroups = new Map<string, AbortController>()
  /** User sends that arrived while a room was settling (drained afterwards). */
  private readonly pendingGroupSends = new Map<string, string[]>()
  /** Heartbeat turns awaiting completion, keyed by conversation id (v47). */
  private readonly pendingHeartbeats = new Map<
    string,
    {
      agentId: string
      userMessageId: string | null
      assistantMessageId: string
      deliver: 'chat' | 'notify'
      timer: NodeJS.Timeout
    }
  >()
  /** Last heartbeat start per agent (in-memory; boot counts as a fresh beat). */
  private readonly lastHeartbeatAt = new Map<string, number>()
  /** Idle auto-compact: the lastMessageAt already attempted, per agent. */
  private readonly idleCompactAttempted = new Map<string, number>()
  /** Daily auto-compact: the local day (YYYY-MM-DD) already compacted, per agent. */
  private readonly dailyCompactDone = new Map<string, string>()
  private maintenanceTimer: NodeJS.Timeout | null = null
  private readonly bootedAt = Date.now()

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
    // Outbox, both directions: rows addressed TO the bot fail visibly in their
    // senders' chats (what pump does when the target is gone); rows it SENT
    // are cancelled — its chat, the reply destination, goes with it.
    for (const row of this.deps.db.a2aOutbox.listOpen({ toAgentId: agent.id })) {
      if (row.targetConversationId) {
        const entry = this.inFlight.get(row.targetConversationId)
        if (entry?.outboxId === row.id) {
          clearTimeout(entry.timer)
          this.inFlight.delete(row.targetConversationId)
        }
      }
      this.deliverFailure(row, 'missing_config', 'the bot no longer exists')
    }
    for (const row of this.deps.db.a2aOutbox.cancelForSender(agent.id)) {
      this.onSettled({ ...row, status: 'cancelled' }, null)
    }
    if (agent.chatConversationId) {
      const entry = this.inFlight.get(agent.chatConversationId)
      if (entry) clearTimeout(entry.timer)
      this.inFlight.delete(agent.chatConversationId)
      this.turnHops.delete(agent.chatConversationId)
      const heartbeat = this.pendingHeartbeats.get(agent.chatConversationId)
      if (heartbeat) clearTimeout(heartbeat.timer)
      this.pendingHeartbeats.delete(agent.chatConversationId)
      this.deps.db.conversations.remove(agent.chatConversationId)
    }
    this.lastHeartbeatAt.delete(agent.id)
    this.idleCompactAttempted.delete(agent.id)
    this.dailyCompactDone.delete(agent.id)
    this.deps.db.botGroups.removeMemberEverywhere(agent.id)
    this.deps.db.botBindings.remove(agent.id)
    this.deps.db.secrets.deleteAllFor('im_bridge', `bot:${agent.id}`)
    this.botsChanged({ agentId: agent.id })
  }

  // -- roster -------------------------------------------------------------------

  roster(): BotRoster {
    const db = this.deps.db
    const now = Date.now()
    const runningRuns = db.agentPlatform.listRunning()
    const runningRoutineOwners = new Set(
      db.scheduledTasks
        .list()
        .filter((task) => task.agentId && task.lastStatus === 'running')
        .map((task) => task.agentId as string)
    )
    const pendingFor = (conversationId: string): boolean =>
      this.deps.hasPendingFor?.(conversationId) ?? false
    const bots = db.agents.list().map((agent) => {
      const conversationId = agent.chatConversationId
      const last = conversationId ? db.messages.lastSnippet(conversationId) : null
      const inFlight = conversationId !== null && this.inFlight.has(conversationId)
      const queuedCount = db.a2aOutbox.countQueued(agent.id)
      const working =
        inFlight ||
        queuedCount > 0 ||
        (conversationId !== null && this.deps.chat.isConversationActive(conversationId)) ||
        runningRoutineOwners.has(agent.id) ||
        runningRuns.some((run) => run.agentId === agent.id)
      const active = working || (last !== null && now - last.createdAt < ACTIVE_RECENT_MS)
      const needsYou = conversationId !== null && pendingFor(conversationId)
      const unread =
        conversationId !== null &&
        isUnread(db.messages.lastBotAuthoredAt(conversationId), agent.chatSeenAt)
      return {
        agent,
        conversationId,
        lastMessageAt: last?.createdAt ?? null,
        snippet: last ? last.content.replace(/\s+/g, ' ').trim().slice(0, 100) : null,
        active,
        queuedCount,
        inFlight,
        attention: resolveAttention({ working, needsYou, unread }),
      }
    })
    const groups = db.botGroups.list().map((group) => {
      const last = db.messages.lastSnippet(group.conversationId)
      const working = this.activeGroups.has(group.id)
      const needsYou = group.needsUser || pendingFor(group.conversationId)
      const unread = isUnread(db.messages.lastBotAuthoredAt(group.conversationId), group.seenAt)
      return {
        group,
        lastMessageAt: last?.createdAt ?? null,
        snippet: last ? last.content.replace(/\s+/g, ' ').trim().slice(0, 100) : null,
        active: working,
        attention: resolveAttention({ working, needsYou, unread }),
      }
    })
    return { bots, groups }
  }

  /** The user is looking at the bot's chat: clears its unread state (v49). */
  markBotSeen(agentId: string): void {
    this.deps.db.agents.markChatSeen(agentId, Date.now())
    this.botsChanged({ agentId })
  }

  /**
   * Visible bots and rooms that need the user or hold unread bot messages —
   * the Bots share of the dock/tray badge (v49).
   */
  attentionCount(): number {
    const roster = this.roster()
    const wants = (attention: BotAttention): boolean =>
      attention === 'needs_you' || attention === 'unread'
    return (
      roster.bots.filter((row) => !row.agent.hidden && wants(row.attention)).length +
      roster.groups.filter((row) => wants(row.attention)).length
    )
  }

  // -- bot-to-bot messaging (`message_agent`, durable a2a_outbox since v48) --

  /**
   * Tool entry: persist a fire-and-forget delivery and pump the target's
   * queue. Returns the acknowledgement (or error) string shown to the calling
   * model. The row survives restarts — see `recover()`.
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
    // Bot-to-bot allowlist (v47, OpenClaw governance): null = open (the Hermes
    // default), a list fences who this bot may address, [] disables messaging.
    if (senderAgent.messageAllow && !senderAgent.messageAllow.includes(targetAgent.id)) {
      const allowedNames = senderAgent.messageAllow
        .map((id) => db.agents.getById(id)?.name)
        .filter((name): name is string => !!name)
      return allowedNames.length > 0
        ? `Error: you are not allowed to message ${targetAgent.name}. You may message: ${allowedNames.join(', ')}.`
        : 'Error: bot-to-bot messaging is disabled for you.'
    }
    const hop = (this.turnHops.get(senderConversationId) ?? 0) + 1
    if (hop > this.limits().maxHops) {
      return (
        'Error: this bot-to-bot chain is too deep. Let the thread end — summarize for the user ' +
        'instead of messaging further.'
      )
    }
    const outboxId = randomUUID()
    // Data, never instructions: stored verbatim except for chat-template
    // token literals (the same posture as fetched web content, v47).
    const body = sanitizeUntrusted(message)
    db.driver.transaction(() => {
      // The sender-side marker: a system row (invisible to the model — the
      // tool result already told it) whose card follows the row's status.
      const marker = this.insertMessage(
        senderConversationId,
        'system',
        formatHandoffMarker(targetAgent.name, body),
        senderAgent.id,
        {
          outboxId,
          direction: 'out',
          fromAgentId: senderAgent.id,
          toAgentId: targetAgent.id,
          fromName: senderAgent.name,
          toName: targetAgent.name,
          status: 'queued',
          updatedAt: Date.now(),
        }
      )
      db.a2aOutbox.insert({
        id: outboxId,
        fromAgentId: senderAgent.id,
        toAgentId: targetAgent.id,
        conversationId: senderConversationId,
        body,
        hop,
        handoffMessageId: marker.id,
      })
    })
    this.deps.broadcast(CHANNELS.conversationsChanged, { conversationId: senderConversationId })
    this.botsChanged({ agentId: targetAgent.id })
    // Fire and forget: the sender's turn continues; delivery pumps async.
    void this.pump(targetAgent.id)
    return (
      `Message queued for 🤖 ${targetAgent.name} (@${botSlug(targetAgent.name)}). ` +
      'Their reply will arrive in this chat later as an incoming message — finish your turn.'
    )
  }

  /**
   * Event → bot (v50): an outside event — the trigger endpoint, a watched
   * folder, a manual test — becomes ONE user-role turn in the bot's canonical
   * chat, through the same durable outbox as a teammate's message: it queues
   * behind a busy chat, survives a restart, and runs the bot's normal
   * interactive tool loop with the usual approvals. The payload is data,
   * never instructions: wrapped in untrusted-content markers. Resolves once
   * the row is queued, never when the turn ends.
   */
  async wake(agentId: string, event: BotWakeEvent): Promise<{ deliveryId: string }> {
    const db = this.deps.db
    const agent = db.agents.getById(agentId)
    if (!agent || !agent.enabled) throw new Error('Unknown or disabled bot.')
    const label = event.label.replace(/\s+/g, ' ').trim().slice(0, 120) || event.source
    const body =
      `"${label}" via ${event.source}:\n` +
      wrapUntrusted(event.payload.slice(0, WAKE_PAYLOAD_MAX_CHARS), `${event.source} ${label}`)
    const row = db.a2aOutbox.insert({
      id: randomUUID(),
      fromAgentId: null,
      toAgentId: agent.id,
      conversationId: null,
      body,
      hop: 1,
    })
    this.botsChanged({ agentId: agent.id })
    void this.pump(agent.id)
    return { deliveryId: row.id }
  }

  /**
   * Starts the oldest queued delivery for a target, if its chat is free.
   * Single-flight per target: the DB read is no longer an atomic shift, so a
   * second pump racing the first must not start the same row twice.
   */
  private async pump(targetAgentId: string): Promise<void> {
    if (this.pumping.has(targetAgentId)) {
      // A pump requested while one runs (e.g. a completion hook landing in
      // the microtask window after a delivery) must not be dropped: the
      // running loop goes one more round.
      this.pumpAgain.add(targetAgentId)
      return
    }
    this.pumping.add(targetAgentId)
    try {
      do {
        this.pumpAgain.delete(targetAgentId)
        if (await this.pumpOnce(targetAgentId)) this.pumpAgain.add(targetAgentId)
      } while (this.pumpAgain.has(targetAgentId))
    } catch (e) {
      // A background pump must never surface as an unhandled rejection.
      console.error('[bots] delivery pump failed:', errorMessageOf(e))
    } finally {
      this.pumping.delete(targetAgentId)
    }
  }

  /** One delivery attempt for a target. Resolves true when the next row should be tried at once. */
  private async pumpOnce(targetAgentId: string): Promise<boolean> {
    const db = this.deps.db
    const next = db.a2aOutbox.nextQueued(targetAgentId)
    if (!next) return false
    let chat: Conversation
    try {
      chat = this.ensureBotChat(targetAgentId)
    } catch {
      // Profile deleted while queued: fail every pending delivery for it.
      for (const dropped of db.a2aOutbox.listOpen({ toAgentId: targetAgentId })) {
        this.deliverFailure(dropped, 'missing_config', 'the bot no longer exists')
      }
      return false
    }
    if (this.inFlight.has(chat.id) || this.deps.chat.isConversationActive(chat.id)) {
      return false // the completion hook (or the maintenance tick) pumps again later
    }
    const senderName = next.fromAgentId
      ? (db.agents.getById(next.fromAgentId)?.name ?? 'unknown bot')
      : null
    const content = senderName
      ? formatIncomingBotMessage(senderName, next.body)
      : formatIncomingEvent(next.body)
    this.turnHops.set(chat.id, next.hop)
    if (next.fromAgentId === null) this.eventTurns.add(chat.id)
    else this.eventTurns.delete(chat.id)
    try {
      const result = await this.deps.chat.send({ conversationId: chat.id, content })
      if (!result.assistantMessage) {
        // Defensive: only a queued result lacks the placeholder, and bot
        // deliveries never opt into queueing — the row stays queued and the
        // completion hook pumps again.
        this.turnHops.delete(chat.id)
        return false
      }
      db.a2aOutbox.markDelivered(next.id, {
        targetConversationId: chat.id,
        assistantMessageId: result.assistantMessage.id,
      })
      this.inFlight.set(chat.id, {
        outboxId: next.id,
        assistantMessageId: result.assistantMessage.id,
        timer: setTimeout(() => this.expire(chat.id, targetAgentId), DELIVERY_TIMEOUT_MS),
      })
      this.onDelivered(next, result.userMessage ?? null)
      this.botsChanged({ agentId: targetAgentId })
      return false
    } catch (e) {
      this.turnHops.delete(chat.id)
      this.eventTurns.delete(chat.id)
      const text = errorMessageOf(e)
      if (text.includes('already streaming')) {
        // Lost the race with a user turn — the row is still queued; the
        // completion hook for that turn drains it.
        return false
      }
      const code = errorCodeOf(e)
      if (TRANSIENT_CODES.has(code) && next.attempts + 1 < MAX_DELIVERY_ATTEMPTS) {
        // Hermes retry policy: transient failures retry ONCE, same chat,
        // history intact; auth/quota/config never retry.
        db.a2aOutbox.bumpAttempts(next.id)
        setTimeout(() => void this.pump(targetAgentId), RETRY_DELAY_MS)
        return false
      }
      this.deliverFailure(next, failureReason(code), text)
      return true // try the next row for this target
    }
  }

  /** The delivered turn: tag the target's incoming row, move the sender's marker. */
  private onDelivered(entry: A2aOutboxEntry, userMessage: Message | null): void {
    if (userMessage) {
      this.deps.db.messages.update(userMessage.id, {
        handoff: this.handoffFor(entry, 'in', 'delivered'),
      })
    }
    this.updateMarker(entry, 'delivered')
  }

  /**
   * Completion hook (registered in index.ts): fires after any assistant
   * message persists as 'complete'. Routes a finished delivery's reply back
   * to the sender and drains the target's queue.
   */
  handleCompletion(conversation: Conversation, message: Message): void {
    if (message.role !== 'assistant' || !conversation.agentId) return
    this.turnHops.delete(conversation.id)
    this.eventTurns.delete(conversation.id)
    // Heartbeat turns settle first: a quiet NO_REPLY turn is deleted outright
    // (OpenClaw suppresses quiet acknowledgments), an alerting one stays and
    // is delivered per the bot's config.
    const heartbeat = this.pendingHeartbeats.get(conversation.id)
    if (heartbeat && heartbeat.assistantMessageId === message.id) {
      clearTimeout(heartbeat.timer)
      this.pendingHeartbeats.delete(conversation.id)
      this.settleHeartbeat(conversation, heartbeat, message)
    }
    const entry = this.inFlight.get(conversation.id)
    if (entry && entry.assistantMessageId === message.id) {
      clearTimeout(entry.timer)
      this.inFlight.delete(conversation.id)
      const row = this.deps.db.a2aOutbox.getById(entry.outboxId)
      if (row) this.routeReply(row, message)
    } else {
      // DB-authoritative fallback: a delivered row this process no longer
      // tracks (e.g. its timer expired without a reply) still gets routed.
      const row = this.deps.db.a2aOutbox.inFlightFor(conversation.id)
      if (row && row.assistantMessageId === message.id) this.routeReply(row, message)
    }
    void this.pump(conversation.agentId)
    this.botsChanged({ agentId: conversation.agentId })
  }

  private settleHeartbeat(
    conversation: Conversation,
    heartbeat: { agentId: string; userMessageId: string | null; deliver: 'chat' | 'notify' },
    message: Message
  ): void {
    const agentName = this.deps.db.agents.getById(heartbeat.agentId)?.name ?? 'bot'
    if (isHeartbeatQuiet(message.content)) {
      // Nothing needed attention — remove the turn so the chat stays clean.
      if (heartbeat.userMessageId) this.deps.db.messages.deleteById(heartbeat.userMessageId)
      this.deps.db.messages.deleteById(message.id)
      this.deps.broadcast(CHANNELS.conversationsChanged, { conversationId: conversation.id })
      return
    }
    if (heartbeat.deliver === 'notify') {
      this.deps.notify?.({
        title: `🤖 ${agentName} has something for you`,
        body: message.content.trim().slice(0, 300),
        status: 'ok',
        conversationId: conversation.id,
      })
    }
  }

  /**
   * Routes a finished reply into the sender's chat and closes the row. The
   * status transition and the reply row commit together, so a crash between
   * them can never leave a routed-but-open row for recovery to route twice.
   */
  private routeReply(entry: A2aOutboxEntry, message: Message): void {
    const db = this.deps.db
    if (entry.status !== 'delivered') return // already settled (cancelled/failed)
    const targetAgent = db.agents.getById(entry.toAgentId)
    const targetName = targetAgent?.name ?? 'unknown bot'
    const senderChat = entry.conversationId
      ? db.conversations.getById(entry.conversationId)
      : null
    const reply = message.content.trim() || '[the bot returned no text]'
    db.driver.transaction(() => {
      db.a2aOutbox.markReplied(entry.id)
      if (senderChat) {
        this.insertMessage(
          senderChat.id,
          'user',
          formatBotReply(targetName, reply),
          entry.toAgentId,
          this.handoffFor(entry, 'reply', 'replied')
        )
      }
      this.onSettled({ ...entry, status: 'replied' }, null)
    })
    if (!senderChat) {
      if (entry.conversationId === null) {
        // An event wake: there is no sender to route to — the bot's own chat
        // holds the answer; tell the user it happened.
        this.botsChanged({ agentId: entry.toAgentId })
        this.deps.notify?.({
          title: `🤖 ${targetName} handled an event`,
          body: reply,
          status: 'ok',
          conversationId: message.conversationId,
        })
      }
      return // else: the sender's chat was deleted meanwhile
    }
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
    this.eventTurns.delete(conversationId)
    const row = this.deps.db.a2aOutbox.getById(entry.outboxId)
    if (!row) return
    // The turn may have finished as 'complete' with the hook lost — check
    // before failing.
    const message = this.deps.db.messages.getById(entry.assistantMessageId)
    if (message && message.status === 'complete') {
      this.routeReply(row, message)
    } else {
      this.deliverFailure(row, 'delivery_timeout', 'the reply did not arrive in time')
    }
    void this.pump(targetAgentId)
  }

  private deliverFailure(entry: A2aOutboxEntry, reason: string, detail: string): void {
    const db = this.deps.db
    if (entry.status !== 'queued' && entry.status !== 'delivered') return
    const targetName = db.agents.getById(entry.toAgentId)?.name ?? 'unknown bot'
    const senderChat = entry.conversationId
      ? db.conversations.getById(entry.conversationId)
      : null
    db.driver.transaction(() => {
      db.a2aOutbox.markFailed(entry.id, `${reason}: ${detail}`)
      if (senderChat) {
        this.insertMessage(
          senderChat.id,
          'user',
          formatDeliveryFailure(targetName, reason, detail),
          entry.toAgentId,
          this.handoffFor(entry, 'reply', 'failed', reason)
        )
      }
      this.onSettled({ ...entry, status: 'failed' }, reason)
    })
    if (!senderChat) {
      if (entry.conversationId === null) {
        this.deps.notify?.({
          title: `🤖 ${targetName} could not handle an event`,
          body: `${reason}: ${detail}`,
          status: 'error',
          conversationId: entry.targetConversationId,
        })
      }
      return
    }
    this.deps.broadcast(CHANNELS.conversationsChanged, { conversationId: senderChat.id })
    this.botsChanged({})
    this.deps.notify?.({
      title: `🤖 message to ${targetName} failed`,
      body: `${reason}: ${detail}`,
      status: 'error',
      conversationId: senderChat.id,
    })
  }

  /** A row changed status: the sender-side marker follows it. */
  private onSettled(entry: A2aOutboxEntry, reason: string | null): void {
    this.updateMarker(entry, entry.status, reason)
  }

  private handoffFor(
    entry: A2aOutboxEntry,
    direction: MessageHandoff['direction'],
    status: MessageHandoff['status'],
    reason?: string | null
  ): MessageHandoff {
    const db = this.deps.db
    return {
      outboxId: entry.id,
      direction,
      fromAgentId: entry.fromAgentId,
      toAgentId: entry.toAgentId,
      fromName: entry.fromAgentId ? (db.agents.getById(entry.fromAgentId)?.name ?? 'unknown bot') : '',
      toName: db.agents.getById(entry.toAgentId)?.name ?? 'unknown bot',
      status,
      reason: reason ?? null,
      updatedAt: Date.now(),
    }
  }

  /**
   * Moves the sender-side marker to the row's current status. Tolerates a
   * missing marker (edit-and-rerun truncation deletes rows after the edited
   * turn) — the outbox row itself keeps working.
   */
  private updateMarker(entry: A2aOutboxEntry, status: MessageHandoff['status'], reason?: string | null): void {
    if (!entry.handoffMessageId || !entry.conversationId) return
    const marker = this.deps.db.messages.getById(entry.handoffMessageId)
    if (!marker?.handoff) return
    this.deps.db.messages.update(marker.id, {
      handoff: { ...marker.handoff, status, reason: reason ?? null, updatedAt: Date.now() },
    })
    this.deps.broadcast(CHANNELS.conversationsChanged, { conversationId: entry.conversationId })
  }

  /**
   * Boot recovery (v48). Must run AFTER messages.markDanglingStreamingAsStopped
   * so an interrupted target turn reads 'stopped', never 'streaming'. Settles
   * every 'delivered' row: a complete reply is routed (its completion hook
   * died with the process); anything else is redelivered once, then fails as
   * runtime_offline. Queued rows are pumped. Idempotent; never throws.
   */
  recover(): { routed: number; requeued: number; failed: number } {
    const counts = { routed: 0, requeued: 0, failed: 0 }
    if (this.recovered) return counts
    this.recovered = true
    const db = this.deps.db
    for (const row of db.a2aOutbox.listOpen()) {
      if (row.status !== 'delivered') continue
      try {
        const message = row.assistantMessageId ? db.messages.getById(row.assistantMessageId) : null
        if (message && message.status === 'complete') {
          this.routeReply(row, message)
          counts.routed += 1
        } else if (row.attempts < MAX_DELIVERY_ATTEMPTS) {
          db.a2aOutbox.requeue(row.id)
          this.onSettled({ ...row, status: 'queued' }, null)
          counts.requeued += 1
        } else {
          this.deliverFailure(row, 'runtime_offline', 'the app was closed while the bot was replying')
          counts.failed += 1
        }
      } catch (e) {
        console.error('[bots] recovery failed for delivery', row.id, errorMessageOf(e))
      }
    }
    try {
      db.a2aOutbox.pruneTerminal(Date.now() - OUTBOX_RETENTION_MS)
    } catch {
      // Housekeeping only.
    }
    for (const target of db.a2aOutbox.queuedTargets()) void this.pump(target)
    if (counts.routed + counts.requeued + counts.failed > 0) this.botsChanged({})
    return counts
  }

  /**
   * Why a bot chat's current turn runs (v50): 'event' while a turn started by
   * an outside event (webhook, watched file) is in progress — the tool
   * executor asks before such a turn messages a teammate.
   */
  turnOrigin(conversationId: string): 'event' | null {
    return this.eventTurns.has(conversationId) ? 'event' : null
  }

  /** Recent deliveries touching a bot, newest first (the editor's Deliveries card). */
  listOutbox(agentId: string): A2aOutboxEntry[] {
    return this.deps.db.a2aOutbox.listForAgent(agentId, 50)
  }

  // -- group rooms --------------------------------------------------------------

  createGroup(input: {
    name: string
    memberIds: string[]
    activation?: BotGroupActivation
    observerIds?: string[]
    mode?: BotGroupMode
    leadAgentId?: string | null
  }): BotGroup {
    const members = this.resolveMembers(input.memberIds)
    const name = input.name.trim() || 'Group chat'
    const memberIds = members.map((member) => member.id)
    const observerIds = (input.observerIds ?? []).filter((oid) => memberIds.includes(oid))
    const mode = input.mode ?? 'roundtable'
    const leadAgentId = mode === 'ensemble' ? (input.leadAgentId ?? null) : null
    this.assertLead(mode, memberIds, observerIds, leadAgentId)
    const conversation = this.deps.db.conversations.create({ mode: 'chat', title: name })
    const group = this.deps.db.botGroups.create({
      name,
      memberIds,
      conversationId: conversation.id,
      activation: input.activation,
      observerIds,
      mode,
      leadAgentId,
    })
    this.botsChanged({ groupId: group.id })
    return group
  }

  /** An ensemble room needs a lead that is a speaking (non-observer) member. */
  private assertLead(
    mode: BotGroupMode,
    memberIds: readonly string[],
    observerIds: readonly string[],
    leadAgentId: string | null
  ): void {
    if (mode !== 'ensemble') return
    if (!leadAgentId) throw new Error('An ensemble room needs a lead bot to synthesize the answers.')
    if (!memberIds.includes(leadAgentId)) throw new Error('The lead must be a member of the room.')
    if (observerIds.includes(leadAgentId)) throw new Error('The lead cannot be an observer.')
  }

  /**
   * Turns a Mixture-of-Agents preset into a visible ensemble room: one bot per
   * distinct advisor model (created on first use, reused after) and a lead bot
   * for the aggregator. The preset itself keeps working for /moa.
   */
  createGroupFromMoaPreset(presetId: string): BotGroup {
    const db = this.deps.db
    const preset = db.settings.get().moaPresets.find((candidate) => candidate.id === presetId)
    if (!preset || !preset.enabled) throw new Error('Unknown or disabled MoA preset.')
    const lead = this.ensureModelBot(preset.aggregator, 'lead', preset.name)
    const seen = new Set<string>([lead.id])
    const advisors: AgentProfile[] = []
    for (const ref of preset.referenceModels) {
      const bot = this.ensureModelBot(ref, 'advisor', preset.name)
      if (seen.has(bot.id)) continue
      seen.add(bot.id)
      advisors.push(bot)
    }
    if (advisors.length === 0) {
      throw new Error(
        'This preset needs at least one advisor model that differs from the aggregator.'
      )
    }
    return this.createGroup({
      name: preset.name,
      memberIds: [...advisors.map((bot) => bot.id), lead.id],
      mode: 'ensemble',
      leadAgentId: lead.id,
    })
  }

  /**
   * The bot standing in for one provider/model pair. Named "<provider> ·
   * <model>"; an existing bot with that name is reused when its pins match
   * (and re-enabled), otherwise a numbered name avoids the clash. Ordinary
   * profiles — the user may rename, re-persona or delete them.
   */
  private ensureModelBot(ref: MoaModelRef, role: 'advisor' | 'lead', presetName: string): AgentProfile {
    const db = this.deps.db
    const label = db.providers.getById(ref.providerId)?.label ?? ref.providerId
    const base = `${label} · ${ref.modelId}`.slice(0, 90)
    let name = base
    for (let attempt = 2; attempt < 50; attempt++) {
      const existing = db.agents.getByName(name)
      if (!existing) break
      if (existing.providerId === ref.providerId && existing.modelId === ref.modelId) {
        return existing.enabled ? existing : (db.agents.update(existing.id, { enabled: true }) ?? existing)
      }
      name = `${base} (${attempt})`
    }
    return db.agents.create({
      name,
      title: role === 'lead' ? 'Ensemble lead' : 'Ensemble advisor',
      description: `Created from the MoA preset "${presetName}"`,
      systemPrompt: role === 'lead' ? ENSEMBLE_LEAD_PERSONA : ENSEMBLE_ADVISOR_PERSONA,
      providerId: ref.providerId,
      modelId: ref.modelId,
      // Like MoA advisors: text in, text out, no tools.
      toolIds: [],
    })
  }

  updateGroup(
    id: string,
    patch: {
      name?: string
      memberIds?: string[]
      activation?: BotGroupActivation
      observerIds?: string[]
      mode?: BotGroupMode
      leadAgentId?: string | null
    }
  ): BotGroup {
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
    if (patch.memberIds !== undefined || patch.observerIds !== undefined) {
      const memberIds = (
        patch.memberIds !== undefined ? this.resolveMembers(patch.memberIds) : []
      ).map((member) => member.id)
      const effectiveMembers = patch.memberIds !== undefined ? memberIds : group.memberIds
      const observers = (patch.observerIds ?? group.observerIds).filter((oid) =>
        effectiveMembers.includes(oid)
      )
      group = db.botGroups.setMembers(id, effectiveMembers, observers) ?? group
    }
    if (patch.activation !== undefined) {
      group = db.botGroups.setActivation(id, patch.activation) ?? group
    }
    if (patch.mode !== undefined || patch.leadAgentId !== undefined) {
      const mode = patch.mode ?? group.mode
      const lead =
        mode === 'ensemble'
          ? patch.leadAgentId === undefined
            ? group.leadAgentId
            : patch.leadAgentId
          : null
      this.assertLead(mode, group.memberIds, group.observerIds, lead)
      group = db.botGroups.setMode(id, mode, lead) ?? group
    } else if (group.mode === 'ensemble' && !group.leadAgentId) {
      // The members changed and the lead left with them.
      throw new Error('An ensemble room needs a lead bot to synthesize the answers.')
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
    this.deps.db.botGroups.markSeen(id, Date.now())
    this.botsChanged({ groupId: id })
  }

  stopGroup(id: string): void {
    this.pendingGroupSends.delete(id)
    this.activeGroups.get(id)?.abort()
  }

  /**
   * User message into a room: persists it and kicks off member turns. Returns
   * once the message is persisted — turns run detached and land via push
   * events. A send while the room is still settling queues (v47, OpenClaw
   * collect semantics): the message joins the live transcript immediately and
   * triggers a fresh round-set once the current one finishes.
   */
  groupSend(groupId: string, content: string, requestId?: string): void {
    const db = this.deps.db
    const group = db.botGroups.getById(groupId)
    if (!group) throw new Error('Unknown group.')
    const fingerprint = createHash('sha256').update(`group:${content.trim()}`).digest('hex')
    if (requestId) {
      const receipt = db.driver.get<{ fingerprint: string }>('SELECT fingerprint FROM chat_send_receipts WHERE conversation_id = ? AND request_id = ?', [group.conversationId, requestId])
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new Error('This message identifier was already used. Send the edited message again.')
        return
      }
    }
    const members = group.memberIds
      .map((memberId) => db.agents.getById(memberId))
      .filter((agent): agent is AgentProfile => agent !== null && agent.enabled)
    if (members.length === 0) {
      throw new Error('No enabled bots are members of this room.')
    }
    const text = content.trim()
    if (!text) throw new Error('Say something first.')
    db.driver.transaction(() => {
      const message = this.insertMessage(group.conversationId, 'user', text)
      if (requestId) db.driver.run('INSERT INTO chat_send_receipts (conversation_id, request_id, fingerprint, message_id) VALUES (?, ?, ?, ?)', [group.conversationId, requestId, fingerprint, message.id])
    })
    db.botGroups.setNeedsUser(group.id, false)
    db.botGroups.touch(group.id, Date.now())
    this.deps.broadcast(CHANNELS.conversationsChanged, { conversationId: group.conversationId })
    this.botsChanged({ groupId: group.id })

    if (this.activeGroups.has(groupId)) {
      // Mid-rounds: the message is already in the transcript (running turns
      // see it); its mentions get their own round-set after settlement.
      const pending = this.pendingGroupSends.get(groupId) ?? []
      pending.push(text)
      this.pendingGroupSends.set(groupId, pending)
      return
    }
    this.startGroupRounds(group, members, text)
  }

  private startGroupRounds(group: BotGroup, members: AgentProfile[], text: string): void {
    const mentioned = parseBotMentions(text, members.map((member) => member.name))
    const controller = new AbortController()
    this.activeGroups.set(group.id, controller)
    const run =
      group.mode === 'ensemble'
        ? this.runEnsembleRound(group, members, controller)
        : this.runGroupRounds(group, members, mentioned, controller)
    void run
      .catch((e) => {
        console.error('[bots] group rounds failed:', errorMessageOf(e))
      })
      .finally(() => {
        this.activeGroups.delete(group.id)
        this.botsChanged({ groupId: group.id })
        this.drainPendingGroupSends(group.id)
      })
  }

  private drainPendingGroupSends(groupId: string): void {
    const pending = this.pendingGroupSends.get(groupId)
    if (!pending || pending.length === 0) return
    this.pendingGroupSends.delete(groupId)
    const db = this.deps.db
    const group = db.botGroups.getById(groupId)
    if (!group) return
    const members = group.memberIds
      .map((memberId) => db.agents.getById(memberId))
      .filter((agent): agent is AgentProfile => agent !== null && agent.enabled)
    if (members.length === 0) return
    // One coalesced round-set covers the burst (collect mode): the messages
    // are already in the transcript; mentions merge across all of them.
    this.startGroupRounds(group, members, pending.join('\n'))
  }

  /**
   * Round-table rounds. Since v50 the participants of ONE round answer in
   * parallel — each as its own run against the same transcript snapshot —
   * and their replies post in member order; members react to each other in
   * the NEXT round. PASS, the settlement rule and the caps (now settings)
   * are unchanged.
   */
  private async runGroupRounds(
    group: BotGroup,
    members: AgentProfile[],
    mentioned: string[],
    controller: AbortController
  ): Promise<void> {
    const db = this.deps.db
    const limits = this.limits()
    const observers = new Set(group.observerIds)
    // Open (unmentioned) rounds are for speaking members only; an observer
    // reads the room and takes a turn ONLY when @mentioned (v47).
    const speakerNames = members
      .filter((member) => !observers.has(member.id))
      .map((member) => member.name)
    const identities = members.map(identity)
    const byId = new Map(members.map((member) => [member.id, member]))
    let messageCount = 0
    // Activation 'mention' (v47, the OpenClaw group default): only @named bots
    // take one turn each — no open rounds, no settlement loop. Silence when
    // nobody is mentioned; the message stays as room context.
    const maxRounds = group.activation === 'mention' ? 1 : limits.groupMaxRounds
    if (group.activation === 'mention' && mentioned.length === 0) return
    for (let round = 1; round <= maxRounds; round++) {
      if (controller.signal.aborted || messageCount >= limits.groupMaxMessages) return
      const participants = planRoundParticipants(
        round === 1 && mentioned.length > 0 ? members.map((m) => m.name) : speakerNames,
        mentioned,
        round
      )
        .map((name) => members.find((member) => member.name === name))
        .filter((agent): agent is AgentProfile => agent !== undefined)
      const transcript = this.roomTranscript(group, byId)
      const outcomes = await Promise.allSettled(
        participants.map(async (agent) => ({
          agent,
          reply: await this.deps.chat.generateForWorkflow(
            buildGroupTurnPrompt({
              self: identity(agent),
              roomName: group.name,
              members: identities,
              transcript,
            }),
            undefined,
            undefined,
            {
              useTools: false,
              agentId: agent.id,
              signal: controller.signal,
              usage: { runKind: 'other', refId: group.id },
            }
          ),
        }))
      )
      if (controller.signal.aborted) return
      let spoke = false
      for (const outcome of outcomes) {
        if (messageCount >= limits.groupMaxMessages) break
        if (outcome.status === 'rejected') {
          // A member's failure is never fatal to the room (Hermes: advisor
          // failures are captured, not propagated).
          console.error('[bots] group turn failed:', errorMessageOf(outcome.reason))
          continue
        }
        const { agent, reply } = outcome.value
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

  /** The room transcript as the prompts see it (user + finished bot turns, oldest first). */
  private roomTranscript(
    group: BotGroup,
    byId: ReadonlyMap<string, AgentProfile>
  ): Array<{ speaker: string; text: string }> {
    return this.deps.db.messages
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
  }

  /**
   * Ensemble room (v50): every advisor answers the latest user message in
   * PARALLEL as its own run, the replies post in member order, and the lead
   * synthesizes one reply from them. No settlement loop, no PASS.
   */
  private async runEnsembleRound(
    group: BotGroup,
    members: AgentProfile[],
    controller: AbortController
  ): Promise<void> {
    const db = this.deps.db
    const byId = new Map(members.map((member) => [member.id, member]))
    const lead = group.leadAgentId ? byId.get(group.leadAgentId) : undefined
    const observers = new Set(group.observerIds)
    const advisors = members.filter((member) => member.id !== lead?.id && !observers.has(member.id))
    const identities = members.map(identity)
    const transcript = this.roomTranscript(group, byId)
    const generate = (agent: AgentProfile, prompt: string): Promise<string> =>
      this.deps.chat.generateForWorkflow(prompt, undefined, undefined, {
        useTools: false,
        agentId: agent.id,
        signal: controller.signal,
        usage: { runKind: 'other', refId: group.id },
      })

    const outcomes = await Promise.allSettled(
      advisors.map(async (agent) => ({
        agent,
        reply: await generate(
          agent,
          buildEnsembleAdvisorPrompt({
            self: identity(agent),
            roomName: group.name,
            members: identities,
            transcript,
          })
        ),
      }))
    )
    if (controller.signal.aborted) return
    const replies: Array<{ name: string; text: string }> = []
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        // An advisor's failure is never fatal (the MoA policy): the lead
        // synthesizes from whoever answered.
        console.error('[bots] ensemble advisor failed:', errorMessageOf(outcome.reason))
        continue
      }
      const text = outcome.value.reply.trim()
      if (!text) continue
      this.insertMessage(group.conversationId, 'assistant', text, outcome.value.agent.id)
      replies.push({ name: outcome.value.agent.name, text })
    }
    db.botGroups.touch(group.id, Date.now())
    this.deps.broadcast(CHANNELS.conversationsChanged, { conversationId: group.conversationId })
    this.botsChanged({ groupId: group.id })
    if (!lead || controller.signal.aborted) return

    let synthesis: string
    try {
      synthesis = await generate(
        lead,
        buildEnsembleLeadPrompt({
          self: identity(lead),
          roomName: group.name,
          members: identities,
          transcript,
          advisorReplies: replies,
        })
      )
    } catch (e) {
      if (controller.signal.aborted) return
      console.error(`[bots] ensemble lead failed for ${lead.name}:`, errorMessageOf(e))
      return
    }
    const text = synthesis.trim()
    if (!text || controller.signal.aborted) return
    this.insertMessage(group.conversationId, 'assistant', text, lead.id)
    db.botGroups.touch(group.id, Date.now())
    this.deps.broadcast(CHANNELS.conversationsChanged, { conversationId: group.conversationId })
    this.botsChanged({ groupId: group.id })
    if (mentionsUser(text)) {
      db.botGroups.setNeedsUser(group.id, true)
      this.deps.notify?.({
        title: `🤖 ${group.name} needs you`,
        body: `${lead.name}: ${text.slice(0, 200)}`,
        status: 'ok',
        groupId: group.id,
      })
    }
  }

  /** Effective caps from settings (v50), clamped; the Hermes numbers by default. */
  private limits(): BotModeSettings {
    return resolveBotModeLimits(this.deps.db.settings.get().botMode)
  }

  private resolveMembers(memberIds: string[]): AgentProfile[] {
    const unique = [...new Set(memberIds)]
    const members = unique
      .map((id) => this.deps.db.agents.getById(id))
      .filter((agent): agent is AgentProfile => agent !== null)
    const max = this.limits().groupMaxMembers
    if (members.length < GROUP_MIN_MEMBERS || members.length > max) {
      throw new Error(
        `A group chat holds ${GROUP_MIN_MEMBERS}–${max} bots (got ${members.length}).`
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

  // -- delegate handoffs (v49) ----------------------------------------------------

  /** In-flight delegations by key: the caller marker + the bot chat to mirror into. */
  private readonly pendingDelegates = new Map<
    string,
    { markerId: string | null; targetChatId: string }
  >()

  /**
   * delegate(agent=…) reached a bot: the request shows up in the bot's own
   * chat and the caller's transcript gets a handoff marker — a delegation is
   * a handoff like any other, not an invisible sub-process. Never throws.
   */
  delegateStarted(info: DelegateHandoffInfo): void {
    try {
      // A bot delegating to itself is already in that transcript.
      if (info.callerAgentId === info.agentId) return
      const db = this.deps.db
      if (info.callerSpaceId || db.conversations.getById(info.callerConversationId)?.spaceId) return
      const chat = this.ensureBotChat(info.agentId)
      const caller = info.callerAgentId ? db.agents.getById(info.callerAgentId) : null
      const callerLabel = caller
        ? `🤖 ${caller.name} (@${botSlug(caller.name)})`
        : `the user from "${info.callerTitle}"`
      const handoff: MessageHandoff = {
        outboxId: info.delegateKey,
        direction: 'delegate',
        fromAgentId: info.callerAgentId,
        toAgentId: info.agentId,
        fromName: caller?.name ?? '',
        toName: info.agentName,
        status: 'delivered',
        reason: null,
        updatedAt: Date.now(),
      }
      this.insertMessage(
        chat.id,
        'user',
        formatDelegationRequest(callerLabel, info.task),
        undefined,
        handoff
      )
      let markerId: string | null = null
      if (db.conversations.getById(info.callerConversationId)) {
        markerId = this.insertMessage(
          info.callerConversationId,
          'system',
          formatDelegationMarker(info.agentName, info.task),
          info.callerAgentId ?? undefined,
          handoff
        ).id
        this.deps.broadcast(CHANNELS.conversationsChanged, {
          conversationId: info.callerConversationId,
        })
      }
      this.pendingDelegates.set(info.delegateKey, { markerId, targetChatId: chat.id })
      this.deps.broadcast(CHANNELS.conversationsChanged, { conversationId: chat.id })
      this.botsChanged({ agentId: info.agentId })
    } catch (e) {
      console.error('[bots] delegate mirror failed:', errorMessageOf(e))
    }
  }

  /** The delegation ended: the result lands in the bot's chat, the caller marker settles. */
  delegateFinished(info: DelegateFinishedInfo): void {
    try {
      if (info.callerAgentId === info.agentId) return
      const db = this.deps.db
      const pending = this.pendingDelegates.get(info.delegateKey)
      this.pendingDelegates.delete(info.delegateKey)
      if (!pending || info.callerSpaceId || db.conversations.getById(info.callerConversationId)?.spaceId) return
      const known = pending ? db.conversations.getById(pending.targetChatId) : null
      const chat = known ?? this.ensureBotChat(info.agentId)
      const status: MessageHandoff['status'] =
        info.status === 'done' ? 'replied' : info.status === 'error' ? 'failed' : 'cancelled'
      const body = info.result.slice(0, DELEGATE_MIRROR_MAX_CHARS)
      const text =
        info.status === 'done'
          ? body
          : `The delegation ${info.status === 'error' ? 'failed' : 'was stopped'}: ${body}`
      this.insertMessage(chat.id, 'assistant', text, info.agentId)
      if (pending?.markerId) {
        const marker = db.messages.getById(pending.markerId)
        if (marker?.handoff) {
          db.messages.update(marker.id, {
            handoff: { ...marker.handoff, status, updatedAt: Date.now() },
          })
          this.deps.broadcast(CHANNELS.conversationsChanged, {
            conversationId: info.callerConversationId,
          })
        }
      }
      this.deps.broadcast(CHANNELS.conversationsChanged, { conversationId: chat.id })
      this.botsChanged({ agentId: info.agentId })
    } catch (e) {
      console.error('[bots] delegate mirror failed:', errorMessageOf(e))
    }
  }

  // -- maintenance: heartbeats + auto-compact (v47) -----------------------------

  /**
   * Starts the 60 s maintenance tick: due heartbeats and canonical-chat
   * auto-compaction. unref'd so it never keeps the process alive.
   */
  startMaintenance(): void {
    if (this.maintenanceTimer) return
    this.maintenanceTimer = setInterval(() => {
      void this.maintenanceTick()
    }, MAINTENANCE_TICK_MS)
    this.maintenanceTimer.unref?.()
  }

  stopMaintenance(): void {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer)
    this.maintenanceTimer = null
  }

  /** One pass over every enabled bot. Public for tests. */
  async maintenanceTick(now = Date.now()): Promise<void> {
    for (const agent of this.deps.db.agents.listEnabled()) {
      try {
        if (agent.heartbeat) await this.maybeHeartbeat(agent, now)
        if (agent.reset) await this.maybeAutoCompact(agent, now)
      } catch (e) {
        console.error(`[bots] maintenance failed for ${agent.name}:`, errorMessageOf(e))
      }
    }
    // Completion hooks fire only for 'complete' turns: a user turn that ended
    // in stopped/error would otherwise strand the target's queue until the
    // next completion. The tick closes that gap.
    for (const target of this.deps.db.a2aOutbox.queuedTargets()) void this.pump(target)
  }

  private async maybeHeartbeat(agent: AgentProfile, now: number): Promise<void> {
    const config = agent.heartbeat
    if (!config) return
    const everyMs = Math.max(config.everyMinutes, HEARTBEAT_MIN_MINUTES) * 60_000
    // Boot counts as a beat: no stampede right after launch, and a restart
    // never owes a backlog (OpenClaw heartbeats are cadence, not schedule).
    const last = this.lastHeartbeatAt.get(agent.id) ?? this.bootedAt
    if (now - last < everyMs) return
    const chat = this.ensureBotChat(agent.id)
    // Defer while anything is running or queued for this chat — a heartbeat
    // must never contend with real work (OpenClaw defers on queued work too).
    if (
      this.deps.chat.isConversationActive(chat.id) ||
      this.inFlight.has(chat.id) ||
      this.pendingHeartbeats.has(chat.id) ||
      this.deps.db.a2aOutbox.countQueued(agent.id) > 0
    ) {
      return
    }
    this.lastHeartbeatAt.set(agent.id, now)
    try {
      const result = await this.deps.chat.send({
        conversationId: chat.id,
        content: buildHeartbeatPrompt(config.prompt),
      })
      if (!result.assistantMessage) return // queued result can't happen here
      this.pendingHeartbeats.set(chat.id, {
        agentId: agent.id,
        userMessageId: result.userMessage?.id ?? null,
        assistantMessageId: result.assistantMessage.id,
        deliver: config.deliver,
        timer: setTimeout(() => {
          // Give up tracking a turn that never completed; whatever persisted
          // stays in the chat.
          this.pendingHeartbeats.delete(chat.id)
        }, HEARTBEAT_TIMEOUT_MS),
      })
    } catch (e) {
      // Missed beat (provider down, chat busy race): logged, retried next
      // cadence — heartbeats never surface errors to the user.
      console.error(`[bots] heartbeat failed for ${agent.name}:`, errorMessageOf(e))
    }
  }

  private async maybeAutoCompact(agent: AgentProfile, now: number): Promise<void> {
    const policy = agent.reset
    const chatId = agent.chatConversationId
    if (!policy || !chatId) return
    if (this.deps.chat.isConversationActive(chatId) || this.pendingHeartbeats.has(chatId)) return
    const last = this.deps.db.messages.lastSnippet(chatId)
    if (!last) return

    // Idle reset: compact once per quiet period — the attempt is keyed to the
    // latest message so an uncompactable (short) chat isn't retried every tick.
    const idleMinutes = policy.idleMinutes ?? null
    if (idleMinutes && now - last.createdAt >= idleMinutes * 60_000) {
      if (this.idleCompactAttempted.get(agent.id) !== last.createdAt) {
        this.idleCompactAttempted.set(agent.id, last.createdAt)
        await this.runAutoCompact(agent, chatId)
        return
      }
    }

    // Daily reset: once per local day at (or after) the configured hour.
    const dailyHour = policy.dailyHour ?? null
    if (dailyHour !== null && dailyHour !== undefined) {
      const date = new Date(now)
      const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
      if (date.getHours() >= dailyHour && this.dailyCompactDone.get(agent.id) !== day) {
        this.dailyCompactDone.set(agent.id, day)
        await this.runAutoCompact(agent, chatId)
      }
    }
  }

  private async runAutoCompact(agent: AgentProfile, conversationId: string): Promise<void> {
    try {
      const { compacted } = await this.deps.chat.compactNow(conversationId)
      if (compacted) {
        this.deps.broadcast(CHANNELS.conversationsChanged, { conversationId })
        this.botsChanged({ agentId: agent.id })
      }
    } catch (e) {
      console.error(`[bots] auto-compact failed for ${agent.name}:`, errorMessageOf(e))
    }
  }

  // -- helpers ------------------------------------------------------------------

  private insertMessage(
    conversationId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    agentId?: string,
    handoff?: MessageHandoff
  ): Message {
    const message: Message = {
      id: randomUUID(),
      conversationId,
      role,
      content,
      status: 'complete',
      ...(agentId ? { agentId } : {}),
      ...(handoff ? { handoff } : {}),
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
