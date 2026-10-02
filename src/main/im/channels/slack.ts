/**
 * Slack channel (v53, dots "message your dot in Slack"): Socket Mode, so no
 * public URL is needed — the app opens an outbound WebSocket with an
 * app-level token (xapp-…) and posts with the bot token (xoxb-…).
 *
 * Slack app setup the user does once: enable Socket Mode, add the bot scopes
 * chat:write, im:history, app_mentions:read (+ channels:history for
 * "always" channels, users:read for names) and subscribe to the bot events
 * message.im and app_mention.
 */

import type {
  ChannelCallbacks,
  ChannelConnector,
  ChannelSocket,
  ChannelSocketFactory,
  ChannelTarget,
} from './types'
import { backoffMs, chunkText } from './types'

const SLACK_API = 'https://slack.com/api'
const SLACK_TEXT_MAX = 3500

interface SlackEvent {
  type?: string
  subtype?: string
  user?: string
  bot_id?: string
  text?: string
  channel?: string
  channel_type?: string
  ts?: string
  thread_ts?: string
}

export interface SlackConnectorDeps {
  fetchImpl?: typeof fetch
  socketFactory: ChannelSocketFactory
}

export class SlackConnector implements ChannelConnector {
  private socket: ChannelSocket | null = null
  private stopped = true
  private attempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private botUserId: string | null = null
  private readonly names = new Map<string, string>()

  constructor(
    private readonly botToken: string,
    private readonly appToken: string,
    private readonly callbacks: ChannelCallbacks,
    private readonly deps: SlackConnectorDeps
  ) {}

  private get fetch(): typeof fetch {
    return this.deps.fetchImpl ?? fetch
  }

  private async api<T extends Record<string, unknown>>(
    method: string,
    token: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const response = await this.fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body ?? {}),
    })
    const data = (await response.json()) as T & { ok?: boolean; error?: string }
    if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error ?? response.status}`)
    return data
  }

  start(): void {
    this.stopped = false
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.close()
    this.socket = null
    this.callbacks.onStatus('stopped', null)
  }

  private scheduleReconnect(detail: string | null): void {
    if (this.stopped) return
    this.socket = null
    this.callbacks.onStatus(detail ? 'error' : 'connecting', detail)
    const delay = backoffMs(this.attempt++)
    this.reconnectTimer = setTimeout(() => void this.connect(), delay)
    this.reconnectTimer.unref?.()
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    this.callbacks.onStatus('connecting', null)
    try {
      if (!this.botUserId) {
        const auth = await this.api<{ user_id?: string }>('auth.test', this.botToken)
        this.botUserId = auth.user_id ?? null
      }
      const open = await this.api<{ url?: string }>('apps.connections.open', this.appToken)
      if (!open.url) throw new Error('Slack returned no Socket Mode URL')
      const socket = this.deps.socketFactory(open.url)
      this.socket = socket
      socket.on('message', (data) => this.onFrame(socket, data))
      socket.on('close', () => {
        if (this.socket === socket) this.scheduleReconnect(null)
      })
      socket.on('error', (error) => {
        if (this.socket === socket) this.scheduleReconnect(error.message)
      })
    } catch (e) {
      this.scheduleReconnect(e instanceof Error ? e.message : String(e))
    }
  }

  private onFrame(socket: ChannelSocket, data: unknown): void {
    let frame: { type?: string; envelope_id?: string; payload?: { event?: SlackEvent } }
    try {
      frame = JSON.parse(String(data)) as typeof frame
    } catch {
      return
    }
    // Every envelope is acknowledged at once, or Slack redelivers it.
    if (frame.envelope_id) socket.send(JSON.stringify({ envelope_id: frame.envelope_id }))
    if (frame.type === 'hello') {
      this.attempt = 0
      this.callbacks.onStatus('running', null)
      return
    }
    if (frame.type === 'disconnect') {
      socket.close()
      return
    }
    if (frame.type === 'events_api' && frame.payload?.event) void this.onEvent(frame.payload.event)
  }

  private async displayName(userId: string): Promise<string> {
    const cached = this.names.get(userId)
    if (cached) return cached
    try {
      const info = await this.api<{ user?: { real_name?: string; name?: string } }>(
        'users.info',
        this.botToken,
        { user: userId }
      )
      const name = info.user?.real_name || info.user?.name || userId
      this.names.set(userId, name)
      return name
    } catch {
      return userId
    }
  }

  private async onEvent(event: SlackEvent): Promise<void> {
    if (event.bot_id || !event.user || event.user === this.botUserId) return
    if (event.subtype && event.subtype !== 'thread_broadcast') return // edits, joins, …
    const isDirect = event.channel_type === 'im'
    const isMention = event.type === 'app_mention'
    if (event.type !== 'message' && !isMention) return
    // A mention in a channel arrives as BOTH message and app_mention when the
    // app also listens to channel messages — take the app_mention copy only.
    if (!isDirect && !isMention && this.botUserId && event.text?.includes(`<@${this.botUserId}>`)) return
    const mention = this.botUserId ? new RegExp(`<@${this.botUserId}>`, 'g') : null
    const text = (mention ? (event.text ?? '').replace(mention, '') : (event.text ?? '')).trim()
    if (!text || !event.channel) return
    this.callbacks.onInbound({
      senderId: event.user,
      senderName: await this.displayName(event.user),
      text,
      target: {
        channel: event.channel,
        threadTs: isDirect ? (event.thread_ts ?? null) : (event.thread_ts ?? event.ts ?? null),
      },
      isDirect,
      mentionsBot: isMention || isDirect,
      channelKey: event.channel,
      label: isDirect ? 'Slack DM' : `Slack channel ${event.channel}`,
    })
  }

  /** Opens (or reuses) the DM channel with a user — for posting to the owner. */
  async openDirect(userId: string): Promise<ChannelTarget> {
    const opened = await this.api<{ channel?: { id?: string } }>('conversations.open', this.botToken, {
      users: userId,
    })
    if (!opened.channel?.id) throw new Error('Slack did not open a DM channel.')
    return { channel: opened.channel.id, threadTs: null }
  }

  async send(target: ChannelTarget, text: string): Promise<void> {
    const channel = typeof target.channel === 'string' ? target.channel : ''
    if (!channel) throw new Error('No Slack channel to reply to.')
    for (const chunk of chunkText(text, SLACK_TEXT_MAX)) {
      await this.api('chat.postMessage', this.botToken, {
        channel,
        text: chunk,
        ...(typeof target.threadTs === 'string' ? { thread_ts: target.threadTs } : {}),
      })
    }
  }
}
