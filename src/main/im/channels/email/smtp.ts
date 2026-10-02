/**
 * A minimal SMTP submission client (v53): implicit TLS (465) or STARTTLS
 * (587), AUTH PLAIN with an AUTH LOGIN fallback, one message per connection.
 * Plain TCP without TLS is honoured only for loopback hosts (tests, local
 * bridges). The password never appears in an error message.
 */

import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { Duplex } from 'node:stream'
import { isLoopbackHost } from './imap'

export interface SmtpOptions {
  host: string
  port: number
  /** 'tls' = implicit TLS; 'starttls' = upgrade after EHLO; 'none' = loopback only. */
  security: 'tls' | 'starttls' | 'none'
  username: string
  password: string
  timeoutMs?: number
  /** Test seam: provide the connected plain stream (STARTTLS is then skipped). */
  connect?: () => Duplex
}

class SmtpConnection {
  private buffer = ''
  private waiters: Array<() => void> = []
  private error: Error | null = null
  private detach: (() => void) | null = null

  constructor(
    public stream: Duplex,
    private readonly timeoutMs: number
  ) {
    this.attach(stream)
  }

  /**
   * Reads from `stream` from now on. On a STARTTLS upgrade the old plain
   * listeners are removed and anything still buffered from the plaintext
   * phase is DISCARDED (RFC 3207 §4.2) — a man in the middle could have
   * appended fake replies after the server's 220.
   */
  attach(stream: Duplex): void {
    this.detach?.()
    this.buffer = ''
    this.stream = stream
    stream.setEncoding?.('utf8')
    const onData = (chunk: string | Buffer): void => {
      this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      this.wake()
    }
    const onError = (error: Error): void => {
      this.error = error
      this.wake()
    }
    const onClose = (): void => {
      this.error ??= new Error('SMTP connection closed')
      this.wake()
    }
    stream.on('data', onData)
    stream.on('error', onError)
    stream.on('close', onClose)
    this.detach = () => {
      stream.off('data', onData)
      stream.off('error', onError)
      stream.off('close', onClose)
    }
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  /** Reads one (possibly multi-line) reply: "250-…" lines until "250 …". */
  async reply(): Promise<{ code: number; text: string }> {
    const deadline = Date.now() + this.timeoutMs
    for (;;) {
      const lines = this.buffer.split('\r\n')
      for (let i = 0; i < lines.length - 1; i++) {
        const match = lines[i].match(/^(\d{3})([ -])(.*)$/)
        if (match && match[2] === ' ') {
          const text = lines.slice(0, i + 1).map((l) => l.slice(4)).join('\n')
          this.buffer = lines.slice(i + 1).join('\r\n')
          return { code: Number(match[1]), text }
        }
      }
      if (this.error) throw this.error
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('SMTP server timed out')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining)
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  async send(line: string, expect: number[], label = line.split(' ')[0]): Promise<string> {
    this.stream.write(`${line}\r\n`)
    const reply = await this.reply()
    if (!expect.includes(reply.code)) {
      throw new Error(`SMTP ${label} failed (${reply.code}): ${reply.text.slice(0, 160)}`)
    }
    return reply.text
  }
}

/** RFC 5321 dot-stuffing + terminator. */
export function dotStuff(message: string): string {
  const normalized = message.replace(/\r?\n/g, '\r\n')
  return `${normalized.replace(/^\./gm, '..')}\r\n.\r\n`
}

export async function sendMail(
  options: SmtpOptions,
  envelope: { from: string; to: string[] },
  message: string
): Promise<void> {
  const { host, port } = options
  if (options.security === 'none' && !isLoopbackHost(host)) {
    throw new Error('SMTP without TLS is only allowed for a local server.')
  }
  // Defence in depth: an envelope address can never carry a line break or a
  // bracket, so it can never become a second SMTP command.
  // eslint-disable-next-line no-control-regex
  const unsafe = [envelope.from, ...envelope.to].find((address) => /[\s\x00-\x1f\x7f<>]/.test(address) || !address)
  if (unsafe !== undefined) throw new Error('Refusing an invalid email address in the SMTP envelope.')
  const timeoutMs = options.timeoutMs ?? 30_000
  const plain: Duplex =
    options.connect?.() ??
    (options.security === 'tls'
      ? tlsConnect({ host, port, servername: host })
      : (netConnect({ host, port }) as Socket))
  const conn = new SmtpConnection(plain, timeoutMs)
  try {
    const greeting = await conn.reply()
    if (greeting.code !== 220) throw new Error(`SMTP server refused: ${greeting.text.slice(0, 120)}`)
    let capabilities = await conn.send('EHLO grasberg.local', [250], 'EHLO')
    if (options.security === 'starttls' && !options.connect) {
      await conn.send('STARTTLS', [220])
      const secured: TLSSocket = tlsConnect({ socket: plain as Socket, servername: host })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          secured.destroy()
          reject(new Error('SMTP TLS handshake timed out'))
        }, timeoutMs)
        secured.once('secureConnect', () => {
          clearTimeout(timer)
          resolve()
        })
        secured.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
      })
      conn.attach(secured)
      capabilities = await conn.send('EHLO grasberg.local', [250], 'EHLO')
    }
    if (options.username) {
      const hasPlain = /AUTH[ =][^\n]*\bPLAIN\b/i.test(capabilities)
      const hasLogin = /AUTH[ =][^\n]*\bLOGIN\b/i.test(capabilities)
      let authed = false
      if (hasPlain || !hasLogin) {
        const token = Buffer.from(`\u0000${options.username}\u0000${options.password}`).toString('base64')
        try {
          await conn.send(`AUTH PLAIN ${token}`, [235], 'AUTH')
          authed = true
        } catch (e) {
          if (!hasLogin) throw e
        }
      }
      if (!authed) {
        await conn.send('AUTH LOGIN', [334], 'AUTH')
        await conn.send(Buffer.from(options.username).toString('base64'), [334], 'AUTH')
        await conn.send(Buffer.from(options.password).toString('base64'), [235], 'AUTH')
      }
    }
    await conn.send(`MAIL FROM:<${envelope.from}>`, [250], 'MAIL FROM')
    for (const recipient of envelope.to) {
      await conn.send(`RCPT TO:<${recipient}>`, [250, 251], 'RCPT TO')
    }
    await conn.send('DATA', [354])
    conn.stream.write(dotStuff(message))
    const accepted = await conn.reply()
    if (accepted.code !== 250) throw new Error(`SMTP rejected the message (${accepted.code}): ${accepted.text.slice(0, 160)}`)
    try {
      await conn.send('QUIT', [221])
    } catch {
      // the message is already accepted
    }
  } finally {
    conn.stream.destroy()
  }
}
