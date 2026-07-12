/**
 * Minimal Telegram Bot bridge: long-polls getUpdates, hands each text message
 * to `onMessage`, and sends the returned reply back. No third-party SDK — just
 * the Bot HTTP API. Injectable fetch for tests; `pollOnce` is exposed so the
 * update-handling can be tested without the polling loop.
 */

export interface TelegramBridgeDeps {
  token: string
  onMessage: (chatId: number, text: string) => Promise<string>
  onError?: (message: string) => void
  fetchImpl?: typeof fetch
}

const POLL_TIMEOUT_SEC = 25
const MAX_REPLY_CHARS = 4000
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

  /** One getUpdates round; processes and replies to each text message. */
  async pollOnce(): Promise<void> {
    const fetchImpl = this.deps.fetchImpl ?? fetch
    this.aborter = new AbortController()
    const url = `${this.api('getUpdates')}?timeout=${POLL_TIMEOUT_SEC}&offset=${this.offset}`
    const res = await fetchImpl(url, { signal: this.aborter.signal })
    const data = (await res.json()) as {
      ok?: boolean
      error_code?: number
      result?: Array<{ update_id: number; message?: { text?: string; chat?: { id?: number } } }>
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
