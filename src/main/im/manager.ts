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
      onMessage: (_chatId, text) => this.deps.generateReply(conversationId, text),
      onError: () => undefined,
    })
    this.bridge.start()
  }

  /** Store/replace config and (re)start or stop the bridge. */
  setTelegram(input: SetTelegramInput): ImBridgeStatus {
    if (input.token && input.token.trim().length > 0) {
      const { encryptedBase64, preview } = this.deps.keystore.encryptKey(input.token.trim())
      this.deps.db.secrets.set('im_bridge', TELEGRAM_OWNER, TOKEN_NAME, encryptedBase64, preview)
    }
    this.deps.db.settings.update({
      telegramBridgeEnabled: input.enabled,
      telegramBridgeConversationId: input.conversationId,
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

  /**
   * Completion-hook target: POST a compact event to the configured outbound
   * webhook. Best-effort; failures are swallowed.
   */
  async onCompletion(conversation: Conversation, message: Message): Promise<void> {
    const url = this.deps.db.settings.get().outboundWebhookUrl
    if (!url || message.role !== 'assistant') return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      return
    }
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)
    try {
      await fetchImpl(parsed.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          type: 'assistant_message',
          conversationId: conversation.id,
          conversationTitle: conversation.title,
          content: redactSecrets(message.content),
          createdAt: message.createdAt,
        }),
      })
    } catch {
      // best-effort
    } finally {
      clearTimeout(timer)
    }
  }
}
