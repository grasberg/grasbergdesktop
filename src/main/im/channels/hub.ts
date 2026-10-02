/**
 * ChannelHub (v53): Slack, Discord and email presences for bots, next to the
 * v47 Telegram bindings. One access policy for all of them:
 *
 * - Slack / Discord: trust-on-first-use pairing — the user DMs the bot a
 *   one-time code shown in Grasberg and becomes its owner. Only the owner's
 *   DMs are turns; shared channels must be allowlisted (in the editor, or by
 *   the owner typing "!allow" / "!deny" while mentioning the bot there) and
 *   are mention-gated unless the channel config says otherwise.
 * - Email: only allowlisted senders become turns; everything else is
 *   ignored. Quoted / forwarded material is handed over as untrusted data.
 *
 * Admitted messages become turns in the bot's canonical chat through the
 * ordinary pipeline (queue-if-busy); the completion hook sends the reply
 * back where the message came from. A paused bot answers that it is paused.
 */

import { randomInt, randomUUID } from 'node:crypto'
import { CHANNELS } from '@shared/ipc'
import type {
  BotChannel,
  BotChannelInput,
  BotChannelKind,
  BotChannelPatch,
  Conversation,
  Message,
} from '@shared/types'
import type { AppDatabase } from '../../db/database'
import { wrapUntrusted } from '../../services/untrusted'
import { answers, type ChannelConnector, type ChannelInbound, type ChannelSocketFactory, type ChannelState, type ChannelTarget } from './types'
import { SlackConnector } from './slack'
import { DiscordConnector } from './discord'
import { EmailConnector, type EmailChannelConfig, type EmailConnectorDeps } from './email/email-connector'

const PAIRING_TTL_MS = 30 * 60_000
const ROUTE_TTL_MS = 15 * 60_000


export const CHANNEL_SECRET_NAMES: Record<BotChannelKind, readonly string[]> = {
  slack: ['botToken', 'appToken'],
  discord: ['botToken'],
  email: ['password'],
}

interface ChannelRow {
  id: string
  agent_id: string
  kind: string
  enabled: number
  config_json: string
  state_json: string
  created_at: number
  updated_at: number
}

interface ChannelStateJson {
  ownerId?: string | null
  pairingCode?: string | null
  pairingExpiresAt?: number | null
  /** Wrong codes sent while pairing is armed; the code is burned at the limit. */
  pairingAttempts?: number
  lastUid?: number | null
}

/** Wrong pairing codes before the code is burned (Telegram's limit too). */
const PAIRING_MAX_ATTEMPTS = 5
/** Email settings that, when changed, make the stored password stale. */
const EMAIL_PASSWORD_BOUND_KEYS = ['imapHost', 'smtpHost', 'username'] as const

interface Running {
  connector: ChannelConnector
  state: ChannelState
  detail: string | null
}

interface Route {
  channelId: string
  target: ChannelTarget
  /** The turn's placeholder, or null for a queued send (see afterSeq). */
  assistantMessageId: string | null
  /**
   * Queued send: the queued user message's seq. Only an assistant message
   * AFTER it can answer — never the turn that was already running, which
   * may be the owner's private conversation.
   */
  afterSeq: number | null
  at: number
}

export interface ChannelHubDeps {
  db: AppDatabase
  keystore: { encryptKey(plain: string): { encryptedBase64: string; preview: string }; decryptKey(stored: string): string }
  ensureBotChat(agentId: string): Conversation
  /**
   * Starts (or queues) a canonical-chat turn. `untrusted` = the sender is not
   * the bot's owner (an email, a channel member): the turn runs as an outside
   * event (CHANNEL_EVENT_POLICY), never as the user asking.
   */
  sendToBot(
    conversationId: string,
    content: string,
    opts?: { untrusted?: boolean }
  ): Promise<{ queued?: boolean; assistantMessage?: Message | null; userMessage?: Message | null }>
  broadcast(channel: string, payload: unknown): void
  socketFactory: ChannelSocketFactory
  fetchImpl?: typeof fetch
  /** Test seams for email. */
  emailDeps?: Pick<EmailConnectorDeps, 'imap' | 'smtp'>
}

function parseJson<T>(json: string, fallback: T): T {
  try {
    const value = JSON.parse(json) as unknown
    return value && typeof value === 'object' ? (value as T) : fallback
  } catch {
    return fallback
  }
}

const isKind = (value: string): value is BotChannelKind =>
  value === 'slack' || value === 'discord' || value === 'email'

