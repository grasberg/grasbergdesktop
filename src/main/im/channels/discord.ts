/**
 * Discord channel (v53): a bot user on the Gateway (outbound WebSocket) for
 * inbound messages, REST for replies. The user creates an application in the
 * Discord developer portal, adds a bot, enables the MESSAGE CONTENT intent
 * and invites it; the bot token is stored encrypted.
 */

import type {
  ChannelCallbacks,
  ChannelConnector,
  ChannelSocket,
  ChannelSocketFactory,
  ChannelTarget,
} from './types'
import { backoffMs, chunkText } from './types'

const DISCORD_API = 'https://discord.com/api/v10'
const DISCORD_TEXT_MAX = 1900
/** GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT. */
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)

interface GatewayFrame {
  op: number
  d?: unknown
  s?: number | null
  t?: string | null
}

interface DiscordMessage {
  id: string
  channel_id: string
  guild_id?: string
  content?: string
  author?: { id: string; username?: string; global_name?: string; bot?: boolean }
  mentions?: Array<{ id: string }>
  referenced_message?: { author?: { id: string } } | null
}

export interface DiscordConnectorDeps {
  fetchImpl?: typeof fetch
  socketFactory: ChannelSocketFactory
}

export class DiscordConnector implements ChannelConnector {
  private socket: ChannelSocket | null = null
  private stopped = true
  private attempt = 0
  private seq: number | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private botUserId: string | null = null

  constructor(
    private readonly token: string,
    private readonly callbacks: ChannelCallbacks,
    private readonly deps: DiscordConnectorDeps
  ) {}

  private get fetch(): typeof fetch {
    return this.deps.fetchImpl ?? fetch
  }

  start(): void {
    this.stopped = false
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.socket?.close()
    this.socket = null
    this.callbacks.onStatus('stopped', null)
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.heartbeat = null
    this.reconnectTimer = null
  }

  private scheduleReconnect(detail: string | null): void {
    if (this.stopped) return
    this.clearTimers()
    this.socket = null
    this.callbacks.onStatus(detail ? 'error' : 'connecting', detail)
    this.reconnectTimer = setTimeout(() => void this.connect(), backoffMs(this.attempt++))
    this.reconnectTimer.unref?.()
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    this.callbacks.onStatus('connecting', null)
    try {
      const response = await this.fetch(`${DISCORD_API}/gateway/bot`, {
        headers: { authorization: `Bot ${this.token}` },
      })
      if (!response.ok) {
        throw new Error(response.status === 401 ? 'Discord rejected the bot token' : `Discord gateway lookup failed (${response.status})`)
      }
      const { url } = (await response.json()) as { url?: string }
      if (!url) throw new Error('Discord returned no gateway URL')
      const socket = this.deps.socketFactory(`${url}?v=10&encoding=json`)
      this.socket = socket
      socket.on('message', (data) => this.onFrame(socket, data))
      socket.on('close', (code) => {
        if (this.socket !== socket) return
        // 4004 = bad token, 4014 = disallowed intent: retrying cannot help.
        if (code === 4004 || code === 4014) {
          this.stopped = true
          this.clearTimers()
          this.callbacks.onStatus(
            'error',
            code === 4014
              ? 'Enable the MESSAGE CONTENT intent for this bot in the Discord developer portal.'
              : 'Discord rejected the bot token.'
          )
          return
        }
        this.scheduleReconnect(null)
      })
      socket.on('error', (error) => {
        if (this.socket === socket) this.scheduleReconnect(error.message)
      })
    } catch (e) {
      this.scheduleReconnect(e instanceof Error ? e.message : String(e))
    }
  }

  private sendFrame(socket: ChannelSocket, frame: GatewayFrame): void {
    socket.send(JSON.stringify(frame))
  }

  private onFrame(socket: ChannelSocket, data: unknown): void {
    let frame: GatewayFrame
    try {
      frame = JSON.parse(String(data)) as GatewayFrame
    } catch {
      return
    }
    if (typeof frame.s === 'number') this.seq = frame.s
    switch (frame.op) {
      case 10: {
        const interval = Number((frame.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 41_250)
        if (this.heartbeat) clearInterval(this.heartbeat)
        this.heartbeat = setInterval(() => this.sendFrame(socket, { op: 1, d: this.seq }), interval)
        this.heartbeat.unref?.()
        this.sendFrame(socket, {
          op: 2,
          d: {
            token: this.token,
            intents: DISCORD_INTENTS,
            properties: { os: process.platform, browser: 'grasberg', device: 'grasberg' },
          },
        })
        return
      }
      case 1:
        this.sendFrame(socket, { op: 1, d: this.seq })
        return
      case 7:
      case 9:
        socket.close()
        return
      case 0:
        if (frame.t === 'READY') {
          this.botUserId = (frame.d as { user?: { id?: string } })?.user?.id ?? null
          this.attempt = 0
          this.callbacks.onStatus('running', null)
        } else if (frame.t === 'MESSAGE_CREATE') {
          this.onMessage(frame.d as DiscordMessage)
        }
        return
      default:
        return
    }
  }

  private onMessage(message: DiscordMessage): void {
    if (!message?.author || message.author.bot || message.author.id === this.botUserId) return
    const isDirect = !message.guild_id
    const mentionsBot =
      (this.botUserId !== null &&
        ((message.mentions ?? []).some((m) => m.id === this.botUserId) ||
          message.referenced_message?.author?.id === this.botUserId)) ||
      isDirect
    const text = (message.content ?? '')
      .replace(this.botUserId ? new RegExp(`<@!?${this.botUserId}>`, 'g') : /$^/, '')
      .trim()
    if (!text) return
    this.callbacks.onInbound({
      senderId: message.author.id,
      senderName: message.author.global_name || message.author.username || message.author.id,
      text,
      target: { channelId: message.channel_id, replyTo: isDirect ? null : message.id },
      isDirect,
      mentionsBot,
      channelKey: message.channel_id,
      label: isDirect ? 'Discord DM' : `Discord channel ${message.channel_id}`,
    })
  }

  /** Opens (or reuses) the DM channel with a user — for posting to the owner. */
  async openDirect(userId: string): Promise<ChannelTarget> {
    const response = await this.fetch(`${DISCORD_API}/users/@me/channels`, {
      method: 'POST',
      headers: { authorization: `Bot ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ recipient_id: userId }),
    })
    if (!response.ok) throw new Error(`Discord could not open a DM (${response.status})`)
    const { id } = (await response.json()) as { id?: string }
    if (!id) throw new Error('Discord did not open a DM channel.')
    return { channelId: id, replyTo: null }
  }

  async send(target: ChannelTarget, text: string): Promise<void> {
    const channelId = typeof target.channelId === 'string' ? target.channelId : ''
    if (!channelId) throw new Error('No Discord channel to reply to.')
    let first = true
    for (const chunk of chunkText(text, DISCORD_TEXT_MAX)) {
      const response = await this.fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bot ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          content: chunk,
          ...(first && typeof target.replyTo === 'string'
            ? { message_reference: { message_id: target.replyTo, fail_if_not_exists: false } }
            : {}),
        }),
      })
      if (!response.ok) throw new Error(`Discord send failed (${response.status})`)
      first = false
    }
  }
}
