/**
 * Per-bot Telegram bindings (v47, OpenClaw-style channel bindings): every bot
 * profile can run its OWN Telegram bot, paired to the owner's DM by a
 * one-time code (trust-on-first-use, same as the main bridge) and admitted to
 * groups only by owner commands sent inside the group.
 *
 * Inbound DMs and gated group messages become turns in the bot's canonical
 * chat — the full interactive pipeline (persona, memory, tools, approvals,
 * budget) — with queue-if-busy so bursts coalesce. Replies route back to the
 * originating Telegram chat via the completion hook.
 *
 * Group grammar (OpenClaw): admission is allowlist-only; activation is
 * 'mention' by default (speak only when @mentioned or replied to) or
 * 'always'; the owner toggles with /allowgroup, /denygroup and
 * /activation mention|always — verifiable because a Telegram PRIVATE chat id
 * equals the user id, so the paired DM identifies the owner in any group.
 */

import { randomInt } from 'node:crypto'
import { CHANNELS } from '@shared/ipc'
import type { BotBinding, BotBindingGroup, Conversation, Message } from '@shared/types'
import type { AppDatabase } from '../db/database'
import type { BotBindingRecord } from '../db/repositories/bot-bindings'
import type { Keystore } from '../keys/keystore'
import { TelegramBridge, type TelegramInbound } from './telegram'

const TOKEN_NAME = 'token'
const PAIRING_TTL_MS = 15 * 60_000
const PAIRING_MAX_ATTEMPTS = 5
/** A reply route that never flushed is dropped after this window. */
const ROUTE_TTL_MS = 15 * 60_000

const ownerId = (agentId: string): string => `bot:${agentId}`

export interface BotChannelServiceDeps {
  db: AppDatabase
  keystore: Pick<Keystore, 'encryptKey' | 'decryptKey'>
  /** Get-or-create the bot's canonical chat (BotService.ensureBotChat). */
  ensureBotChat: (agentId: string) => Conversation
  /**
   * Runs one turn in the bot's chat (chat.send with queueIfBusy) — a queued
   * result has no assistantMessage; the NEXT completed turn answers it.
   */
  sendToBot: (
    conversationId: string,
    content: string
  ) => Promise<{ queued?: boolean; assistantMessage?: Message | null }>
  broadcast: (channel: string, payload: unknown) => void
  fetchImpl?: typeof fetch
}

interface RunningBridge {
  bridge: TelegramBridge
  error: string | null
}

interface ReplyRoute {
  chatId: number
  /** Exact placeholder id, or null = "the next completed turn answers this". */
  assistantMessageId: string | null
  at: number
}

export class BotChannelService {
  private readonly bridges = new Map<string, RunningBridge>()
  /** Pending Telegram reply routes per canonical-chat conversation id. */
  private readonly routes = new Map<string, ReplyRoute[]>()

  constructor(private readonly deps: BotChannelServiceDeps) {}

  // -- lifecycle ---------------------------------------------------------------

  /** Reconciles running bridges with the bindings table. Safe to call often. */
  syncAll(): void {
    const wanted = new Set<string>()
    for (const binding of this.deps.db.botBindings.list()) {
      const agent = this.deps.db.agents.getById(binding.agentId)
      if (binding.enabled && agent?.enabled && this.hasToken(binding.agentId)) {
        wanted.add(binding.agentId)
        if (!this.bridges.has(binding.agentId)) this.startBridge(binding.agentId)
      }
    }
    for (const agentId of [...this.bridges.keys()]) {
      if (!wanted.has(agentId)) this.stopBridge(agentId)
    }
  }

  stopAll(): void {
    for (const agentId of [...this.bridges.keys()]) this.stopBridge(agentId)
  }

