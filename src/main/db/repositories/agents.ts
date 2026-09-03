/**
 * Agent-profile storage (migration v21): user-defined sub-agents with their
 * own persona, optional dedicated model, and optional restricted toolset.
 * Since v46 a profile is also a Bot Mode roster entry: title (role), avatar,
 * hidden flag and a lazily created canonical chat conversation.
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentProfile,
  AgentProfileInput,
  AgentProfilePatch,
  BotAvatar,
  BotHeartbeat,
  BotResetPolicy,
  WorkflowWatchConfig,
} from '@shared/types'
import type { SqliteDriver } from '../driver'
import { parseStringArray, updateById } from './util'

export interface AgentsRepository {
  list(): AgentProfile[]
  listEnabled(): AgentProfile[]
  getById(id: string): AgentProfile | null
  /** Case-insensitive name lookup (names are unique NOCASE). */
  getByName(name: string): AgentProfile | null
  create(input: AgentProfileInput): AgentProfile
  update(id: string, patch: AgentProfilePatch): AgentProfile | null
  /** Records the bot's canonical chat conversation (created lazily). */
  setChatConversation(id: string, conversationId: string | null): void
  /** The user is looking at the canonical chat: stamps chat_seen_at (v49). */
  markChatSeen(id: string, seenAt: number): void
  /** Enabled bots with an ENABLED folder watch (v50) — what the watcher runs. */
  listWatchedLite(): Array<{ id: string; watch: WorkflowWatchConfig }>
  remove(id: string): void
}

interface AgentRow {
  id: string
  name: string
  description: string
  system_prompt: string
  provider_id: string | null
  model_id: string | null
  tool_ids_json: string | null
  max_rounds: number | null
  enabled: number
  title: string
  avatar_json: string | null
  hidden: number
  chat_conversation_id: string | null
  chat_seen_at: number | null
  heartbeat_json: string | null
  reset_json: string | null
  message_allow_json: string | null
  webhook_enabled: number
  watch_json: string | null
  created_at: number
  updated_at: number
}

function parseObject<T>(json: string | null): T | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null
  } catch {
    return null
  }
}

function parseAvatar(json: string | null): BotAvatar | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    const emoji = typeof record.emoji === 'string' ? record.emoji : null
    const color = typeof record.color === 'string' ? record.color : null
    if (!emoji && !color) return null
    return { emoji, color }
  } catch {
    return null
  }
}

