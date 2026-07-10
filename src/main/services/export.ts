/**
 * Conversation export serializers (pure — no Electron, easily unit-tested).
 * The IPC handler picks a path via a save dialog and writes the returned text.
 */

import type { Conversation, Message } from '@shared/types'

const ROLE_HEADING: Record<Message['role'], string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  tool: 'Tool',
}

function isoDate(ms: number): string {
  // Main process; Date is available here (unlike workflow scripts).
  return new Date(ms).toISOString()
}

/** Human-readable Markdown transcript. */
export function toMarkdown(conversation: Conversation, messages: Message[]): string {
  const out: string[] = []
  out.push(`# ${conversation.title || 'Conversation'}`)
  out.push('')
  const meta: string[] = [
    `- Mode: ${conversation.mode}`,
    `- Created: ${isoDate(conversation.createdAt)}`,
    `- Messages: ${messages.length}`,
  ]
  if (conversation.modelId) meta.push(`- Model: ${conversation.modelId}`)
  if (conversation.summaryText && conversation.summaryText.trim().length > 0) {
    meta.push('- Note: earlier messages were condensed to save context (not all turns shown).')
  }
  out.push(...meta)
  out.push('')

  for (const message of messages) {
    // System messages are app scaffolding; skip empty ones.
    if (message.role === 'system' && message.content.trim().length === 0) continue
    out.push('---')
    out.push('')
    out.push(`## ${ROLE_HEADING[message.role]}`)
    out.push('')
    if (message.reasoning && message.reasoning.trim().length > 0) {
      out.push('<details><summary>Reasoning</summary>')
      out.push('')
      out.push(message.reasoning.trim())
      out.push('')
      out.push('</details>')
      out.push('')
    }
    if (message.content.trim().length > 0) {
      out.push(message.content.trim())
      out.push('')
    }
    // Generated images live on disk (storageKey), so the transcript carries an
    // honest text reference rather than a broken inline image link.
    for (const attachment of message.attachments ?? []) {
      if (message.role === 'assistant' && attachment.kind === 'image' && attachment.generatedBy) {
        const size = attachment.generatedBy.size ? `, ${attachment.generatedBy.size}` : ''
        out.push(
          `> **Generated image:** ${attachment.name} (${attachment.generatedBy.modelId}${size})`
        )
        out.push('')
      }
    }
    for (const call of message.toolCalls ?? []) {
      out.push(`> **Tool call:** \`${call.name}\` (${call.status})`)
      out.push('')
      out.push('```json')
      out.push(call.arguments || '{}')
      out.push('```')
      if (call.result) {
        out.push('')
        out.push('```')
        out.push(call.result)
        out.push('```')
      }
      out.push('')
    }
  }
  return `${out.join('\n').trimEnd()}\n`
}

/** Machine-readable JSON (conversation + messages verbatim). */
export function toJson(conversation: Conversation, messages: Message[]): string {
  return `${JSON.stringify({ conversation, messages }, null, 2)}\n`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Compact Markdown -> HTML for document export (headings, bold/italic, inline
 * and fenced code, links, simple lists, paragraphs). Not a full CommonMark
 * implementation — enough to produce a clean, self-contained page.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inCode = false
  let inList = false
  const closeList = (): void => {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }
  const inline = (s: string): string =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        out.push('</code></pre>')
        inCode = false
      } else {
        closeList()
        out.push('<pre><code>')
        inCode = true
      }
      continue
    }
    if (inCode) {
      out.push(escapeHtml(line))
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`)
      continue
    }
    closeList()
    if (line.trim().length === 0) continue
    out.push(`<p>${inline(line)}</p>`)
  }
  if (inCode) out.push('</code></pre>')
  closeList()
  return out.join('\n')
}

/** Wraps document content into a self-contained HTML page for export. */
export function documentToHtml(title: string, kind: 'doc' | 'html', content: string): string {
  if (kind === 'html') return content // already a full HTML document
  const body = markdownToHtml(content)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height: 1.6;
    max-width: 760px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
  pre { background: #f5f5f5; padding: 12px; border-radius: 6px; overflow-x: auto; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1,h2,h3 { line-height: 1.25; }
  a { color: #3b5bdb; }
</style>
</head>
<body>
${body}
</body>
</html>
`
}

/** A filesystem-safe base filename derived from the conversation title. */
export function exportFileBase(conversation: Conversation): string {
  const safe = (conversation.title || 'conversation')
    .replace(/[^\w\-. ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
  return safe.length > 0 ? safe : 'conversation'
}
