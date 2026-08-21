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

export interface TelegramBridgeDeps {
  token: string
  onMessage: (chatId: number, text: string) => Promise<string>
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

  constructor(private readonly deps: TelegramBridgeDeps) {}

  private api(method: string): string {
    return `https://api.telegram.org/bot${this.deps.token}/${method}`
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
        message?: { text?: string; chat?: { id?: number } }
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
        await this.handle(chatId, msg.text)
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