  private startBridge(agentId: string): void {
    const token = this.readToken(agentId)
    if (!token) return
    const bridge = new TelegramBridge({
      token,
      onMessage: async () => '', // unused: onInbound replaces it
      onInbound: (inbound) => this.handleInbound(agentId, inbound),
      onError: (message) => {
        const running = this.bridges.get(agentId)
        if (running) running.error = message
        this.deps.broadcast(CHANNELS.botsChanged, { agentId })
      },
      fetchImpl: this.deps.fetchImpl,
    })
    this.bridges.set(agentId, { bridge, error: null })
    bridge.start()
  }

  private stopBridge(agentId: string): void {
    this.bridges.get(agentId)?.bridge.stop()
    this.bridges.delete(agentId)
  }

  private restartBridge(agentId: string): void {
    this.stopBridge(agentId)
    this.syncAll()
  }

  // -- token + binding management (IPC surface) --------------------------------

  private hasToken(agentId: string): boolean {
    return this.deps.db.secrets.has('im_bridge', ownerId(agentId), TOKEN_NAME)
  }

  private readToken(agentId: string): string | null {
    const cipher = this.deps.db.secrets.getCipher('im_bridge', ownerId(agentId), TOKEN_NAME)
    if (!cipher) return null
    try {
      return this.deps.keystore.decryptKey(cipher.encryptedValue)
    } catch {
      return null
    }
  }

  describe(agentId: string): BotBinding | null {
    const record = this.deps.db.botBindings.getByAgent(agentId)
    if (!record) return null
    return this.toBinding(record)
  }

  private toBinding(record: BotBindingRecord): BotBinding {
    const running = this.bridges.get(record.agentId)
    const pairingLive =
      record.pairingCode !== null &&
      record.pairingExpiresAt !== null &&
      record.pairingExpiresAt > Date.now()
    return {
      agentId: record.agentId,
      channel: 'telegram',
      enabled: record.enabled,
      hasToken: this.hasToken(record.agentId),
      paired: record.allowedChatId !== null,
      pairingCode: pairingLive ? record.pairingCode : null,
      groups: record.groups,
      status: running ? (running.error ? 'error' : 'running') : 'stopped',
      statusDetail: running?.error ?? null,
    }
  }

  /** Stores the bot token (encrypted), arms pairing and starts the bridge. */
  setToken(agentId: string, token: string): BotBinding {
    const agent = this.deps.db.agents.getById(agentId)
    if (!agent) throw new Error('Unknown agent profile.')
    const { encryptedBase64, preview } = this.deps.keystore.encryptKey(token.trim())
    this.deps.db.secrets.set('im_bridge', ownerId(agentId), TOKEN_NAME, encryptedBase64, preview)
    this.deps.db.botBindings.ensure(agentId)
    // A new token means a new bot identity: force a fresh pairing.
    this.armPairing(agentId)
    this.restartBridge(agentId)
    this.deps.broadcast(CHANNELS.botsChanged, { agentId })
    return this.toBinding(this.deps.db.botBindings.getByAgent(agentId)!)
  }

  setEnabled(agentId: string, enabled: boolean): BotBinding {
    this.deps.db.botBindings.ensure(agentId)
    this.deps.db.botBindings.setEnabled(agentId, enabled)
    this.restartBridge(agentId)
    this.deps.broadcast(CHANNELS.botsChanged, { agentId })
    return this.toBinding(this.deps.db.botBindings.getByAgent(agentId)!)
  }

  /** Unpairs and arms a fresh one-time code. */
  repair(agentId: string): BotBinding {
    this.deps.db.botBindings.ensure(agentId)
    this.armPairing(agentId)
    this.deps.broadcast(CHANNELS.botsChanged, { agentId })
    return this.toBinding(this.deps.db.botBindings.getByAgent(agentId)!)
  }

  /** Removes the binding and its stored token; the bridge stops. */
  clearToken(agentId: string): void {
    this.stopBridge(agentId)
    this.deps.db.secrets.remove('im_bridge', ownerId(agentId), TOKEN_NAME)
    this.deps.db.botBindings.remove(agentId)
    this.deps.broadcast(CHANNELS.botsChanged, { agentId })
  }

