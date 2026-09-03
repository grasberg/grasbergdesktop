/**
 * Minimal Telegram Bot bridge: long-polls getUpdates, hands each text message
 * to `onMessage`, and sends the returned reply back. No third-party SDK — just
 * the Bot HTTP API. Injectable fetch for tests; `pollOnce` is exposed so the
 * update-handling can be tested without the polling loop.
 *
 * Inline buttons (sendButtons/onCallback) carry remote tool approvals: the app
 * asks "Allow this?" and the tap comes back as a callback_query. The payload in
 * `callback_data` is an opaque token minted by the caller — Telegram caps it at
 * 64 bytes and it travels through Telegram's servers, so it must never be
 * anything but a lookup key.
 */

/** One inline-keyboard button. `data` is echoed back as the callback payload. */
export interface TelegramButton {
  text: string
  /** Opaque lookup key, at most 64 bytes (Telegram's callback_data limit). */
  data: string
}

/** What a button tap produced: a toast, and optionally new message text. */
export interface TelegramCallbackResult {
  /** Short confirmation shown over the chat (Telegram caps it at ~200 chars). */
  toast: string
  /** When set, replaces the message text and drops its buttons. */
  replaceText?: string
}

/**
 * Enriched inbound message for gateway-style bot bindings (v47): chat type,
 * sender identity, and the two mention facts group gating needs (an explicit
 * @botusername mention, and a reply to one of the bot's own messages).
 */
export interface TelegramInbound {
  chatId: number
  chatType: 'private' | 'group' | 'supergroup' | 'channel'
  chatTitle: string
  text: string
  senderId: number | null
  senderName: string
  mentionsBot: boolean
  isReplyToBot: boolean
}

export interface TelegramBridgeDeps {
  token: string
  onMessage: (chatId: number, text: string) => Promise<string>
  /**
   * Richer handler (v47): when set it REPLACES onMessage. Returning null
   * sends nothing — group-gated silence, or a reply that will be delivered
   * later via send() once the agent turn completes.
   */
  onInbound?: (message: TelegramInbound) => Promise<string | null>
  /** Inline-button tap from any chat; the handler authorizes the sender. */
  onCallback?: (chatId: number, data: string) => Promise<TelegramCallbackResult>
  onError?: (message: string) => void
  fetchImpl?: typeof fetch
}

const POLL_TIMEOUT_SEC = 25
const MAX_REPLY_CHARS = 4000
/** Telegram's hard limit on callback_data. */
const CALLBACK_DATA_MAX_BYTES = 64
/** Telegram's limit on the toast shown after a button tap. */
const MAX_TOAST_CHARS = 200
const BACKOFF_MS = 3000
/** Consecutive rejected-token polls before the bridge gives up entirely. */
const MAX_AUTH_FAILURES = 5

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Telegram reports API failures (revoked token, 409 conflict) as a JSON body
 * with ok:false, which returns immediately — so they must be raised as errors,
 * or the poll loop re-issues getUpdates with no delay at all.
 */
class TelegramApiError extends Error {
  constructor(readonly errorCode: number) {
    super(`Telegram API error ${errorCode}`)
  }

  /** A rejected/unknown bot token: retrying can never succeed. */
  get unauthorized(): boolean {
    return this.errorCode === 401 || this.errorCode === 403 || this.errorCode === 404
  }
}

export class TelegramBridge {
  private offset = 0
  private running = false
  private aborter: AbortController | null = null
  /** Cached getMe identity, fetched lazily for mention/reply detection. */
  private self: { id: number; username: string } | null = null

  constructor(private readonly deps: TelegramBridgeDeps) {}

  private api(method: string): string {
    return `https://api.telegram.org/bot${this.deps.token}/${method}`
  }

