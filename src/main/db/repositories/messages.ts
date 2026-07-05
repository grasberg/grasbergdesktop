/**
 * Message persistence. Callers generate message ids (crypto.randomUUID) and
 * pass full `Message` objects to `insert`.
 */

import type {
  Attachment,
  Message,
  MessageRole,
  MessageStatus,
  NormalizedError,
  TokenUsage,
  ToolCallRecord,
} from '@shared/types'
import type { SqliteDriver } from '../driver'
import { parseJson, updateById } from './util'

export interface MessagePatch {
  content?: string
  /** null clears the column. */
  reasoning?: string | null
  status?: MessageStatus
  error?: NormalizedError | null
  usage?: TokenUsage | null
  toolCalls?: ToolCallRecord[] | null
}

export interface MessagesRepository {
  listByConversation(conversationId: string): Message[]
  insert(message: Message): void
  /** Returns the updated message, or null when id is unknown. */
  update(id: string, patch: MessagePatch): Message | null
  deleteById(id: string): void
  /** Deletes messages with seq strictly greater than `seq`. Returns count. */
  deleteAfterSeq(conversationId: string, seq: number): number
  /** Next monotonic seq for the conversation (1-based). */
  nextSeq(conversationId: string): number
  /**
   * Marks any message still in status 'streaming' as 'stopped' — recovery for
   * generations interrupted by a crash/quit. Called at app boot. Returns the
   * number of messages fixed.
   */
  markDanglingStreamingAsStopped(): number
}

interface MessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  reasoning: string | null
  attachments_json: string | null
  tool_calls_json: string | null
  status: string
  error_json: string | null
  provider_id: string | null
  model_id: string | null
  usage_json: string | null
  seq: number
  created_at: number
}

function parseJsonColumn<T>(text: string | null): T | undefined {
  return parseJson<T | undefined>(text, undefined)
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as MessageRole,
    content: row.content,
    reasoning: row.reasoning ?? undefined,
    attachments: parseJsonColumn<Attachment[]>(row.attachments_json),
    toolCalls: parseJsonColumn<ToolCallRecord[]>(row.tool_calls_json),
    status: row.status as MessageStatus,
    error: parseJsonColumn<NormalizedError>(row.error_json),
    providerId: row.provider_id ?? undefined,
    modelId: row.model_id ?? undefined,
    usage: parseJsonColumn<TokenUsage>(row.usage_json),
    seq: row.seq,
    createdAt: row.created_at,
  }
}

export function createMessagesRepository(driver: SqliteDriver): MessagesRepository {
  const getById = (id: string): Message | null => {
    const row = driver.get<MessageRow>('SELECT * FROM messages WHERE id = ?', [id])
    return row ? toMessage(row) : null
  }

  return {
    listByConversation(conversationId) {
      const rows = driver.all<MessageRow>(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC',
        [conversationId]
      )
      return rows.map(toMessage)
    },

    insert(message) {
      driver.run(
        `INSERT INTO messages
           (id, conversation_id, role, content, reasoning, attachments_json,
            tool_calls_json, status, error_json, provider_id, model_id,
            usage_json, seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          message.id,
          message.conversationId,
          message.role,
          message.content,
          message.reasoning ?? null,
          message.attachments ? JSON.stringify(message.attachments) : null,
          message.toolCalls ? JSON.stringify(message.toolCalls) : null,
          message.status,
          message.error ? JSON.stringify(message.error) : null,
          message.providerId ?? null,
          message.modelId ?? null,
          message.usage ? JSON.stringify(message.usage) : null,
          message.seq,
          message.createdAt,
        ]
      )
    },

    update(id, patch) {
      // messages has no updated_at column, so no touch.
      updateById(driver, 'messages', id, {
        content: patch.content,
        reasoning: patch.reasoning,
        status: patch.status,
        error_json: patch.error == null ? patch.error : JSON.stringify(patch.error),
        usage_json: patch.usage == null ? patch.usage : JSON.stringify(patch.usage),
        tool_calls_json: patch.toolCalls == null ? patch.toolCalls : JSON.stringify(patch.toolCalls),
      })
      return getById(id)
    },

    deleteById(id) {
      driver.run('DELETE FROM messages WHERE id = ?', [id])
    },

    deleteAfterSeq(conversationId, seq) {
      const result = driver.run(
        'DELETE FROM messages WHERE conversation_id = ? AND seq > ?',
        [conversationId, seq]
      )
      return result.changes
    },

    nextSeq(conversationId) {
      const row = driver.get<{ next: number }>(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?',
        [conversationId]
      )
      return row ? row.next : 1
    },

    markDanglingStreamingAsStopped() {
      const result = driver.run(
        "UPDATE messages SET status = 'stopped' WHERE status = 'streaming'"
      )
      return result.changes
    },
  }
}
