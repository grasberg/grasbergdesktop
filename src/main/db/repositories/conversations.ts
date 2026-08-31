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
import { parseJson, toSearchGlob, updateById } from './util'

export type ConversationListRequest = ConvListRequest

export interface ConversationCreateInput {
  mode: ConversationMode
  title?: string
  providerId?: string | null
  modelId?: string | null
  systemPrompt?: string | null
  workspaceId?: string | null
  projectId?: string | null
  projectRef?: string | null
  moaPresetId?: string | null
  knowledgeBaseId?: string | null
  /**
   * Preserve this id instead of generating one — backup import only, so a
   * re-imported conversation is recognized (and skipped) by its original id.
   * Never accepted over IPC (the convCreate schema has no id field).
   */
  id?: string
  /**
   * Fork provenance — set only by the conv:fork handler; never accepted over
   * IPC (the convCreate schema has no such fields).
   */
  parentConversationId?: string | null
  forkedAtMessageId?: string | null
  /** Private space (v45); null/absent = the default space. */
  spaceId?: string | null
  /**
   * Bot Mode (v46): the agent profile owning this conversation (canonical bot
   * chat). Repository-only — set by the bot service, never accepted over IPC.
   */
  agentId?: string | null
}

export type ConversationPatch = ConvUpdateRequest['patch']

export interface ConversationsRepository {
  /**
   * Default-space rows only unless `spaceId` names a private space —
   * the safe default: a caller that doesn't know about spaces can never
   * leak a private conversation. `allSpaces` is repository-only (never
   * accepted over IPC); backup export with the include flag is its caller.
   */
  list(
    req?: ConversationListRequest & { allSpaces?: boolean; includeBots?: boolean }
  ): ConversationSummary[]
  /** Generates the id (crypto.randomUUID) and timestamps. */
  create(input: ConversationCreateInput): Conversation
  getById(id: string): Conversation | null
  /** Returns the updated row (updated_at bumped), or null when id is unknown. */
  update(id: string, patch: ConversationPatch): Conversation | null
  remove(id: string): void
  /** Deletes every conversation (messages + documents cascade via FK). */
  deleteAll(): void
  touch(id: string, updatedAtMs: number): void
  /** Null out provider_id/model_id on every conversation that referenced a deleted provider. */
  clearProvider(providerId: string): void
  /** Detach a deleted knowledge base from every conversation that used it. */
  clearKnowledgeBase(knowledgeBaseId: string): void
  /** Persist the context-compaction summary (internal; not exposed via convUpdate). */
  setSummary(id: string, summaryText: string, throughSeq: number): void
  /** Drop the compaction summary — the history it covered no longer exists. */
  clearSummary(id: string): void
  /** Forks of a conversation (sibling lookup for the backlink chip), oldest first. */
  listForks(parentId: string): Array<{ id: string; title: string; createdAt: number }>
  /** Ids of every conversation living in a private space (exclusion filters). */
  listPrivateSpaceConversationIds(): string[]
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
  project_ref: string | null
  moa_preset_id: string | null
  knowledge_base_id: string | null
  summary_text: string | null
  summary_through_seq: number | null
  parent_conversation_id: string | null
  forked_at_message_id: string | null
  budget_usd: number | null
  space_id: string | null
  agent_id: string | null
  created_at: number
  updated_at: number
}

