/**
 * Just enough RFC 5322 / MIME for an agent's mailbox (v53): parse an inbound
 * message into sender, subject, threading headers and its best plain-text
 * body; build a UTF-8 plain-text reply. No attachments are decoded — an
 * agent reads text; anything else is summarized as "[attachment: name]".
 */

export interface EmailAddress {
  name: string
  address: string
}

export interface ParsedEmail {
  /** Sender; `address` is '' when the From header is not exactly one valid address. */
  from: EmailAddress
  to: string
  subject: string
  date: string
  messageId: string
  inReplyTo: string
  references: string[]
  text: string
  attachments: string[]
  /** The topmost Authentication-Results header (the receiving server's verdict), or ''. */
  authenticationResults: string
}

/** Headers as lowercased name → raw (unfolded) values. */
export function parseHeaders(block: string): Map<string, string[]> {
  const headers = new Map<string, string[]>()
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    const list = headers.get(name) ?? []
    list.push(value)
    headers.set(name, list)
  }
  return headers
}

function decodeBytes(bytes: Buffer, charset: string): string {
  const label = charset.trim().toLowerCase() || 'utf-8'
  try {
    return new TextDecoder(label).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function decodeQuotedPrintable(input: string, header = false): Buffer {
  const text = header ? input.replace(/_/g, ' ') : input.replace(/=\r?\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      const code = text.charCodeAt(i)
      if (code < 128) bytes.push(code)
      else bytes.push(...Buffer.from(ch, 'utf8'))
    }
  }
  return Buffer.from(bytes)
}

/** RFC 2047 encoded-words: =?charset?B|Q?text?= (adjacent words join without space). */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, charset: string, enc: string, text: string) => {
      try {
        const bytes =
          enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : decodeQuotedPrintable(text, true)
        return decodeBytes(bytes, charset.split('*')[0])
      } catch {
        return text
      }
    })
}

// One addr-spec: no whitespace, control characters, brackets, quotes, commas
// or a second "@" anywhere — so an address can never smuggle an SMTP command
// (CRLF) or a second recipient.
// eslint-disable-next-line no-control-regex
const ADDRESS_CHARS = '[^\\s\\x00-\\x1f\\x7f<>()\\[\\]\\\\,;:"@]'
const ADDRESS_RE = new RegExp(`^${ADDRESS_CHARS}+@${ADDRESS_CHARS}+$`)

/** True for exactly one plain, safe email address. */
export function isValidAddress(address: string): boolean {
  return ADDRESS_RE.test(address) && !address.endsWith('.') && !address.includes('..')
}

/**
 * One address from a header value. The ADDRESS is always taken from the raw,
 * undecoded header — RFC 2047 encoded-words never appear inside an addr-spec,
 * and decoding first would let a display name like
 * `=?utf-8?Q?owner=40company.com?= <attacker@evil.com>` pose as the owner.
 * Only the display name is decoded. Anything that is not exactly one valid
 * address yields address ''.
 */