  updateGroup(
    agentId: string,
    groupId: string,
    patch: { activation?: 'mention' | 'always'; remove?: boolean }
  ): BotBinding {
    const record = this.deps.db.botBindings.getByAgent(agentId)
    if (!record) throw new Error('This bot has no Telegram binding.')
    const groups = patch.remove
      ? record.groups.filter((group) => group.id !== groupId)
      : record.groups.map((group) =>
          group.id === groupId && patch.activation
            ? { ...group, activation: patch.activation }
            : group
        )
    this.deps.db.botBindings.setGroups(agentId, groups)
    this.deps.broadcast(CHANNELS.botsChanged, { agentId })
    return this.toBinding(this.deps.db.botBindings.getByAgent(agentId)!)
  }

  private armPairing(agentId: string): string {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.deps.db.botBindings.setPairing(agentId, code, Date.now() + PAIRING_TTL_MS)
    return code
  }

  // -- inbound -----------------------------------------------------------------

  private async handleInbound(
    agentId: string,
    inbound: TelegramInbound
  ): Promise<string | null> {
    const db = this.deps.db
    const binding = db.botBindings.getByAgent(agentId)
    if (!binding || !binding.enabled) return null
    const agent = db.agents.getById(agentId)
    if (!agent) return null
    if (!agent.enabled) return inbound.chatType === 'private' ? 'This bot is disabled.' : null
    if (inbound.chatType === 'private') return this.handleDirect(agentId, binding, inbound)
    if (inbound.chatType === 'group' || inbound.chatType === 'supergroup') {
      return this.handleGroup(agentId, binding, inbound)
    }
    return null // broadcast channels are unsupported
  }

  private async handleDirect(
    agentId: string,
    binding: BotBindingRecord,
    inbound: TelegramInbound
  ): Promise<string | null> {
    const db = this.deps.db
    if (binding.allowedChatId === null) {
      // Unpaired: ONLY the one-time code is processed; nothing reaches the
      // model (the main bridge's trust-on-first-use contract).
      const expired =
        binding.pairingCode === null ||
        binding.pairingExpiresAt === null ||
        binding.pairingExpiresAt <= Date.now()
      if (expired || binding.pairingAttempts >= PAIRING_MAX_ATTEMPTS) {
        return 'Pairing is not armed. Open Grasberg → Bots → this bot and generate a new pairing code.'
      }
      if (inbound.text.trim() === binding.pairingCode) {
        db.botBindings.setPaired(agentId, inbound.chatId)
        this.deps.broadcast(CHANNELS.botsChanged, { agentId })
        const name = db.agents.getById(agentId)?.name ?? 'this bot'
        return `Paired! You are now talking to 🤖 ${name}. In groups, add me and send /allowgroup to let me listen there.`
      }
      const attempts = db.botBindings.bumpPairingAttempts(agentId)
      return attempts >= PAIRING_MAX_ATTEMPTS
        ? 'Too many wrong codes — pairing is locked. Generate a new code in Grasberg.'
        : 'That is not the pairing code. Paste the six-digit code shown in Grasberg.'
    }
    if (inbound.chatId !== binding.allowedChatId) {
      return 'This bot is private and only responds to its owner.'
    }
    return this.route(agentId, inbound.chatId, inbound.text)
  }

