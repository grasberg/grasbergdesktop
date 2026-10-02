/**
 * Bot channels beyond Telegram (v53): Slack (Socket Mode), Discord (Gateway)
 * and email (IMAP + SMTP). Every connector speaks this small interface so the
 * ChannelHub can apply ONE access policy (pairing, allowlists, mention gating)
 * and ONE routing path (inbound → the bot's canonical chat → reply back).
 *
 * Connectors are outbound-only: they open connections to the platform, never
 * a listening port — the app's single inbound surface stays the loopback
 * trigger server.
 */

import type { Message } from '@shared/types'

/**
 * Whether a completed assistant message answers a pending reply route: the
 * exact placeholder, or — for a queued send — a turn that started after the
 * queued message (never the turn that was already running when it queued,
 * which may be the owner's private conversation). Shared by the Telegram
 * bindings and the ChannelHub.
 */
export function answers(
  route: { assistantMessageId: string | null; afterSeq: number | null },
  message: Pick<Message, 'id' | 'seq'>
): boolean {
  if (route.assistantMessageId !== null) return route.assistantMessageId === message.id
  return route.afterSeq !== null && typeof message.seq === 'number' && message.seq > route.afterSeq
}

/** Where a reply goes — opaque to the hub, meaningful to its connector. */
export type ChannelTarget = Record<string, string | string[] | null>

export interface ChannelInbound {
  /** Platform user id, or the sender's email address (lowercased). */
  senderId: string
  senderName: string
  text: string
  /** Reply address for this message. */
  target: ChannelTarget
  /** A direct message to the bot (DM / email to its address). */
  isDirect: boolean
  /** The bot was @mentioned (or replied to) in a shared channel. */
  mentionsBot: boolean
  /** Channel / thread key the allowlist is checked against. */
  channelKey: string
  /** Human label for framing: "Slack DM", "#general", "Email". */
  label: string
  /** Email only: the quoted / forwarded remainder, handed to the bot as untrusted data. */
  quoted?: string
}

export type ChannelState = 'stopped' | 'connecting' | 'running' | 'error'

export interface ChannelCallbacks {
  onInbound(message: ChannelInbound): void
  onStatus(state: ChannelState, detail: string | null): void
}

export interface ChannelConnector {
  start(): void
  stop(): void
  send(target: ChannelTarget, text: string): Promise<void>
}

/** Minimal WebSocket surface (the `ws` package satisfies it; tests inject fakes). */
export interface ChannelSocket {
  send(data: string): void
  close(): void
  on(event: 'open', cb: () => void): void
  on(event: 'message', cb: (data: unknown) => void): void
  on(event: 'close', cb: (code?: number) => void): void
  on(event: 'error', cb: (error: Error) => void): void
}

export type ChannelSocketFactory = (url: string) => ChannelSocket

/** Splits a long reply into platform-sized chunks on paragraph/line boundaries. */
export function chunkText(text: string, max: number): string[] {
  const chunks: string[] = []
  let rest = text.trim() || '(no reply)'
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max)
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max)
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max)
    if (cut < max / 2) cut = max
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) chunks.push(rest)
  return chunks
}

/** Reconnect delay with jitter: 2 s, 4 s, … capped at 60 s. */
export function backoffMs(attempt: number): number {
  const base = Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5))
  return base / 2 + Math.random() * (base / 2)
}
