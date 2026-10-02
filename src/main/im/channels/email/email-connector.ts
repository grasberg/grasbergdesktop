/**
 * Email channel (v53, Muse "its own email address"): a bot gets a mailbox.
 * Inbound: the connector polls INBOX over IMAP and hands every NEW message to
 * the hub (which admits only allowlisted senders). Outbound: replies go out
 * over SMTP threaded to the original (In-Reply-To / References). The same
 * connector backs the agent's email_read / email_send tools.
 *
 * Reading never changes the mailbox: fetches use BODY.PEEK and nothing is
 * marked seen, so pointing a bot at the user's real mailbox is safe.
 */

import { randomUUID } from 'node:crypto'
import type { ChannelCallbacks, ChannelConnector, ChannelTarget } from '../types'
import { ImapClient, type ImapOptions } from './imap'
import { sendMail, type SmtpOptions } from './smtp'
import {
  buildEmail,
  parseAddress,
  parseEmail,
  parseHeaders,
  replySubject,
  senderAuthFailed,
  splitQuoted,
  decodeEncodedWords,
  type ParsedEmail,
} from './mime'

export interface EmailChannelConfig {
  address: string
  displayName?: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  smtpSecurity: 'tls' | 'starttls'
  username: string
  /** Lowercased addresses whose mail becomes a turn. Empty = nobody (safe default). */
  allowedSenders: string[]
  pollMinutes: number
}

export interface EmailSummary {
  uid: number
  from: string
  subject: string
  date: string
}

export interface EmailConnectorDeps {
  /** Persisted high-water mark: messages at or below it are never re-delivered. */
  getLastUid(): number | null
  setLastUid(uid: number): void
  /** Test seams. */
  imap?: (options: ImapOptions) => ImapClient
  smtp?: (options: SmtpOptions, envelope: { from: string; to: string[] }, message: string) => Promise<void>
}

/** New mails handed to the hub per poll (a backlog drains over several polls). */
const MAX_PER_POLL = 10
/** Bytes fetched per message (the text part leads; attachments are only named). */
const FETCH_MAX_BYTES = 512 * 1024
/** Polls a failing message may break before it is skipped. */
const MAX_FETCH_TRIES = 3
const BODY_MAX_CHARS = 20_000

export class EmailConnector implements ChannelConnector {
  private timer: NodeJS.Timeout | null = null
  private polling = false
  private stopped = true
  /** Failed fetch attempts per uid (a poison message is skipped after a few). */
  private readonly fetchFailures = new Map<number, number>()

  constructor(
    private readonly config: EmailChannelConfig,
    private readonly password: string,
    private readonly callbacks: ChannelCallbacks,
    private readonly deps: EmailConnectorDeps
  ) {}

  start(): void {
    this.stopped = false
    this.callbacks.onStatus('connecting', null)
    void this.poll()
    const everyMs = Math.max(1, this.config.pollMinutes || 2) * 60_000
    this.timer = setInterval(() => void this.poll(), everyMs)
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.callbacks.onStatus('stopped', null)
  }

  private imapOptions(): ImapOptions {
    return {
      host: this.config.imapHost,
      port: this.config.imapPort,
      username: this.config.username,
      password: this.password,
    }
  }

  private async withMailbox<T>(run: (client: ImapClient) => Promise<T>): Promise<T> {
    const client = this.deps.imap?.(this.imapOptions()) ?? new ImapClient(this.imapOptions())
    try {
      await client.connect()
      await client.login()
      await client.select('INBOX')
      return await run(client)
    } finally {
      await client.logout()
    }
  }

  /** One inbox check. Public for tests and the "check now" button. */
  async poll(): Promise<number> {
    if (this.polling || this.stopped) return 0
    this.polling = true
    try {
      const delivered = await this.withMailbox(async (client) => {
        const last = this.deps.getLastUid()
        if (last === null) {
          // First run: start from "now" — never replay the whole mailbox.
          const all = await client.search('ALL')
          this.deps.setLastUid(all.length > 0 ? all[all.length - 1] : 0)
          return 0
        }
        const fresh = (await client.search(`UID ${last + 1}:*`)).filter((uid) => uid > last)
        let count = 0
        for (const uid of fresh.slice(0, MAX_PER_POLL)) {
          let raw: Buffer | null
          try {
            // Capped: a huge message (attachments) can neither stall the
            // reader nor time the poll out — the text part comes first.
            raw = await client.fetchRaw(uid, FETCH_MAX_BYTES)
          } catch (e) {
            // One message that keeps failing must not wedge the mailbox:
            // after a few tries it is skipped.
            const tries = (this.fetchFailures.get(uid) ?? 0) + 1
            this.fetchFailures.set(uid, tries)
            if (tries < MAX_FETCH_TRIES) throw e
            this.fetchFailures.delete(uid)
            this.deps.setLastUid(uid)
            continue
          }
          this.fetchFailures.delete(uid)
          this.deps.setLastUid(uid)
          if (!raw) continue
          this.emit(parseEmail(raw))
          count++
        }
        return count
      })
      this.callbacks.onStatus('running', null)
      return delivered
    } catch (e) {
      this.callbacks.onStatus('error', e instanceof Error ? e.message : String(e))
      return 0
    } finally {
      this.polling = false
    }
  }