  /** The bot's own id + username (cached; null while unreachable). */
  private async getSelf(): Promise<{ id: number; username: string } | null> {
    if (this.self) return this.self
    const fetchImpl = this.deps.fetchImpl ?? fetch
    try {
      const res = await fetchImpl(this.api('getMe'))
      const body = (await res.json()) as {
        ok?: boolean
        result?: { id?: number; username?: string }
      }
      if (body.ok && typeof body.result?.id === 'number') {
        this.self = { id: body.result.id, username: body.result.username ?? '' }
      }
    } catch {
      // transient; retried on the next inbound message
    }
    return this.self
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  stop(): void {
    this.running = false
    this.aborter?.abort()
  }

  private async loop(): Promise<void> {
    let authFailures = 0
    while (this.running) {
      try {
        await this.pollOnce()
        authFailures = 0
      } catch (e) {
        if (!this.running) break
        if (e instanceof TelegramApiError && e.unauthorized) {
          authFailures += 1
          if (authFailures >= MAX_AUTH_FAILURES) {
            this.running = false
            this.deps.onError?.(
              'Telegram rejected the bot token — the bridge stopped. Re-enter the token in Settings.'
            )
            break
          }
        }
        await sleep(BACKOFF_MS) // backoff on transient errors and API errors
      }
    }
  }

  /** One getUpdates round; processes text messages and inline-button taps. */
  async pollOnce(): Promise<void> {
    const fetchImpl = this.deps.fetchImpl ?? fetch
    this.aborter = new AbortController()
    const url = `${this.api('getUpdates')}?timeout=${POLL_TIMEOUT_SEC}&offset=${this.offset}`
    const res = await fetchImpl(url, { signal: this.aborter.signal })
    const data = (await res.json()) as {
      ok?: boolean
      error_code?: number
      result?: Array<{
        update_id: number
        message?: {
          text?: string
          chat?: { id?: number; type?: string; title?: string }
          from?: { id?: number; first_name?: string; username?: string }
          reply_to_message?: { from?: { id?: number } }
        }
        callback_query?: {
          id?: string
          data?: string
          message?: { message_id?: number; chat?: { id?: number } }
        }
      }>
    }
    if (!data.ok) throw new TelegramApiError(data.error_code ?? res.status)
    if (!Array.isArray(data.result)) return
    for (const update of data.result) {
      this.offset = update.update_id + 1
      const msg = update.message
      const chatId = msg?.chat?.id
      if (msg && typeof msg.text === 'string' && typeof chatId === 'number') {
        if (this.deps.onInbound) {
          const self = await this.getSelf()
          const chatType = (msg.chat?.type ?? 'private') as TelegramInbound['chatType']
          const inbound: TelegramInbound = {
            chatId,
            chatType,
            chatTitle: msg.chat?.title ?? '',
            text: msg.text,
            senderId: typeof msg.from?.id === 'number' ? msg.from.id : null,
            senderName: msg.from?.first_name ?? msg.from?.username ?? 'someone',
            mentionsBot:
              !!self?.username &&
              msg.text.toLowerCase().includes(`@${self.username.toLowerCase()}`),
            isReplyToBot:
              self !== null && msg.reply_to_message?.from?.id === self.id,
          }
          await this.handleInboundEx(inbound)
        } else {
          await this.handle(chatId, msg.text)
        }
      }
      const callback = update.callback_query
      const callbackChatId = callback?.message?.chat?.id
      if (
        callback &&
        typeof callback.id === 'string' &&
        typeof callback.data === 'string' &&
        typeof callbackChatId === 'number'
      ) {
        await this.handleCallback(
          callback.id,
          callbackChatId,
          callback.message?.message_id,
          callback.data
        )
      }
    }
  }

  private async handle(chatId: number, text: string): Promise<void> {
    let reply: string
    try {
      reply = await this.deps.onMessage(chatId, text)
    } catch (e) {
      reply = `Sorry — ${e instanceof Error ? e.message : 'something went wrong'}.`
      this.deps.onError?.(reply)
    }
    await this.send(chatId, reply)
  }

  /** The onInbound path: null means silence (or a reply delivered later). */
  private async handleInboundEx(inbound: TelegramInbound): Promise<void> {
    let reply: string | null
    try {
      reply = (await this.deps.onInbound?.(inbound)) ?? null
    } catch (e) {
      reply = `Sorry — ${e instanceof Error ? e.message : 'something went wrong'}.`
      this.deps.onError?.(reply)
    }
    if (reply !== null) await this.send(inbound.chatId, reply)
  }

  /** Best-effort "typing…" indicator while an agent turn runs. Never throws. */
  async sendTyping(chatId: number): Promise<void> {
    const fetchImpl = this.deps.fetchImpl ?? fetch
    try {
      await fetchImpl(this.api('sendChatAction'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
      })
    } catch {
      // cosmetic only
    }
  }

  /**
   * One inline-button tap. Telegram spins the button until answerCallbackQuery
   * arrives, so it is always sent — even when the handler threw.
   */
  private async handleCallback(
    callbackQueryId: string,
    chatId: number,
    messageId: number | undefined,
    data: string
  ): Promise<void> {
    let result: TelegramCallbackResult = { toast: 'No longer available.' }
    try {
      if (this.deps.onCallback) result = await this.deps.onCallback(chatId, data)
    } catch (e) {
      result = { toast: e instanceof Error ? e.message : 'Something went wrong.' }
      this.deps.onError?.(result.toast)
    }
    await this.answerCallback(callbackQueryId, result.toast)
    if (result.replaceText !== undefined && messageId !== undefined) {
      await this.editMessage(chatId, messageId, result.replaceText)
    }
  }

  /**
   * Sends a message with a single row of inline buttons. Resolves with the
   * sent message_id (so the caller can later rewrite it and drop the buttons)
   * or null when Telegram refused. Never throws.
   */
  async sendButtons(
    chatId: number,
    text: string,
    buttons: TelegramButton[]
  ): Promise<number | null> {
    const fetchImpl = this.deps.fetchImpl ?? fetch
    try {
      const res = await fetchImpl(this.api('sendMessage'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: (text || '(no text)').slice(0, MAX_REPLY_CHARS),
          reply_markup: {
            inline_keyboard: [
              buttons.map((button) => ({
                text: button.text,
                callback_data: button.data.slice(0, CALLBACK_DATA_MAX_BYTES),
              })),
            ],
          },
        }),
      })
      if (!res.ok) return null
      const body = (await res.json()) as { ok?: boolean; result?: { message_id?: number } }
      const messageId = body.result?.message_id
      return typeof messageId === 'number' ? messageId : null
    } catch {
      // best-effort; a failed send should not crash the bridge
      return null
    }
  }

  /** Acknowledges a button tap so Telegram stops showing its spinner. */
  private async answerCallback(callbackQueryId: string, text: string): Promise<void> {
    const fetchImpl = this.deps.fetchImpl ?? fetch
    try {
      await fetchImpl(this.api('answerCallbackQuery'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          text: text.slice(0, MAX_TOAST_CHARS),
        }),
      })
    } catch {
      // Best-effort; the spinner clears on Telegram's own timeout.
    }
  }

  /** Rewrites a sent message and drops its buttons (no reply_markup). */
  async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    const fetchImpl = this.deps.fetchImpl ?? fetch
    try {
      await fetchImpl(this.api('editMessageText'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: text.slice(0, MAX_REPLY_CHARS),
        }),
      })
    } catch {
      // The buttons stay, but the token is already spent — a second tap is inert.
    }
  }

  /** True only when Telegram accepted the message (2xx). Never throws. */
  async send(chatId: number, text: string): Promise<boolean> {
    const fetchImpl = this.deps.fetchImpl ?? fetch
    try {
      const res = await fetchImpl(this.api('sendMessage'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: (text || '(no reply)').slice(0, MAX_REPLY_CHARS) }),
      })
      return res.ok
    } catch {
      // best-effort; a failed send should not crash the bridge
      return false
    }
  }
}
