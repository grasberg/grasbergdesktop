/**
 * Feedback → learning (v53, dots "learns from feedback over time"). A thumbs
 * up/down with an optional comment on an assistant message is stored in
 * `message_feedback` and — when memory is on — distilled into a memory owned
 * by the agent that wrote the message (or the shared pool for ordinary
 * chats). Dreaming later consolidates these into durable preferences, so the
 * agent's next prompt carries what the user liked and disliked.
 *
 * Deterministic on purpose: no model call sits between a click and the
 * memory, and a plain thumbs-up without a comment records the rating only
 * (praise without content would just bloat the prompt).
 */

import type { MessageFeedback } from '@shared/types'
import type { AppDatabase } from '../db/database'

const EXCERPT_MAX = 280

interface Row {
  message_id: string
  conversation_id: string
  agent_id: string | null
  rating: number
  comment: string
  created_at: number
}

function toFeedback(row: Row): MessageFeedback {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    rating: row.rating > 0 ? 1 : -1,
    comment: row.comment,
    createdAt: row.created_at,
  }
}

export function listFeedback(db: AppDatabase, conversationId: string): MessageFeedback[] {
  return db.driver
    .all<Row>('SELECT * FROM message_feedback WHERE conversation_id = ?', [conversationId])
    .map(toFeedback)
}

/** Records (or replaces) feedback on one assistant message; rating 0 clears it. */
export function recordFeedback(
  db: AppDatabase,
  input: { messageId: string; rating: 1 | -1 | 0; comment?: string }
): MessageFeedback | null {
  const message = db.messages.getById(input.messageId)
  if (!message || message.role !== 'assistant') {
    throw new Error('Feedback can only be given on an assistant reply.')
  }
  if (input.rating === 0) {
    db.driver.run('DELETE FROM message_feedback WHERE message_id = ?', [input.messageId])
    return null
  }
  const conversation = db.conversations.getById(message.conversationId)
  // Attribute to the bot that actually wrote it (a room message carries its
  // own agent_id), else the conversation's bot, else the shared pool.
  const agentId = message.agentId ?? conversation?.agentId ?? null
  const comment = (input.comment ?? '').trim().slice(0, 1000)
  const now = Date.now()
  db.driver.run(
    `INSERT INTO message_feedback (message_id, conversation_id, agent_id, rating, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment,
       created_at = excluded.created_at`,
    [input.messageId, message.conversationId, agentId, input.rating, comment, now]
  )
  if (db.settings.get().memoryEnabled && (comment || input.rating < 0)) {
    const excerpt = message.content.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX)
    const verdict = input.rating > 0 ? 'liked' : 'did NOT like'
    const date = new Date(now).toISOString().slice(0, 10)
    db.memories.upsertByTitle({
      title: `Feedback ${date} ${input.messageId.slice(0, 8)}`,
      content:
        `The user ${verdict} a reply${comment ? ` and said: "${comment}"` : ''}.\n` +
        `Reply excerpt: "${excerpt}${message.content.length > EXCERPT_MAX ? '…' : ''}"\n` +
        (input.rating > 0
          ? 'Keep doing what made this reply work.'
          : 'Avoid repeating what made this reply miss.'),
      sourceConversationId: message.conversationId,
      agentId,
    })
  }
  return toFeedback(
    db.driver.get<Row>('SELECT * FROM message_feedback WHERE message_id = ?', [input.messageId])!
  )
}