function toAgent(row: AgentRow): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    providerId: row.provider_id,
    modelId: row.model_id,
    toolIds: row.tool_ids_json === null ? null : parseStringArray(row.tool_ids_json, []),
    maxRounds: row.max_rounds,
    enabled: row.enabled === 1,
    title: row.title,
    avatar: parseAvatar(row.avatar_json),
    hidden: row.hidden === 1,
    chatConversationId: row.chat_conversation_id,
    chatSeenAt: row.chat_seen_at,
    heartbeat: parseObject<BotHeartbeat>(row.heartbeat_json),
    reset: parseObject<BotResetPolicy>(row.reset_json),
    messageAllow:
      row.message_allow_json === null ? null : parseStringArray(row.message_allow_json, []),
    webhookEnabled: row.webhook_enabled === 1,
    watch: parseObject<WorkflowWatchConfig>(row.watch_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createAgentsRepository(driver: SqliteDriver): AgentsRepository {
  const getById = (id: string): AgentProfile | null => {
    const row = driver.get<AgentRow>('SELECT * FROM agents WHERE id = ?', [id])
    return row ? toAgent(row) : null
  }

  return {
    list() {
      return driver.all<AgentRow>('SELECT * FROM agents ORDER BY name COLLATE NOCASE').map(toAgent)
    },

    listEnabled() {
      return driver
        .all<AgentRow>('SELECT * FROM agents WHERE enabled = 1 ORDER BY name COLLATE NOCASE')
        .map(toAgent)
    },

    getById,

    getByName(name) {
      const row = driver.get<AgentRow>('SELECT * FROM agents WHERE name = ? COLLATE NOCASE', [
        name,
      ])
      return row ? toAgent(row) : null
    },

    create(input) {
      const now = Date.now()
      const agent: AgentProfile = {
        id: randomUUID(),
        name: input.name,
        description: input.description ?? '',
        systemPrompt: input.systemPrompt,
        providerId: input.providerId ?? null,
        modelId: input.modelId ?? null,
        toolIds: input.toolIds ?? null,
        maxRounds: input.maxRounds ?? null,
        enabled: input.enabled !== false,
        title: input.title ?? '',
        avatar: input.avatar ?? null,
        hidden: input.hidden === true,
        chatConversationId: null,
        chatSeenAt: null,
        heartbeat: input.heartbeat ?? null,
        reset: input.reset ?? null,
        messageAllow: input.messageAllow ?? null,
        webhookEnabled: input.webhookEnabled === true,
        watch: input.watch ?? null,
        createdAt: now,
        updatedAt: now,
      }
      driver.run(
        `INSERT INTO agents
           (id, name, description, system_prompt, provider_id, model_id,
            tool_ids_json, max_rounds, enabled, title, avatar_json, hidden,
            chat_conversation_id, heartbeat_json, reset_json, message_allow_json,
            webhook_enabled, watch_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          agent.id,
          agent.name,
          agent.description,
          agent.systemPrompt,
          agent.providerId,
          agent.modelId,
          agent.toolIds ? JSON.stringify(agent.toolIds) : null,
          agent.maxRounds,
          agent.enabled ? 1 : 0,
          agent.title,
          agent.avatar ? JSON.stringify(agent.avatar) : null,
          agent.hidden ? 1 : 0,
          null,
          agent.heartbeat ? JSON.stringify(agent.heartbeat) : null,
          agent.reset ? JSON.stringify(agent.reset) : null,
          agent.messageAllow ? JSON.stringify(agent.messageAllow) : null,
          agent.webhookEnabled ? 1 : 0,
          agent.watch ? JSON.stringify(agent.watch) : null,
          now,
          now,
        ]
      )
      return agent
    },

    update(id, patch) {
      updateById(
        driver,
        'agents',
        id,
        {
          name: patch.name,
          description: patch.description,
          system_prompt: patch.systemPrompt,
          provider_id: patch.providerId,
          model_id: patch.modelId,
          tool_ids_json:
            patch.toolIds === undefined
              ? undefined
              : patch.toolIds === null
                ? null
                : JSON.stringify(patch.toolIds),
          max_rounds: patch.maxRounds,
          enabled: patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0,
          title: patch.title,
          avatar_json:
            patch.avatar === undefined
              ? undefined
              : patch.avatar === null
                ? null
                : JSON.stringify(patch.avatar),
          hidden: patch.hidden === undefined ? undefined : patch.hidden ? 1 : 0,
          heartbeat_json:
            patch.heartbeat === undefined
              ? undefined
              : patch.heartbeat === null
                ? null
                : JSON.stringify(patch.heartbeat),
          reset_json:
            patch.reset === undefined
              ? undefined
              : patch.reset === null
                ? null
                : JSON.stringify(patch.reset),
          message_allow_json:
            patch.messageAllow === undefined
              ? undefined
              : patch.messageAllow === null
                ? null
                : JSON.stringify(patch.messageAllow),
          webhook_enabled:
            patch.webhookEnabled === undefined ? undefined : patch.webhookEnabled ? 1 : 0,
          watch_json:
            patch.watch === undefined ? undefined : patch.watch === null ? null : JSON.stringify(patch.watch),
        },
        { touchUpdatedAt: true }
      )
      return getById(id)
    },

    setChatConversation(id, conversationId) {
      driver.run('UPDATE agents SET chat_conversation_id = ? WHERE id = ?', [conversationId, id])
    },

    markChatSeen(id, seenAt) {
      // Deliberately no updated_at touch — reading is not editing.
      driver.run('UPDATE agents SET chat_seen_at = ? WHERE id = ?', [seenAt, id])
    },

    listWatchedLite() {
      const rows = driver.all<{ id: string; watch_json: string | null }>(
        'SELECT id, watch_json FROM agents WHERE enabled = 1 AND watch_json IS NOT NULL'
      )
      const result: Array<{ id: string; watch: WorkflowWatchConfig }> = []
      for (const row of rows) {
        const watch = parseObject<WorkflowWatchConfig>(row.watch_json)
        if (watch && watch.enabled === true && typeof watch.folderPath === 'string') {
          result.push({ id: row.id, watch })
        }
      }
      return result
    },

    remove(id) {
      driver.run('DELETE FROM agents WHERE id = ?', [id])
    },
  }
}
