/**
 * IM bridge manager: owns the Telegram bridge lifecycle and the generic
 * outbound webhook. The bot token is stored encrypted (tool_secrets, scope
 * 'im_bridge'); an inbound message runs a headless generation on the bound
 * conversation and the reply is sent back.
 */

import { randomInt } from 'node:crypto'
import type { Conversation, ImBridgeStatus, Message } from '@shared/types'
import { isAllowedHttpUrl } from '@shared/schemas'
import type { AppDatabase } from '../db/database'
import type { Keystore } from '../keys/keystore'
import { redactSecrets } from '../providers/redact'
import { TelegramBridge } from './telegram'

const TELEGRAM_OWNER = 'telegram'
const TOKEN_NAME = 'token'
const WEBHOOK_TIMEOUT_MS = 10_000
/** A six-digit code is guessable, so it is short-lived and cheap to burn. */
const PAIRING_TTL_MS = 15 * 60_000
const PAIRING_MAX_ATTEMPTS = 5

export interface ImBridgeManagerDeps {
  db: AppDatabase
  keystore: Pick<Keystore, 'encryptKey' | 'decryptKey'>
  /** Runs a headless generation and returns the reply. */
  generateReply: (conversationId: string, text: string) => Promise<string>
  fetchImpl?: typeof fetch
}

export interface SetTelegramInput {
  /** New token to store (omit to keep the existing one). */
  token?: string
  conversationId: string | null
  enabled: boolean
}

export class ImBridgeManager {
  private bridge: TelegramBridge | null = null
  /**
   * Guard for the code currently in settings: a code is only ever valid for
   * PAIRING_TTL_MS and PAIRING_MAX_ATTEMPTS wrong guesses. Kept in memory so it
   * can never outlive the session that issued the code.
   */
  private pairing: { expiresAt: number; attempts: number } | null = null

  constructor(private readonly deps: ImBridgeManagerDeps) {}

  private hasToken(): boolean {
    return this.deps.db.secrets.listNames('im_bridge', TELEGRAM_OWNER).some((s) => s.name === TOKEN_NAME)
  }

  private getToken(): string | null {
    const cipher = this.deps.db.secrets
      .listCiphers('im_bridge', TELEGRAM_OWNER)
      .find((c) => c.name === TOKEN_NAME)
    if (!cipher) return null
    try {
      return this.deps.keystore.decryptKey(cipher.encryptedValue)
    } catch {
      return null
    }
  }

  status(): ImBridgeStatus {
    const settings = this.deps.db.settings.get()
    return {
      telegramEnabled: settings.telegramBridgeEnabled,
      telegramConversationId: settings.telegramBridgeConversationId,
      telegramConnected: this.bridge !== null,
      hasToken: this.hasToken(),
      // Only surface a pairing code while actually waiting for the first chat.
      telegramPairingCode:
        settings.telegramBridgeAllowedChatId === null
          ? settings.telegramBridgePairingCode
          : null,
      webhookUrl: settings.outboundWebhookUrl,
    }
  }

  private stopBridge(): void {
    this.bridge?.stop()
    this.bridge = null
  }

  private startBridge(): void {
    this.stopBridge()
    if (process.env.SMOKE_TEST === '1') return
    const settings = this.deps.db.settings.get()
    // A code persisted by an earlier session has no guard yet — give it one
    // (fresh TTL, no attempts spent) rather than treating it as expired.
    if (
      settings.telegramBridgePairingCode &&
      settings.telegramBridgeAllowedChatId === null &&
      !this.pairing
    ) {
      this.pairing = { expiresAt: Date.now() + PAIRING_TTL_MS, attempts: 0 }
    }
    const token = this.getToken()
    if (!settings.telegramBridgeEnabled || !token || !settings.telegramBridgeConversationId) return
    const conversationId = settings.telegramBridgeConversationId
    this.bridge = new TelegramBridge({
      token,
      fetchImpl: this.deps.fetchImpl,
      onMessage: (chatId, text) => this.handleInbound(chatId, text, conversationId),
      onError: () => undefined,
    })
    this.bridge.start()
  }

  /**
   * Handles one inbound Telegram message. A Telegram bot is publicly
   * addressable, so without authentication ANY stranger could talk to the
   * user's bound conversation (leaking its history/memories and burning
   * credits). Pairing is therefore explicit: while unpaired, a sender must echo
   * the one-time code the desktop app shows (telegramBridgePairingCode) before
   * their chat id is pinned as the sole authorized chat. Only the code itself is
   * ever processed pre-pairing — a stranger's message is never forwarded to the
   * bound conversation or the model. The code expires and burns after a few
   * wrong guesses (see `pairing`), so it cannot be enumerated.
   */
  private async handleInbound(chatId: number, text: string, conversationId: string): Promise<string> {
    const settings = this.deps.db.settings.get()
    const allowed = settings.telegramBridgeAllowedChatId
    if (allowed === null) {
      const code = settings.telegramBridgePairingCode
      if (!code) {
        // No code provisioned (bridge misconfigured) — never auto-pair.
        return 'This assistant is not accepting new chats right now.'
      }
      if (!this.pairing || Date.now() > this.pairing.expiresAt) {
        this.rotatePairingCode()
        return 'That pairing code expired — open the desktop app for the new one.'
      }
      if (text.trim() !== code) {
        this.pairing.attempts += 1
        if (this.pairing.attempts >= PAIRING_MAX_ATTEMPTS) this.rotatePairingCode()
        return 'To link this chat, send the pairing code shown in the desktop app.'
      }
      // Correct code: pin this chat and consume the code. The pairing message
      // itself is an ack, not a prompt — it is not forwarded to the model.
      this.pairing = null
      this.deps.db.settings.update({
        telegramBridgeAllowedChatId: chatId,
        telegramBridgePairingCode: null,
      })
      return 'This chat is now linked. Send a message to start.'
    }
    if (allowed !== chatId) {
      return 'This assistant is private and only responds to its owner.'
    }
    return this.deps.generateReply(conversationId, text)
  }

