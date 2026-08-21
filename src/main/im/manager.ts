/**
 * IM bridge manager: owns the Telegram bridge lifecycle and the generic
 * outbound webhook. The bot token is stored encrypted (tool_secrets, scope
 * 'im_bridge'); an inbound message runs a headless generation on the bound
 * conversation and the reply is sent back.
 */

import { randomInt, randomUUID } from 'node:crypto'
import type { Conversation, ImBridgeStatus, Message } from '@shared/types'
import { isAllowedHttpUrl } from '@shared/schemas'
import type { AppDatabase } from '../db/database'
import type { Keystore } from '../keys/keystore'
import { redactSecrets } from '../providers/redact'
import { TelegramBridge, type TelegramCallbackResult } from './telegram'

const TELEGRAM_OWNER = 'telegram'
const TOKEN_NAME = 'token'
const WEBHOOK_TIMEOUT_MS = 10_000
/** A six-digit code is guessable, so it is short-lived and cheap to burn. */
const PAIRING_TTL_MS = 15 * 60_000
const PAIRING_MAX_ATTEMPTS = 5
/**
 * How long a remote approval waits for a tap. Shorter than the in-app dialog's
 * five minutes on purpose: a headless run holds a slot in the shared scheduled
 * run queue while it waits, so an unanswered question must not park it there.
 */
const REMOTE_APPROVAL_TIMEOUT_MS = 3 * 60_000
/** Chars of the proposed action shown in the chat message. */
const REMOTE_APPROVAL_DETAIL_MAX = 900

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
  /**
   * Remote approvals waiting for a tap, keyed by the opaque token that travels
   * through Telegram in callback_data. `requestKey` is the caller's own handle
   * (the approval requestId) so a request answered in the app can cancel its
   * Telegram twin. Nothing about the decision is derivable from the token — it
   * is a lookup key into this map and nothing else.
   */
  private readonly remoteApprovals = new Map<
    string,
    {
      requestKey: string
      chatId: number
      messageId: number | null
      summary: string
      settle: (answer: boolean | null) => void
    }
  >()
  private readonly remoteApprovalTokens = new Map<string, string>()

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
      onCallback: (chatId, data) => this.handleCallback(chatId, data),
      onError: () => undefined,
    })
    this.bridge.start()
  }

  /**
   * True when a remote approval could actually be delivered right now: the
   * feature is on, the bridge is connected, and a chat has paired. Checked
   * before asking so a headless run fails fast instead of waiting three
   * minutes for a message nobody will ever see.
   */
  remoteApprovalsAvailable(): boolean {
    const settings = this.deps.db.settings.get()
    return (
      settings.remoteApprovalsEnabled &&
      this.bridge !== null &&
      settings.telegramBridgeAllowedChatId !== null
    )
  }

  /**
   * Asks the paired chat to approve one action, resolving true (allowed),
   * false (denied) or null — no channel, send failed, or nobody tapped in
   * time. Null is NOT an approval: every caller treats it as a decline.
   *
   * `requestKey` lets the caller cancel this when the same request is answered
   * in the app instead (see cancelApproval).
   */
  async requestApproval(
    requestKey: string,
    input: { title: string; detail: string }
  ): Promise<boolean | null> {
    if (!this.remoteApprovalsAvailable()) return null
    const bridge = this.bridge
    const chatId = this.deps.db.settings.get().telegramBridgeAllowedChatId
    if (!bridge || chatId === null) return null
    // Already asking about this request — never double-send.
    if (this.remoteApprovalTokens.has(requestKey)) return null

    const token = randomUUID().replace(/-/g, '').slice(0, 24)
    // The detail can be raw tool arguments, so it goes through redaction before
    // it leaves the machine: a Telegram message is stored on their servers and
    // in a phone's notification history long after the app forgot the call.
    const summary =
      `Approval needed\n\n${input.title}\n\n` +
      redactSecrets(input.detail).slice(0, REMOTE_APPROVAL_DETAIL_MAX)
    const messageId = await bridge.sendButtons(chatId, summary, [
      { text: 'Allow once', data: `a:${token}` },
      { text: 'Deny', data: `d:${token}` },
    ])
    if (messageId === null) return null

    return new Promise<boolean | null>((resolve) => {
      const timer = setTimeout(() => this.settleRemote(token, null), REMOTE_APPROVAL_TIMEOUT_MS)
      timer.unref?.()
      this.remoteApprovals.set(token, {
        requestKey,
        chatId,
        messageId,
        summary,
        settle: (answer) => {
          clearTimeout(timer)
          resolve(answer)
        },
      })
      this.remoteApprovalTokens.set(requestKey, token)
    })
  }

  /** Resolves one pending remote approval and forgets its token. */
  private settleRemote(token: string, answer: boolean | null): boolean {
    const pending = this.remoteApprovals.get(token)
    if (!pending) return false
    this.remoteApprovals.delete(token)
    this.remoteApprovalTokens.delete(pending.requestKey)
    pending.settle(answer)
    return true
  }

  /**
   * The request was answered elsewhere (the desktop dialog, a timeout, app
   * quit): stop waiting and rewrite the Telegram message so its buttons can no
   * longer be tapped into a stale decision.
   */
  cancelApproval(requestKey: string, reason = 'Handled in the app.'): void {
    const token = this.remoteApprovalTokens.get(requestKey)
    if (!token) return
    const pending = this.remoteApprovals.get(token)
    if (!this.settleRemote(token, null)) return
    if (pending && pending.messageId !== null) {
      void this.bridge?.editMessage(pending.chatId, pending.messageId, `${pending.summary}\n\n${reason}`)
    }
  }

  /**
   * One inline-button tap. ONLY the pinned owner chat is obeyed — the same
   * authorization the message path uses, applied again here because a button
   * payload arrives from whoever tapped it, not from whoever it was sent to.
   */
  private async handleCallback(chatId: number, data: string): Promise<TelegramCallbackResult> {
    const allowed = this.deps.db.settings.get().telegramBridgeAllowedChatId
    if (allowed === null || allowed !== chatId) {
      return { toast: 'This assistant only responds to its owner.' }
    }
    const approved = data.startsWith('a:')
    if (!approved && !data.startsWith('d:')) return { toast: 'Unrecognized action.' }
    const token = data.slice(2)
    const pending = this.remoteApprovals.get(token)
    if (!pending || !this.settleRemote(token, approved)) {
      return { toast: 'That request is no longer waiting.' }
    }
    return {
      toast: approved ? 'Allowed.' : 'Denied.',
      replaceText: `${pending.summary}\n\n${approved ? 'Allowed' : 'Denied'} from Telegram.`,
    }
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
    // Anything still waiting on a tap resolves to null (= declined), so no
    // executor promise can outlive the session waiting on a phone.
    for (const token of [...this.remoteApprovals.keys()]) {
      this.settleRemote(token, null)
    }
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
  /**
   * Whether notify() has at least one configured channel — the same checks as
   * notify() but with NO sends. Used by workflow dry runs so a missing
   * delivery channel fails the dry run exactly like it would fail a real run.
   */
  notifyConfigured(): boolean {
    const settings = this.deps.db.settings.get()
    if (this.bridge && settings.telegramBridgeAllowedChatId !== null) return true
    const url = settings.outboundWebhookUrl
    if (!url) return false
    try {
      new URL(url)
      return true
    } catch {
      return false
    }
  }

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
