/**
 * IM bridge manager: owns the Telegram bridge lifecycle and the generic
 * outbound webhook. The bot token is stored encrypted (tool_secrets, scope
 * 'im_bridge'); an inbound message runs a headless generation on the bound
 * conversation and the reply is sent back.
 */

import type { Conversation, ImBridgeStatus, Message } from '@shared/types'
import type { AppDatabase } from '../db/database'
import type { Keystore } from '../keys/keystore'
import { redactSecrets } from '../providers/redact'
import { TelegramBridge } from './telegram'

const TELEGRAM_OWNER = 'telegram'
const TOKEN_NAME = 'token'
const WEBHOOK_TIMEOUT_MS = 10_000

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
   * addressable, so without a sender check ANY stranger could talk to the
   * user's bound conversation (leaking its history/memories and burning
   * credits). We pin the FIRST chat that messages the bot as the authorized one
   * (trust on first use) and refuse every other sender thereafter.
   */
  private async handleInbound(chatId: number, text: string, conversationId: string): Promise<string> {
    const allowed = this.deps.db.settings.get().telegramBridgeAllowedChatId
    if (allowed === null) {
      this.deps.db.settings.update({ telegramBridgeAllowedChatId: chatId })
    } else if (allowed !== chatId) {
      return 'This assistant is private and only responds to its owner.'
    }
    return this.deps.generateReply(conversationId, text)
  }

  /** Store/replace config and (re)start or stop the bridge. */
  setTelegram(input: SetTelegramInput): ImBridgeStatus {
    const trimmedToken = input.token?.trim() ?? ''
    const tokenChanged = trimmedToken.length > 0
    if (tokenChanged) {
      const { encryptedBase64, preview } = this.deps.keystore.encryptKey(trimmedToken)
      this.deps.db.secrets.set('im_bridge', TELEGRAM_OWNER, TOKEN_NAME, encryptedBase64, preview)
    }
    this.deps.db.settings.update({
      telegramBridgeEnabled: input.enabled,
      telegramBridgeConversationId: input.conversationId,
      // A new bot token means a new bot: drop the old pinned chat so the next
      // sender re-pairs, rather than leaving a stale authorization in place.
      ...(tokenChanged ? { telegramBridgeAllowedChatId: null } : {}),
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
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
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