interface SummaryRow {
  id: string
  mode: string
  title: string
  updated_at: number
  project_ref: string | null
  space_id: string | null
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
    projectRef: row.project_ref,
    moaPresetId: row.moa_preset_id,
    knowledgeBaseId: row.knowledge_base_id,
    summaryText: row.summary_text,
    summaryThroughSeq: row.summary_through_seq,
    parentConversationId: row.parent_conversation_id,
    forkedAtMessageId: row.forked_at_message_id,
    budgetUsd: row.budget_usd ?? null,
    spaceId: row.space_id,
    agentId: row.agent_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
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
      // Space scoping FIRST so the search clause (and its snippet subquery)
      // can never match across spaces.
      if (!req.allSpaces) {
        if (req.spaceId) {
          where.push('c.space_id = ?')
          params.push(req.spaceId)
        } else {
          where.push('c.space_id IS NULL')
        }
      }
      // Bot-owned conversations (canonical bot chats + group-room transcripts)
      // live in the Bots pane, not the regular sidebar. Backup export opts back
      // in with includeBots so they are never lost from an exported backup.
      if (!req.includeBots) {
        where.push(
          'c.agent_id IS NULL AND c.id NOT IN (SELECT conversation_id FROM bot_groups)'
        )
      }
      if (req.mode) {
        where.push('c.mode = ?')
        params.push(req.mode)
      }
      if (req.projectRef) {
        where.push('c.project_ref = ?')
        params.push(req.projectRef)
      }
      const search = req.search?.trim()
      if (search) {
        // GLOB with per-character case classes, because neither LIKE nor LOWER
        // folds beyond ASCII in the bundled SQLite build ('Ö' would never match).
        const pattern = toSearchGlob(search)
        where.push(
          `(c.title GLOB ? OR EXISTS (
             SELECT 1 FROM messages m
             WHERE m.conversation_id = c.id AND m.content GLOB ?))`
        )
        params.push(pattern, pattern)
      }
      let limitClause = ''
      if (req.limit !== undefined) {
        limitClause = 'LIMIT ?'
        params.push(Math.max(1, Math.floor(req.limit)))
      }
      const rows = driver.all<SummaryRow>(
        `SELECT c.id, c.mode, c.title, c.updated_at, c.project_ref, c.space_id,
           (SELECT substr(m2.content, 1, 400) FROM messages m2
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
        projectRef: row.project_ref,
        spaceId: row.space_id,
        snippet: toSnippet(row.snippet),
      }))
    },

    create(input) {
      const now = Date.now()
      const conversation: Conversation = {
        id: input.id ?? randomUUID(),
        mode: input.mode,
        title: input.title ?? 'New chat',
        providerId: input.providerId ?? null,
        modelId: input.modelId ?? null,
        systemPrompt: input.systemPrompt ?? null,
        params: {},
        workspaceId: input.workspaceId ?? null,
        projectId: input.projectId ?? null,
        projectRef: input.projectRef ?? null,
        moaPresetId: input.moaPresetId ?? null,
        knowledgeBaseId: input.knowledgeBaseId ?? null,
        parentConversationId: input.parentConversationId ?? null,
        forkedAtMessageId: input.forkedAtMessageId ?? null,
        // Not in the INSERT below — the column simply defaults to NULL.
        budgetUsd: null,
        spaceId: input.spaceId ?? null,
        agentId: input.agentId ?? null,
        createdAt: now,
        updatedAt: now,
      }
      driver.run(
        `INSERT INTO conversations
           (id, mode, title, provider_id, model_id, system_prompt, params_json,
            workspace_id, project_id, project_ref, moa_preset_id, knowledge_base_id,
            parent_conversation_id, forked_at_message_id, space_id, agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          conversation.projectRef,
          conversation.moaPresetId,
          conversation.knowledgeBaseId ?? null,
          conversation.parentConversationId ?? null,
          conversation.forkedAtMessageId ?? null,
          conversation.spaceId ?? null,
          conversation.agentId ?? null,
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
          project_ref: patch.projectRef,
          moa_preset_id: patch.moaPresetId,
          knowledge_base_id: patch.knowledgeBaseId,
          budget_usd: patch.budgetUsd,
        },
        { touchUpdatedAt: true }
      )
      return getById(id)
    },

    remove(id) {
      // Messages cascade via FK.
      driver.run('DELETE FROM conversations WHERE id = ?', [id])
    },

    deleteAll() {
      // Messages + documents cascade via FK.
      driver.run('DELETE FROM conversations')
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

    clearKnowledgeBase(knowledgeBaseId) {
      driver.run(
        'UPDATE conversations SET knowledge_base_id = NULL WHERE knowledge_base_id = ?',
        [knowledgeBaseId]
      )
    },

    setSummary(id, summaryText, throughSeq) {
      driver.run(
        'UPDATE conversations SET summary_text = ?, summary_through_seq = ? WHERE id = ?',
        [summaryText, throughSeq, id]
      )
    },

    clearSummary(id) {
      driver.run(
        'UPDATE conversations SET summary_text = NULL, summary_through_seq = NULL WHERE id = ?',
        [id]
      )
    },

    listForks(parentId) {
      const rows = driver.all<{ id: string; title: string; created_at: number }>(
        `SELECT id, title, created_at FROM conversations
         WHERE parent_conversation_id = ?
         ORDER BY created_at ASC`,
        [parentId]
      )
      return rows.map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at }))
    },

    listPrivateSpaceConversationIds() {
      const rows = driver.all<{ id: string }>(
        'SELECT id FROM conversations WHERE space_id IS NOT NULL'
      )
      return rows.map((row) => row.id)
    },
  }
}
