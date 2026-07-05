/**
 * Conversation CRUD + sidebar listing (with search and snippets).
 */

import { randomUUID } from 'node:crypto'
import type { ConvListRequest, ConvUpdateRequest } from '@shared/ipc'
import type {
  ChatParams,
  Conversation,
  ConversationMode,
  ConversationSummary,
} from '@shared/types'
import type { SqliteDriver, SqlValue } from '../driver'
import { parseJson, updateById } from './util'

export type ConversationListRequest = ConvListRequest

export interface ConversationCreateInput {
  mode: ConversationMode
  title?: string
  providerId?: string | null
  modelId?: string | null
  systemPrompt?: string | null
  workspaceId?: string | null
  projectId?: string | null
}

export type ConversationPatch = ConvUpdateRequest['patch']

export interface ConversationsRepository {
  list(req?: ConversationListRequest): ConversationSummary[]
  /** Generates the id (crypto.randomUUID) and timestamps. */
  create(input: ConversationCreateInput): Conversation
  getById(id: string): Conversation | null
  /** Returns the updated row (updated_at bumped), or null when id is unknown. */
  update(id: string, patch: ConversationPatch): Conversation | null
  remove(id: string): void
  touch(id: string, updatedAtMs: number): void
  /** Null out provider_id/model_id on every conversation that referenced a deleted provider. */
  clearProvider(providerId: string): void
  /** Persist the context-compaction summary (internal; not exposed via convUpdate). */
  setSummary(id: string, summaryText: string, throughSeq: number): void
}

interface ConversationRow {
  id: string
  mode: string
  title: string
  provider_id: string | null
  model_id: string | null
  system_prompt: string | null
  params_json: string
  workspace_id: string | null
  project_id: string | null
  summary_text: string | null
  summary_through_seq: number | null
  created_at: number
  updated_at: number
}

interface SummaryRow {
  id: string
  mode: string
  title: string
  updated_at: number
  snippet: string | null
}

function parseParams(text: string | null): ChatParams {
  return parseJson<ChatParams>(
    text,
    {},
    (value): value is ChatParams => typeof value === 'object' && value !== null
  )
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    mode: row.mode as ConversationMode,
    title: row.title,
    providerId: row.provider_id,
    modelId: row.model_id,
    systemPrompt: row.system_prompt,
    params: parseParams(row.params_json),
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    summaryText: row.summary_text,
    summaryThroughSeq: row.summary_through_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Escape LIKE wildcards so user input matches literally (used with ESCAPE '\'). */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

function toSnippet(content: string | null): string | null {
  if (content === null) return null
  return content.replace(/\s+/g, ' ').trim().slice(0, 100)
}

export function createConversationsRepository(driver: SqliteDriver): ConversationsRepository {
  const getById = (id: string): Conversation | null => {
    const row = driver.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [id])
    return row ? toConversation(row) : null
  }

  return {
    list(req = {}) {
      const where: string[] = []
      const params: SqlValue[] = []
      if (req.mode) {
        where.push('c.mode = ?')
        params.push(req.mode)
      }
      const search = req.search?.trim()
      if (search) {
        // Lowercase both the needle (in JS, so non-ASCII folds too) and the
        // columns (via LOWER) so search is case-insensitive beyond ASCII, which
        // SQLite's default LIKE does not handle. Wildcard escaping is preserved.
        const pattern = `%${escapeLike(search.toLowerCase())}%`
        where.push(
          `(LOWER(c.title) LIKE ? ESCAPE '\\' OR EXISTS (
             SELECT 1 FROM messages m
             WHERE m.conversation_id = c.id AND LOWER(m.content) LIKE ? ESCAPE '\\'))`
        )
        params.push(pattern, pattern)
      }
      let limitClause = ''
      if (req.limit !== undefined) {
        limitClause = 'LIMIT ?'
        params.push(Math.max(1, Math.floor(req.limit)))
      }
      const rows = driver.all<SummaryRow>(
        `SELECT c.id, c.mode, c.title, c.updated_at,
           (SELECT m2.content FROM messages m2
            WHERE m2.conversation_id = c.id
              AND m2.status <> 'streaming'
              AND TRIM(m2.content) <> ''
            ORDER BY m2.seq DESC LIMIT 1) AS snippet
         FROM conversations c
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY c.updated_at DESC
         ${limitClause}`,
        params
      )
      return rows.map((row) => ({
        id: row.id,
        mode: row.mode as ConversationMode,
        title: row.title,
        updatedAt: row.updated_at,
        snippet: toSnippet(row.snippet),
      }))
    },

    create(input) {
      const now = Date.now()
      const conversation: Conversation = {
        id: randomUUID(),
        mode: input.mode,
        title: input.title ?? 'New chat',
        providerId: input.providerId ?? null,
        modelId: input.modelId ?? null,
        systemPrompt: input.systemPrompt ?? null,
        params: {},
        workspaceId: input.workspaceId ?? null,
        projectId: input.projectId ?? null,
        createdAt: now,
        updatedAt: now,
      }
      driver.run(
        `INSERT INTO conversations
           (id, mode, title, provider_id, model_id, system_prompt, params_json,
            workspace_id, project_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          conversation.id,
          conversation.mode,
          conversation.title,
          conversation.providerId,
          conversation.modelId,
          conversation.systemPrompt,
          JSON.stringify(conversation.params),
          conversation.workspaceId,
          conversation.projectId,
          conversation.createdAt,
          conversation.updatedAt,
        ]
      )
      return conversation
    },

    getById,

    update(id, patch) {
      updateById(
        driver,
        'conversations',
        id,
        {
          title: patch.title,
          provider_id: patch.providerId,
          model_id: patch.modelId,
          system_prompt: patch.systemPrompt,
          params_json: patch.params === undefined ? undefined : JSON.stringify(patch.params),
          workspace_id: patch.workspaceId,
          project_id: patch.projectId,
        },
        { touchUpdatedAt: true }
      )
      return getById(id)
    },

    remove(id) {
      // Messages cascade via FK.
      driver.run('DELETE FROM conversations WHERE id = ?', [id])
    },

    touch(id, updatedAtMs) {
      driver.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [updatedAtMs, id])
    },

    clearProvider(providerId) {
      driver.run(
        'UPDATE conversations SET provider_id = NULL, model_id = NULL WHERE provider_id = ?',
        [providerId]
      )
    },

    setSummary(id, summaryText, throughSeq) {
      driver.run(
        'UPDATE conversations SET summary_text = ?, summary_through_seq = ? WHERE id = ?',
        [summaryText, throughSeq, id]
      )
    },
  }
}
