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

/** A filesystem-safe base filename derived from the conversation title. */
export function exportFileBase(conversation: Conversation): string {
  const safe = (conversation.title || 'conversation')
    .replace(/[^\w\-. ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
  return safe.length > 0 ? safe : 'conversation'
}