  /** Six-digit, zero-padded one-time pairing code, with a fresh guard. */
  private issuePairingCode(): string {
    this.pairing = { expiresAt: Date.now() + PAIRING_TTL_MS, attempts: 0 }
    return String(randomInt(0, 1_000_000)).padStart(6, '0')
  }

  /** Burns the current code and issues a new one for the app to display. */
  private rotatePairingCode(): void {
    this.deps.db.settings.update({ telegramBridgePairingCode: this.issuePairingCode() })
  }

  /** Store/replace config and (re)start or stop the bridge. */
  setTelegram(input: SetTelegramInput): ImBridgeStatus {
    const trimmedToken = input.token?.trim() ?? ''
    const tokenChanged = trimmedToken.length > 0
    if (tokenChanged) {
      const { encryptedBase64, preview } = this.deps.keystore.encryptKey(trimmedToken)
      this.deps.db.secrets.set('im_bridge', TELEGRAM_OWNER, TOKEN_NAME, encryptedBase64, preview)
    }
    // A new bot token means a new bot: drop the old pinned chat so the next
    // sender must re-pair, rather than leaving a stale authorization in place.
    const current = this.deps.db.settings.get()
    const pinnedChat = tokenChanged ? null : current.telegramBridgeAllowedChatId
    // Provision a fresh pairing code whenever the bridge is (re)enabled without
    // a pinned chat, so the UI always has a code to show and stale codes never
    // linger. Clear it once a chat is pinned.
    const needsPairing = input.enabled && pinnedChat === null
    const pairingCode = needsPairing ? this.issuePairingCode() : null
    if (!needsPairing) this.pairing = null
    this.deps.db.settings.update({
      telegramBridgeEnabled: input.enabled,
      telegramBridgeConversationId: input.conversationId,
      ...(tokenChanged ? { telegramBridgeAllowedChatId: null } : {}),
      telegramBridgePairingCode: pairingCode,
    })
    this.startBridge()
    return this.status()
  }

  setWebhook(url: string | null): ImBridgeStatus {
    this.deps.db.settings.update({ outboundWebhookUrl: url && url.trim() ? url.trim() : null })
    return this.status()
  }

  /** Connect the bridge at startup if configured. */
  start(): void {
    this.startBridge()
  }

  stopAll(): void {
    this.stopBridge()
  }

  /** POSTs a payload to the configured outbound webhook. */
  private async postWebhook(
    payload: Record<string, unknown>
  ): Promise<'unconfigured' | 'sent' | 'failed'> {
    const url = this.deps.db.settings.get().outboundWebhookUrl
    if (!url) return 'unconfigured'
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return 'unconfigured'
    }
    // Same rule the URL was validated against at set time (isAllowedHttpUrl):
    // https, or http only for a loopback host (localhost / 127.0.0.1 / [::1]).
    // Keeping delivery in lockstep with set-time means a webhook accepted in
    // Settings actually fires instead of being silently dropped here.
    if (!isAllowedHttpUrl(url)) {
      return 'unconfigured'
    }
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)
    try {
      const res = await fetchImpl(parsed.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(payload),
      })
      return res.ok ? 'sent' : 'failed'
    } catch {
      return 'failed'
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Completion-hook target: POST a compact event to the configured outbound
   * webhook. Best-effort; failures are swallowed.
   */
  async onCompletion(conversation: Conversation, message: Message): Promise<void> {
    if (message.role !== 'assistant') return
    await this.postWebhook({
      type: 'assistant_message',
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      content: redactSecrets(message.content),
      createdAt: message.createdAt,
    })
  }

  /**
   * Delivers a workflow notification through every configured channel: the
   * Telegram bridge (to the pinned owner chat) and/or the outbound webhook.
   * Throws unless at least one channel ACTUALLY accepted the message, so a
   * notify node fails visibly instead of silently dropping its payload.
   */
  async notify(text: string): Promise<void> {
    let configured = false
    let delivered = false
    const allowedChat = this.deps.db.settings.get().telegramBridgeAllowedChatId
    if (this.bridge && allowedChat !== null) {
      configured = true
      if (await this.bridge.send(allowedChat, text.slice(0, 4000))) delivered = true
    }
    const webhook = await this.postWebhook({
      type: 'workflow_notification',
      content: redactSecrets(text),
      createdAt: Date.now(),
    })
    if (webhook !== 'unconfigured') configured = true
    if (webhook === 'sent') delivered = true
    if (!configured) {
      throw new Error(
        'No delivery channel available — connect the Telegram bridge or configure a webhook.'
      )
    }
    if (!delivered) {
      throw new Error('Delivery failed on every configured channel (Telegram/webhook).')
    }
  }
}