  private async handleGroup(
    agentId: string,
    binding: BotBindingRecord,
    inbound: TelegramInbound
  ): Promise<string | null> {
    const db = this.deps.db
    const groupKey = String(inbound.chatId)
    const entry = binding.groups.find((group) => group.id === groupKey)
    const isOwner =
      binding.allowedChatId !== null && inbound.senderId === binding.allowedChatId
    const command = inbound.text.trim().toLowerCase()

    // Owner-only in-group commands (OpenClaw's /activation pattern). The
    // owner is verifiable because their DM chat id IS their user id.
    if (command === '/allowgroup' || command.startsWith('/allowgroup@')) {
      if (!isOwner) return null
      if (!entry) {
        const groups: BotBindingGroup[] = [
          ...binding.groups,
          { id: groupKey, title: inbound.chatTitle || groupKey, activation: 'mention' },
        ]
        db.botBindings.setGroups(agentId, groups)
        this.deps.broadcast(CHANNELS.botsChanged, { agentId })
      }
      return 'This group is approved. I reply when @mentioned or replied to; the owner can switch with /activation always.'
    }
    if (command === '/denygroup' || command.startsWith('/denygroup@')) {
      if (!isOwner || !entry) return null
      db.botBindings.setGroups(
        agentId,
        binding.groups.filter((group) => group.id !== groupKey)
      )
      this.deps.broadcast(CHANNELS.botsChanged, { agentId })
      return 'Understood — I will stay silent in this group.'
    }
    if (command.startsWith('/activation')) {
      if (!isOwner || !entry) return null
      const mode = command.includes('always') ? 'always' : 'mention'
      db.botBindings.setGroups(
        agentId,
        binding.groups.map((group) =>
          group.id === groupKey ? { ...group, activation: mode } : group
        )
      )
      this.deps.broadcast(CHANNELS.botsChanged, { agentId })
      return mode === 'always'
        ? 'Activation: always — I will consider every message here.'
        : 'Activation: mention — I reply only when @mentioned or replied to.'
    }

    // Unapproved groups are pure silence — never spam a room we were added to.
    if (!entry) return null
    // Mention gating (OpenClaw default): explicit @mention or reply-to-bot.
    const gated =
      entry.activation === 'always' || inbound.mentionsBot || inbound.isReplyToBot
    if (!gated) return null
    const framed = `[Telegram group "${entry.title}" — ${inbound.senderName}]: ${inbound.text}`
    return this.route(agentId, inbound.chatId, framed)
  }

  /** Starts a canonical-chat turn and remembers where the reply goes. */
  private async route(
    agentId: string,
    chatId: number,
    content: string
  ): Promise<string | null> {
    const chat = this.deps.ensureBotChat(agentId)
    void this.bridges.get(agentId)?.bridge.sendTyping(chatId)
    try {
      const result = await this.deps.sendToBot(chat.id, content)
      const routes = this.routes.get(chat.id) ?? []
      routes.push({
        chatId,
        assistantMessageId: result.assistantMessage?.id ?? null,
        at: Date.now(),
      })
      this.routes.set(chat.id, routes)
      this.deps.broadcast(CHANNELS.botsChanged, { agentId })
      return null // the reply arrives via handleCompletion
    } catch (e) {
      return `Sorry — ${e instanceof Error ? e.message : 'something went wrong'}.`
    }
  }

  /**
   * Completion hook: flushes pending Telegram routes for this conversation.
   * Exact placeholder matches AND null routes (queued sends coalesced into
   * this turn) all receive the final text, one send per distinct chat.
   */
  handleCompletion(conversation: Conversation, message: Message): void {
    if (message.role !== 'assistant' || !conversation.agentId) return
    const routes = this.routes.get(conversation.id)
    if (!routes || routes.length === 0) return
    const now = Date.now()
    const keep: ReplyRoute[] = []
    const targets = new Set<number>()
    for (const routeEntry of routes) {
      if (now - routeEntry.at > ROUTE_TTL_MS) continue
      if (routeEntry.assistantMessageId === message.id || routeEntry.assistantMessageId === null) {
        targets.add(routeEntry.chatId)
      } else {
        keep.push(routeEntry)
      }
    }
    if (keep.length > 0) this.routes.set(conversation.id, keep)
    else this.routes.delete(conversation.id)
    const bridge = this.bridges.get(conversation.agentId)?.bridge
    if (!bridge || targets.size === 0) return
    const text = message.content.trim() || '(no reply)'
    for (const chatId of targets) void bridge.send(chatId, text)
  }
}
