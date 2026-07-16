/**
 * Message persistence. Callers generate message ids (crypto.randomUUID) and
 * pass full `Message` objects to `insert`.
 */

import type {
  Attachment,
  Message,
  MessageRole,
  MessageStatus,
  MoaReferenceOutput,
  NormalizedError,
  ResearchRunInfo,
  TokenUsage,
  ToolCallRecord,
} from '@shared/types'
import type { SqliteDriver } from '../driver'
import { parseJson, updateById } from './util'

export interface MessagePatch {
  content?: string
  /** null clears the column. */
  reasoning?: string | null
  /** Generated-image attachments on an assistant message; null clears. */
  attachments?: Attachment[] | null
  status?: MessageStatus
  error?: NormalizedError | null
  usage?: TokenUsage | null
  toolCalls?: ToolCallRecord[] | null
  /** null clears the column. */
  moaReferences?: MoaReferenceOutput[] | null
  /** Compare-run marker/winner; null clears the column. */
  compare?: Message['compare'] | null
  /** Deep-research run info; null clears the column. */
  research?: ResearchRunInfo | null
  /** Re-attribute the message (compare winner pick). */
  providerId?: string
  modelId?: string
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
  /** Highest seq in the conversation, or null when it has no messages. */
  lastSeq(conversationId: string): number | null
  /**
   * Marks any message still in status 'streaming' as 'stopped' — recovery for
   * generations interrupted by a crash/quit. Called at app boot. Returns the
   * number of messages fixed.
   */
  markDanglingStreamingAsStopped(): number
  /** Assistant messages' usage since `sinceMs` (for the local usage summary). */
  usageSince(
    sinceMs: number
  ): Array<{ providerId: string; modelId: string; usage: TokenUsage }>
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
  moa_references_json: string | null
  compare_json: string | null
  research_json: string | null
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
    moaReferences: parseJsonColumn<MoaReferenceOutput[]>(row.moa_references_json),
    compare: parseJsonColumn<Message['compare']>(row.compare_json),
    research: parseJsonColumn<ResearchRunInfo>(row.research_json),
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
    usageSince(sinceMs) {
      const rows = driver.all<Pick<MessageRow, 'provider_id' | 'model_id' | 'usage_json'>>(
        `SELECT provider_id, model_id, usage_json FROM messages
          WHERE role = 'assistant' AND usage_json IS NOT NULL AND created_at >= ?`,
        [sinceMs]
      )
      const result: Array<{ providerId: string; modelId: string; usage: TokenUsage }> = []
      for (const row of rows) {
        const usage = parseJsonColumn<TokenUsage>(row.usage_json)
        if (!usage || !row.provider_id || !row.model_id) continue
        result.push({ providerId: row.provider_id, modelId: row.model_id, usage })
      }
      return result
    },

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
            usage_json, moa_references_json, compare_json, research_json, seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          message.moaReferences ? JSON.stringify(message.moaReferences) : null,
          message.compare ? JSON.stringify(message.compare) : null,
          message.research ? JSON.stringify(message.research) : null,
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
        attachments_json:
          patch.attachments == null ? patch.attachments : JSON.stringify(patch.attachments),
        status: patch.status,
        error_json: patch.error == null ? patch.error : JSON.stringify(patch.error),
        usage_json: patch.usage == null ? patch.usage : JSON.stringify(patch.usage),
        tool_calls_json: patch.toolCalls == null ? patch.toolCalls : JSON.stringify(patch.toolCalls),
        moa_references_json:
          patch.moaReferences == null ? patch.moaReferences : JSON.stringify(patch.moaReferences),
        compare_json: patch.compare == null ? patch.compare : JSON.stringify(patch.compare),
        research_json: patch.research == null ? patch.research : JSON.stringify(patch.research),
        provider_id: patch.providerId,
        model_id: patch.modelId,
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

    lastSeq(conversationId) {
      const row = driver.get<{ seq: number | null }>(
        'SELECT MAX(seq) AS seq FROM messages WHERE conversation_id = ?',
        [conversationId]
      )
      return row?.seq ?? null
    },

    markDanglingStreamingAsStopped() {
      const result = driver.run(
        "UPDATE messages SET status = 'stopped' WHERE status = 'streaming'"
      )
      return result.changes
    },
  }
}