  private emit(mail: ParsedEmail): void {
    const own = mail.from.address.toLowerCase()
    if (!own || own === this.config.address.toLowerCase()) return // our own sent mail
    // The receiving server says the From address is forged: never a turn,
    // however well it matches the sender allowlist.
    if (senderAuthFailed(mail.authenticationResults)) return
    const { own: instruction, quoted } = splitQuoted(mail.text.slice(0, BODY_MAX_CHARS))
    const attachmentNote =
      mail.attachments.length > 0 ? `\n[attachments: ${mail.attachments.join(', ')}]` : ''
    this.callbacks.onInbound({
      senderId: own,
      senderName: mail.from.name || own,
      text: `Subject: ${mail.subject || '(no subject)'}\n\n${instruction || '(no text)'}${attachmentNote}`,
      quoted: quoted || undefined,
      target: {
        to: own,
        toName: mail.from.name || null,
        subject: mail.subject,
        messageId: mail.messageId || null,
        references: [...mail.references, ...(mail.messageId ? [mail.messageId] : [])],
      },
      isDirect: true,
      mentionsBot: true,
      channelKey: own,
      label: 'Email',
    })
  }

  private smtpOptions(): SmtpOptions {
    return {
      host: this.config.smtpHost,
      port: this.config.smtpPort,
      security: this.config.smtpSecurity,
      username: this.config.username,
      password: this.password,
    }
  }

  private messageId(): string {
    const domain = this.config.address.split('@')[1] || 'grasberg.local'
    return `<${randomUUID()}@${domain}>`
  }

  /** Sends a fresh message or a threaded reply. */
  async sendMessage(input: {
    to: string[]
    subject: string
    text: string
    inReplyTo?: string | null
    references?: string[]
  }): Promise<void> {
    const recipients = input.to.map((value) => parseAddress(value))
    const invalid = input.to.filter((_value, index) => !recipients[index].address)
    if (invalid.length > 0) {
      throw new Error(`Not a valid email address: ${invalid.map((v) => JSON.stringify(v.slice(0, 80))).join(', ')}`)
    }
    if (recipients.length === 0) throw new Error('No valid recipient address.')
    const message = buildEmail({
      from: { name: this.config.displayName ?? '', address: this.config.address },
      to: recipients,
      subject: input.subject,
      text: input.text,
      inReplyTo: input.inReplyTo ?? null,
      references: input.references ?? [],
      messageId: this.messageId(),
    })
    const send = this.deps.smtp ?? sendMail
    await send(
      this.smtpOptions(),
      { from: this.config.address, to: recipients.map((r) => r.address) },
      message
    )
  }

  async send(target: ChannelTarget, text: string): Promise<void> {
    const to = typeof target.to === 'string' ? target.to : ''
    const references = Array.isArray(target.references) ? target.references : []
    await this.sendMessage({
      to: [target.toName ? `${String(target.toName)} <${to}>` : to],
      subject: replySubject(typeof target.subject === 'string' ? target.subject : ''),
      text,
      inReplyTo: typeof target.messageId === 'string' ? target.messageId : null,
      references,
    })
  }

  // -- the agent's mailbox tools ------------------------------------------------

  async listRecent(limit = 15, query?: string | null): Promise<EmailSummary[]> {
    return this.withMailbox(async (client) => {
      const criteria = query?.trim()
        ? `OR SUBJECT ${JSON.stringify(query.trim())} FROM ${JSON.stringify(query.trim())}`
        : 'ALL'
      const uids = (await client.search(criteria)).slice(-Math.min(Math.max(limit, 1), 50))
      const headers = await client.fetchHeaders(uids)
      return headers
        .map(({ uid, header }) => {
          const fields = parseHeaders(header.toString('utf8'))
          const from = parseAddress(fields.get('from')?.[0] ?? '')
          return {
            uid,
            from: from.name ? `${from.name} <${from.address}>` : from.address,
            subject: decodeEncodedWords(fields.get('subject')?.[0] ?? ''),
            date: fields.get('date')?.[0] ?? '',
          }
        })
        .sort((a, b) => b.uid - a.uid)
    })
  }

  async read(uid: number): Promise<ParsedEmail | null> {
    return this.withMailbox(async (client) => {
      const raw = await client.fetchRaw(uid, FETCH_MAX_BYTES)
      return raw ? parseEmail(raw) : null
    })
  }
}