export class ChannelHub {
  private readonly running = new Map<string, Running>()
  private readonly routes = new Map<string, Route[]>()

  constructor(private readonly deps: ChannelHubDeps) {}

  // -- storage ------------------------------------------------------------------

  private rows(agentId?: string): ChannelRow[] {
    return agentId
      ? this.deps.db.driver.all<ChannelRow>('SELECT * FROM bot_channels WHERE agent_id = ? ORDER BY created_at', [agentId])
      : this.deps.db.driver.all<ChannelRow>('SELECT * FROM bot_channels ORDER BY created_at')
  }

  private row(id: string): ChannelRow | null {
    return this.deps.db.driver.get<ChannelRow>('SELECT * FROM bot_channels WHERE id = ?', [id]) ?? null
  }

  private state(row: ChannelRow): ChannelStateJson {
    return parseJson<ChannelStateJson>(row.state_json, {})
  }

  private saveState(id: string, patch: ChannelStateJson): void {
    const row = this.row(id)
    if (!row) return
    const next = { ...this.state(row), ...patch }
    this.deps.db.driver.run('UPDATE bot_channels SET state_json = ? WHERE id = ?', [JSON.stringify(next), id])
  }

  private secrets(id: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const cipher of this.deps.db.secrets.listCiphers('bot_channel', id)) {
      try {
        out[cipher.name] = this.deps.keystore.decryptKey(cipher.encryptedValue)
      } catch {
        // an undecryptable secret reads as missing
      }
    }
    return out
  }

  private describe(row: ChannelRow): BotChannel {
    const state = this.state(row)
    const live = this.running.get(row.id)
    const pairingLive = !!state.pairingCode && (state.pairingExpiresAt ?? 0) > Date.now()
    return {
      id: row.id,
      agentId: row.agent_id,
      kind: isKind(row.kind) ? row.kind : 'email',
      enabled: row.enabled === 1,
      config: parseJson<Record<string, unknown>>(row.config_json, {}),
      secretNames: this.deps.db.secrets.listNames('bot_channel', row.id).map((s) => s.name),
      paired: row.kind === 'email' ? true : !!state.ownerId,
      pairingCode: row.kind !== 'email' && !state.ownerId && pairingLive ? (state.pairingCode ?? null) : null,
      status: live?.state ?? 'stopped',
      statusDetail: live?.detail ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  list(agentId: string): BotChannel[] {
    return this.rows(agentId).map((row) => this.describe(row))
  }

  get(id: string): BotChannel | null {
    const row = this.row(id)
    return row ? this.describe(row) : null
  }

  private storeSecrets(id: string, secrets: Record<string, string> | undefined, kind: BotChannelKind): void {
    for (const [name, value] of Object.entries(secrets ?? {})) {
      if (!CHANNEL_SECRET_NAMES[kind].includes(name) || !value) continue
      const encrypted = this.deps.keystore.encryptKey(value)
      this.deps.db.secrets.set('bot_channel', id, name, encrypted.encryptedBase64, encrypted.preview)
    }
  }

  private newPairing(): ChannelStateJson {
    return {
      pairingCode: String(randomInt(100_000, 1_000_000)),
      pairingExpiresAt: Date.now() + PAIRING_TTL_MS,
      pairingAttempts: 0,
    }
  }

  create(input: BotChannelInput): BotChannel {
    if (!this.deps.db.agents.getById(input.agentId)) throw new Error('Unknown agent profile.')
    if (this.rows(input.agentId).some((row) => row.kind === input.kind)) {
      throw new Error(`This bot already has a ${input.kind} channel — edit that one.`)
    }
    const id = randomUUID()
    const now = Date.now()
    const state: ChannelStateJson = input.kind === 'email' ? {} : this.newPairing()
    this.deps.db.driver.run(
      `INSERT INTO bot_channels (id, agent_id, kind, enabled, config_json, state_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.agentId, input.kind, input.enabled === false ? 0 : 1, JSON.stringify(input.config ?? {}), JSON.stringify(state), now, now]
    )
    this.storeSecrets(id, input.secrets, input.kind)
    this.restart(id)
    this.changed(input.agentId)
    return this.get(id) as BotChannel
  }

  update(id: string, patch: BotChannelPatch): BotChannel {
    const row = this.row(id)
    if (!row || !isKind(row.kind)) throw new Error('Unknown channel.')
    const previous = parseJson<Record<string, unknown>>(row.config_json, {})
    const config = patch.config ? { ...previous, ...patch.config } : null
    // A mailbox password is bound to the server and account it was entered
    // for: pointing the channel elsewhere without re-entering it forgets it,
    // so a changed host can never receive the stored password.
    if (
      row.kind === 'email' &&
      config &&
      !patch.secrets?.password &&
      EMAIL_PASSWORD_BOUND_KEYS.some((key) => String(config[key] ?? '') !== String(previous[key] ?? ''))
    ) {
      this.deps.db.secrets.remove('bot_channel', id, 'password')
    }
    this.deps.db.driver.run(
      'UPDATE bot_channels SET enabled = ?, config_json = ?, updated_at = ? WHERE id = ?',
      [
        patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
        config ? JSON.stringify(config) : row.config_json,
        Date.now(),
        id,
      ]
    )
    this.storeSecrets(id, patch.secrets, row.kind)
    this.restart(id)
    this.changed(row.agent_id)
    return this.get(id) as BotChannel
  }

  /** Forgets the owner and arms a fresh pairing code (Slack / Discord). */
  repair(id: string): BotChannel {
    const row = this.row(id)
    if (!row) throw new Error('Unknown channel.')
    this.saveState(id, { ownerId: null, ...this.newPairing() })
    this.changed(row.agent_id)
    return this.get(id) as BotChannel
  }

  remove(id: string): void {
    const row = this.row(id)
    this.stopOne(id)
    this.deps.db.driver.run('DELETE FROM bot_channels WHERE id = ?', [id])
    this.deps.db.secrets.deleteAllFor('bot_channel', id)
    if (row) this.changed(row.agent_id)
  }

  removeForAgent(agentId: string): void {
    for (const row of this.rows(agentId)) this.remove(row.id)
  }

  private changed(agentId: string): void {
    this.deps.broadcast(CHANNELS.botsChanged, { agentId })
  }

  // -- lifecycle ----------------------------------------------------------------

  syncAll(): void {
    const wanted = new Set<string>()
    for (const row of this.rows()) {
      const agent = this.deps.db.agents.getById(row.agent_id)
      if (row.enabled === 1 && agent?.enabled) {
        wanted.add(row.id)
        if (!this.running.has(row.id)) this.startOne(row)
      }
    }
    for (const id of [...this.running.keys()]) if (!wanted.has(id)) this.stopOne(id)
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stopOne(id)
  }

  private restart(id: string): void {
    this.stopOne(id)
    this.syncAll()
  }

  private stopOne(id: string): void {
    this.running.get(id)?.connector.stop()
    this.running.delete(id)
  }

  private startOne(row: ChannelRow): void {
    if (!isKind(row.kind)) return
    const secrets = this.secrets(row.id)
    const config = parseJson<Record<string, unknown>>(row.config_json, {})
    const entry: Running = { connector: null as unknown as ChannelConnector, state: 'connecting', detail: null }
    const callbacks = {
      onInbound: (message: ChannelInbound) => void this.handleInbound(row.id, message),
      onStatus: (state: ChannelState, detail: string | null) => {
        entry.state = state
        entry.detail = detail
        this.changed(row.agent_id)
      },
    }
    if (row.kind === 'slack') {
      if (!secrets.botToken || !secrets.appToken) return this.markMissing(row, entry, 'Add the bot token and the app-level token.')
      entry.connector = new SlackConnector(secrets.botToken, secrets.appToken, callbacks, {
        fetchImpl: this.deps.fetchImpl,
        socketFactory: this.deps.socketFactory,
      })
    } else if (row.kind === 'discord') {
      if (!secrets.botToken) return this.markMissing(row, entry, 'Add the bot token.')
      entry.connector = new DiscordConnector(secrets.botToken, callbacks, {
        fetchImpl: this.deps.fetchImpl,
        socketFactory: this.deps.socketFactory,
      })
    } else {
      if (!secrets.password) return this.markMissing(row, entry, 'Add the mailbox password (an app password).')
      entry.connector = new EmailConnector(config as unknown as EmailChannelConfig, secrets.password, callbacks, {
        getLastUid: () => {
          const current = this.row(row.id)
          return current ? (this.state(current).lastUid ?? null) : null
        },
        setLastUid: (uid) => this.saveState(row.id, { lastUid: uid }),
        ...this.deps.emailDeps,
      })
    }
    this.running.set(row.id, entry)
    entry.connector.start()
  }

  private markMissing(row: ChannelRow, entry: Running, detail: string): void {
    entry.state = 'error'
    entry.detail = detail
    entry.connector = { start() {}, stop() {}, send: async () => undefined }
    this.running.set(row.id, entry)
  }

  // -- inbound ------------------------------------------------------------------

  /** Applies the access policy and routes an admitted message. Public for tests. */
  async handleInbound(channelId: string, inbound: ChannelInbound): Promise<void> {
    const row = this.row(channelId)
    const live = this.running.get(channelId)
    if (!row || !live || !isKind(row.kind)) return
    const agent = this.deps.db.agents.getById(row.agent_id)
    if (!agent?.enabled) return
    const config = parseJson<{ allowedChannels?: string[]; mentionOnly?: boolean; allowedSenders?: string[] }>(
      row.config_json,
      {}
    )
    const reply = (text: string): void => void live.connector.send(inbound.target, text).catch(() => undefined)
    let content: string
    // Email is ALWAYS an outside event: a sender address is only as good as
    // the sending domain's DMARC, so an allowlisted address is admitted but
    // never treated as the user in person. Non-owner channel members too.
    let untrusted = false
    if (row.kind === 'email') {
      const allowed = (config.allowedSenders ?? []).map((s) => s.trim().toLowerCase())
      if (!inbound.senderId || !allowed.includes(inbound.senderId.toLowerCase())) return
      if (agent.paused) return reply(`${agent.name} is paused right now and will not act on this email.`)
      untrusted = true
      content =
        `[Email from ${inbound.senderName} <${inbound.senderId}> — an allowlisted sender; email ` +
        `can be forged, so outward actions still need the owner's approval]\n${inbound.text}` +
        (inbound.quoted ? `\n\n${wrapUntrusted(inbound.quoted.slice(0, 20_000), 'quoted/forwarded email')}` : '')
    } else {
      const state = this.state(row)
      if (!state.ownerId) {
        if (!inbound.isDirect || !state.pairingCode) return
        const code = inbound.text.trim()
        if (code === state.pairingCode && (state.pairingExpiresAt ?? 0) > Date.now()) {
          this.saveState(channelId, { ownerId: inbound.senderId, pairingCode: null, pairingExpiresAt: null, pairingAttempts: 0 })
          this.changed(row.agent_id)
          reply(`Paired ✓ — I'm ${agent.name}. Message me here any time.`)
          return
        }
        // A six-digit code must not be guessable by brute force: a few wrong
        // tries burn it, and the owner arms a new one in Grasberg.
        const attempts = (state.pairingAttempts ?? 0) + 1
        if (attempts >= PAIRING_MAX_ATTEMPTS) {
          this.saveState(channelId, { pairingCode: null, pairingExpiresAt: null, pairingAttempts: 0 })
          this.changed(row.agent_id)
        } else {
          this.saveState(channelId, { pairingAttempts: attempts })
        }
        return
      }
      const isOwner = inbound.senderId === state.ownerId
      const platform = row.kind === 'slack' ? 'Slack' : 'Discord'
      if (inbound.isDirect) {
        if (!isOwner) return
        content = `[via ${platform}] ${inbound.text}`
      } else {
        const allowedChannels = config.allowedChannels ?? []
        const command = inbound.text.trim().toLowerCase()
        if (isOwner && inbound.mentionsBot && (command === '!allow' || command === '!deny')) {
          const next =
            command === '!allow'
              ? [...new Set([...allowedChannels, inbound.channelKey])]
              : allowedChannels.filter((key) => key !== inbound.channelKey)
          this.deps.db.driver.run('UPDATE bot_channels SET config_json = ?, updated_at = ? WHERE id = ?', [
            JSON.stringify({ ...config, allowedChannels: next }),
            Date.now(),
            channelId,
          ])
          this.changed(row.agent_id)
          return reply(command === '!allow' ? 'This channel is approved — mention me to talk.' : 'Understood — I will stay quiet here.')
        }
        if (!allowedChannels.includes(inbound.channelKey)) return
        if (config.mentionOnly !== false && !inbound.mentionsBot) return
        if (isOwner) {
          content = `[${inbound.label} — ${inbound.senderName} (owner)]: ${inbound.text}`
        } else {
          untrusted = true
          content =
            `[${inbound.label} — ${inbound.senderName}, not your owner]:\n` +
            wrapUntrusted(inbound.text.slice(0, 20_000), `${platform} message from ${inbound.senderName}`)
        }
      }
      if (agent.paused) return reply(`I am paused right now — my owner can resume me in Grasberg.`)
    }
    await this.route(row, inbound.target, content, untrusted)
  }

  private async route(row: ChannelRow, target: ChannelTarget, content: string, untrusted: boolean): Promise<void> {
    const chat = this.deps.ensureBotChat(row.agent_id)
    try {
      const result = await this.deps.sendToBot(chat.id, content, { untrusted })
      const routes = this.routes.get(chat.id) ?? []
      routes.push({
        channelId: row.id,
        target,
        assistantMessageId: result.assistantMessage?.id ?? null,
        afterSeq: result.assistantMessage ? null : (result.userMessage?.seq ?? null),
        at: Date.now(),
      })
      this.routes.set(chat.id, routes)
      this.changed(row.agent_id)
    } catch (e) {
      const live = this.running.get(row.id)
      void live?.connector
        .send(target, `Sorry — ${e instanceof Error ? e.message : 'something went wrong'}.`)
        .catch(() => undefined)
    }
  }

  /** Completion hook: sends the finished reply to every pending route of the chat. */
  handleCompletion(conversation: Conversation, message: Message): void {
    if (message.role !== 'assistant' || !conversation.agentId) return
    const routes = this.routes.get(conversation.id)
    if (!routes || routes.length === 0) return
    const now = Date.now()
    const keep: Route[] = []
    const due: Route[] = []
    for (const route of routes) {
      if (now - route.at > ROUTE_TTL_MS) continue
      if (answers(route, message)) due.push(route)
      else keep.push(route)
    }
    if (keep.length > 0) this.routes.set(conversation.id, keep)
    else this.routes.delete(conversation.id)
    const sent = new Set<string>()
    const text = message.content.trim() || '(no reply)'
    for (const route of due) {
      const key = `${route.channelId}:${JSON.stringify(route.target)}`
      if (sent.has(key)) continue
      sent.add(key)
      void this.running.get(route.channelId)?.connector.send(route.target, text).catch(() => undefined)
    }
  }

  // -- agent tools ----------------------------------------------------------------

  /** The bot's running email connector, if it has one. */
  emailFor(agentId: string): EmailConnector | null {
    for (const row of this.rows(agentId)) {
      if (row.kind !== 'email') continue
      const live = this.running.get(row.id)?.connector
      if (live instanceof EmailConnector) return live
    }
    return null
  }

  /** Which channels a bot can post to (for the tool's error text). */
  postableKinds(agentId: string): BotChannelKind[] {
    return this.rows(agentId)
      .filter((row) => this.running.get(row.id)?.state === 'running' && isKind(row.kind) && row.kind !== 'email')
      .map((row) => row.kind as BotChannelKind)
  }

  /**
   * channel_send: posts to a Slack / Discord channel id, or to the paired
   * owner ("owner"). Admission rules still apply: a shared channel must be
   * allowlisted for the bot.
   */
  async post(agentId: string, kind: 'slack' | 'discord', target: string, text: string): Promise<string> {
    const row = this.rows(agentId).find((r) => r.kind === kind)
    const live = row ? this.running.get(row.id) : null
    if (!row || !live || live.state !== 'running') return `Error: this bot has no running ${kind} channel.`
    const config = parseJson<{ allowedChannels?: string[] }>(row.config_json, {})
    const state = this.state(row)
    let channelTarget: ChannelTarget
    if (target === 'owner') {
      if (!state.ownerId) return `Error: nobody is paired with this bot on ${kind} yet.`
      channelTarget = kind === 'slack' ? { userId: state.ownerId } : { userId: state.ownerId }
    } else {
      if (!(config.allowedChannels ?? []).includes(target)) {
        return `Error: channel ${target} is not approved for this bot. Approve it in the bot's channel settings, or have the owner send "!allow" there.`
      }
      channelTarget = kind === 'slack' ? { channel: target, threadTs: null } : { channelId: target, replyTo: null }
    }
    try {
      if (channelTarget.userId) await this.sendToUser(live.connector, kind, String(channelTarget.userId), text)
      else await live.connector.send(channelTarget, text)
      return `Posted to ${kind} ${target}.`
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  private async sendToUser(connector: ChannelConnector, kind: 'slack' | 'discord', userId: string, text: string): Promise<void> {
    const direct = connector as ChannelConnector & { openDirect?(userId: string): Promise<ChannelTarget> }
    if (!direct.openDirect) throw new Error(`Direct messages are not supported on ${kind}.`)
    await connector.send(await direct.openDirect(userId), text)
  }
}
