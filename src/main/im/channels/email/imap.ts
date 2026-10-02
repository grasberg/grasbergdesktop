/**
 * A minimal IMAP4rev1 client (v53) — exactly the commands an agent mailbox
 * needs: LOGIN, SELECT, UID SEARCH, UID FETCH (BODY.PEEK so reading never
 * marks mail as seen by accident), UID STORE +FLAGS, LOGOUT. Implicit TLS
 * (port 993) is required; plain TCP is accepted only for a loopback host
 * (tests and local bridges such as Proton Mail Bridge).
 *
 * The response reader handles IMAP literals ({n}\r\n<n bytes>) inside a
 * response line, which is how message bodies and many header values arrive.
 */

import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { Duplex } from 'node:stream'

export interface ImapOptions {
  host: string
  port: number
  username: string
  password: string
  /** Defaults to true; false is honoured only for loopback hosts. */
  secure?: boolean
  timeoutMs?: number
  /** Test seam: provide the connected stream. */
  connect?: () => Duplex
}

interface ImapResponse {
  /** The response line with each literal replaced by "{n}". */
  text: string
  literals: Buffer[]
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1)$/i

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.test(host.trim())
}

/** IMAP quoted string. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export class ImapClient {
  private stream: Duplex | null = null
  private buffer = Buffer.alloc(0)
  /** Chunks not yet joined into `buffer` (joined lazily — no quadratic concat). */
  private pending: Buffer[] = []
  private tagCounter = 0
  private waiters: Array<() => void> = []
  private closedError: Error | null = null

  constructor(private readonly options: ImapOptions) {}

  async connect(): Promise<void> {
    const { host, port } = this.options
    const secure = this.options.secure !== false || !isLoopbackHost(host)
    const stream: Duplex =
      this.options.connect?.() ??
      (secure
        ? tlsConnect({ host, port, servername: host })
        : (netConnect({ host, port }) as Socket))
    this.stream = stream
    stream.on('data', (chunk: Buffer) => {
      this.pending.push(chunk)
      this.wake()
    })
    stream.on('error', (error: Error) => {
      this.closedError = error
      this.wake()
    })
    stream.on('close', () => {
      this.closedError ??= new Error('IMAP connection closed')
      this.wake()
    })
    const greeting = await this.readResponse()
    if (!/^\* (OK|PREAUTH)/i.test(greeting.text)) {
      throw new Error(`IMAP server refused the connection: ${greeting.text.slice(0, 120)}`)
    }
  }

  async login(): Promise<void> {
    await this.command(`LOGIN ${quote(this.options.username)} ${quote(this.options.password)}`, {
      redact: true,
    })
  }

  async select(mailbox = 'INBOX'): Promise<{ exists: number }> {
    const { untagged } = await this.command(`SELECT ${quote(mailbox)}`)
    let exists = 0
    for (const response of untagged) {
      const match = response.text.match(/^\* (\d+) EXISTS/i)
      if (match) exists = Number(match[1])
    }
    return { exists }
  }

  async search(criteria: string): Promise<number[]> {
    const { untagged } = await this.command(`UID SEARCH ${criteria}`)
    const uids: number[] = []
    for (const response of untagged) {
      const match = response.text.match(/^\* SEARCH\b(.*)$/i)
      if (match) {
        for (const token of match[1].trim().split(/\s+/)) {
          const uid = Number(token)
          if (Number.isInteger(uid) && uid > 0) uids.push(uid)
        }
      }
    }
    return uids.sort((a, b) => a - b)
  }

  /**
   * The raw message (BODY.PEEK[] — does not set \Seen), optionally only its
   * first `maxBytes` (a partial fetch, so attachments never load in full).
   */
  async fetchRaw(uid: number, maxBytes?: number): Promise<Buffer | null> {
    const part = maxBytes ? `BODY.PEEK[]<0.${Math.max(1, Math.floor(maxBytes))}>` : 'BODY.PEEK[]'
    const { untagged } = await this.command(`UID FETCH ${uid} (UID ${part})`)
    for (const response of untagged) {
      if (/FETCH/i.test(response.text) && response.literals.length > 0) return response.literals[0]
    }
    return null
  }

  /** Header blocks for several messages (for listing). */
  async fetchHeaders(uids: number[]): Promise<Array<{ uid: number; header: Buffer }>> {
    if (uids.length === 0) return []
    const { untagged } = await this.command(
      `UID FETCH ${uids.join(',')} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)])`
    )
    const out: Array<{ uid: number; header: Buffer }> = []
    for (const response of untagged) {
      const uid = Number(response.text.match(/UID (\d+)/i)?.[1] ?? NaN)
      if (Number.isInteger(uid) && response.literals.length > 0) {
        out.push({ uid, header: response.literals[0] })
      }
    }
    return out
  }

  async addFlags(uid: number, flags: string): Promise<void> {
    await this.command(`UID STORE ${uid} +FLAGS.SILENT (${flags})`)
  }

  async logout(): Promise<void> {
    try {
      // A polite LOGOUT, but never a long wait on a server that already failed us.
      if (this.stream && !this.closedError && this.tagCounter > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          this.command('LOGOUT'),
          new Promise((resolve) => {
            timer = setTimeout(resolve, 3000)
          }),
        ]).finally(() => clearTimeout(timer))
      }
    } catch {
      // closing anyway
    } finally {
      this.stream?.destroy()
      this.stream = null
    }
  }

  // -- protocol core ----------------------------------------------------------

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  private async waitForData(deadline: number): Promise<void> {
    if (this.closedError) throw this.closedError
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('IMAP server timed out')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, remaining)
      this.waiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
    if (this.closedError && this.buffer.length === 0 && this.pending.length === 0) throw this.closedError
  }

  /** Reads one complete response (line + any literals), consuming it from the buffer. */
  private async readResponse(): Promise<ImapResponse> {
    const deadline = Date.now() + (this.options.timeoutMs ?? 30_000)
    for (;;) {
      const parsed = this.tryParse()
      if (parsed) return parsed
      await this.waitForData(deadline)
    }
  }

  private tryParse(): ImapResponse | null {
    if (this.pending.length > 0) {
      this.buffer = Buffer.concat([this.buffer, ...this.pending])
      this.pending = []
    }
    let offset = 0
    let text = ''
    const literals: Buffer[] = []
    for (;;) {
      const lineEnd = this.buffer.indexOf('\r\n', offset)
      if (lineEnd < 0) return null
      const line = this.buffer.subarray(offset, lineEnd).toString('utf8')
      const literal = line.match(/\{(\d+)\}$/)
      if (!literal) {
        text += line
        this.buffer = this.buffer.subarray(lineEnd + 2)
        return { text, literals }
      }
      const size = Number(literal[1])
      const start = lineEnd + 2
      if (this.buffer.length < start + size) return null
      text += line
      literals.push(Buffer.from(this.buffer.subarray(start, start + size)))
      offset = start + size
    }
  }

  private async command(
    command: string,
    opts: { redact?: boolean } = {}
  ): Promise<{ untagged: ImapResponse[] }> {
    if (!this.stream) throw new Error('IMAP is not connected')
    const tag = `G${++this.tagCounter}`
    this.stream.write(`${tag} ${command}\r\n`)
    const untagged: ImapResponse[] = []
    for (;;) {
      const response = await this.readResponse()
      if (response.text.startsWith(`${tag} `)) {
        const status = response.text.slice(tag.length + 1)
        if (!/^OK/i.test(status)) {
          const what = opts.redact ? command.split(' ')[0] : command.slice(0, 60)
          throw new Error(`IMAP ${what} failed: ${status.slice(0, 160)}`)
        }
        return { untagged }
      }
      if (response.text.startsWith('+')) continue // continuation we never request
      untagged.push(response)
    }
  }
}