export function parseAddress(value: string): EmailAddress {
  const raw = value.trim()
  const angle = raw.match(/^(.*)<([^<>]*)>\s*$/)
  if (angle) {
    const address = angle[2].trim().toLowerCase()
    return {
      name: decodeEncodedWords(angle[1]).replace(/^\s*"|"\s*$/g, '').trim(),
      address: isValidAddress(address) ? address : '',
    }
  }
  // "user@host" or "user@host (Comment)" — and nothing else.
  const bare = raw.match(/^([^\s<>"()]+)(?:\s*\(([^()]*)\))?$/)
  const address = bare ? bare[1].toLowerCase() : ''
  return {
    name: bare?.[2] ? decodeEncodedWords(bare[2]).trim() : '',
    address: isValidAddress(address) ? address : '',
  }
}

/**
 * The receiving server's sender-authentication verdict (topmost
 * Authentication-Results): true when DMARC failed, or SPF hard-failed with
 * no passing DKIM signature — i.e. the From address is likely forged. No
 * header (local bridges, tests) is not a failure.
 */
export function senderAuthFailed(authenticationResults: string): boolean {
  const value = authenticationResults.toLowerCase()
  if (!value) return false
  if (/\bdmarc=fail\b/.test(value)) return true
  return /\bspf=fail\b/.test(value) && !/\bdkim=pass\b/.test(value)
}

/** Message-id tokens only ("<…>"), so a header value can never carry a line break. */
function messageIdTokens(value: string): string[] {
  return value.match(/<[^<>\s]+>/g) ?? []
}

/** Parameter of a structured header, e.g. boundary / charset / name. */
function headerParam(value: string, param: string): string {
  const match = value.match(new RegExp(`${param}\\*?=(?:"([^"]*)"|([^;\\s]+))`, 'i'))
  return match ? (match[1] ?? match[2] ?? '') : ''
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

interface Part {
  headers: Map<string, string[]>
  body: Buffer
}

function splitPart(raw: Buffer): Part {
  const text = raw.toString('latin1')
  const match = text.match(/\r?\n\r?\n/)
  if (!match || match.index === undefined) return { headers: parseHeaders(text), body: Buffer.alloc(0) }
  const headerEnd = match.index
  return {
    headers: parseHeaders(text.slice(0, headerEnd)),
    body: raw.subarray(headerEnd + match[0].length),
  }
}

function decodeBody(part: Part): string {
  const contentType = part.headers.get('content-type')?.[0] ?? 'text/plain'
  const encoding = (part.headers.get('content-transfer-encoding')?.[0] ?? '').toLowerCase()
  const charset = headerParam(contentType, 'charset') || 'utf-8'
  let bytes: Buffer = part.body
  if (encoding.includes('base64')) bytes = Buffer.from(part.body.toString('latin1').replace(/\s+/g, ''), 'base64')
  else if (encoding.includes('quoted-printable')) bytes = decodeQuotedPrintable(part.body.toString('latin1'))
  return decodeBytes(bytes, charset)
}

/** Walks a (possibly multipart) entity; returns best text and attachment names. */
function walk(part: Part, out: { plain: string[]; html: string[]; attachments: string[] }, depth = 0): void {
  if (depth > 8) return
  const contentType = part.headers.get('content-type')?.[0] ?? 'text/plain'
  const type = contentType.split(';')[0].trim().toLowerCase()
  const disposition = part.headers.get('content-disposition')?.[0] ?? ''
  if (type.startsWith('multipart/')) {
    const boundary = headerParam(contentType, 'boundary')
    if (!boundary) return
    const text = part.body.toString('latin1')
    const delimiter = `--${boundary}`
    const pieces = text.split(delimiter).slice(1)
    for (const piece of pieces) {
      if (piece.startsWith('--')) break
      walk(splitPart(Buffer.from(piece.replace(/^\r?\n/, ''), 'latin1')), out, depth + 1)
    }
    return
  }
  const filename = decodeEncodedWords(headerParam(disposition, 'filename') || headerParam(contentType, 'name'))
  if (/attachment/i.test(disposition) || (filename && !type.startsWith('text/'))) {
    out.attachments.push(filename || type)
    return
  }
  if (type === 'text/plain') out.plain.push(decodeBody(part))
  else if (type === 'text/html') out.html.push(decodeBody(part))
  else if (type === 'message/rfc822') walk(splitPart(part.body), out, depth + 1)
}

export function parseEmail(raw: Buffer): ParsedEmail {
  const root = splitPart(raw)
  const out = { plain: [] as string[], html: [] as string[], attachments: [] as string[] }
  walk(root, out)
  const header = (name: string): string => decodeEncodedWords(root.headers.get(name)?.[0] ?? '')
  const refs = (root.headers.get('references')?.[0] ?? '').match(/<[^>]+>/g) ?? []
  const text = out.plain.length > 0 ? out.plain.join('\n\n') : htmlToText(out.html.join('\n'))
  return {
    from: parseAddress(root.headers.get('from')?.[0] ?? ''),
    to: header('to'),
    subject: header('subject'),
    date: header('date'),
    messageId: (root.headers.get('message-id')?.[0] ?? '').trim(),
    inReplyTo: (root.headers.get('in-reply-to')?.[0] ?? '').trim(),
    references: refs,
    text: text.replace(/\r\n/g, '\n').trim(),
    attachments: out.attachments,
    authenticationResults: root.headers.get('authentication-results')?.[0] ?? '',
  }
}

/**
 * Splits the sender's own words from quoted / forwarded material: the first
 * line that starts a quote block ("On … wrote:", "-----Original Message",
 * "Forwarded message", a run of "> " lines) ends the instruction part.
 */
export function splitQuoted(text: string): { own: string; quoted: string } {
  const lines = text.split('\n')
  const markers = [
    /^On .{3,200}wrote:\s*$/i,
    /^Den .{3,200}skrev:\s*$/i,
    /^-{2,}\s*(Original Message|Forwarded message|Ursprungligt meddelande|Vidarebefordrat meddelande)/i,
    /^Begin forwarded message:/i,
    /^From:\s.+/i,
    /^Från:\s.+/i,
  ]
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const quoteRun = line.startsWith('>') && (lines[i + 1] ?? '').trim().startsWith('>')
    if (quoteRun || markers.some((re) => re.test(line))) {
      return { own: lines.slice(0, i).join('\n').trim(), quoted: lines.slice(i).join('\n').trim() }
    }
  }
  return { own: text.trim(), quoted: '' }
}

function encodeHeaderWord(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function formatAddress(address: EmailAddress): string {
  if (!address.name) return address.address
  const name = address.name.replace(/[\r\n]+/g, ' ')
  // Specials in a plain-ASCII name must be quoted, or the name could read as
  // extra addresses in the header.
  const shown = /^[\x20-\x7e]*$/.test(name) && /[()<>[\]:;@\\,."]/.test(name)
    ? `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : encodeHeaderWord(name)
  return `${shown} <${address.address}>`
}

/** A UTF-8 plain-text message, base64 body, CRLF line endings. */
export function buildEmail(input: {
  from: EmailAddress
  to: EmailAddress[]
  subject: string
  text: string
  inReplyTo?: string | null
  references?: string[]
  messageId: string
  date?: Date
}): string {
  const body = Buffer.from(input.text.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n')
  const inReplyTo = messageIdTokens(input.inReplyTo ?? '')[0] ?? null
  const references = (input.references ?? []).flatMap(messageIdTokens).slice(-20)
  const headers = [
    `From: ${formatAddress(input.from)}`,
    `To: ${input.to.map(formatAddress).join(', ')}`,
    `Subject: ${encodeHeaderWord(input.subject.replace(/[\r\n]+/g, ' '))}`,
    `Date: ${(input.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${input.messageId}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references.length > 0 ? [`References: ${references.join(' ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'X-Mailer: Grasberg',
  ]
  return `${headers.join('\r\n')}\r\n\r\n${body}`
}

/** "Re: subject" without stacking prefixes. */
export function replySubject(subject: string): string {
  return /^(re|sv|aw):/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim() || '(no subject)'}`
}
