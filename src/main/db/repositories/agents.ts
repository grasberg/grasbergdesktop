/**
 * Agent-profile storage (migration v21): user-defined sub-agents with their
 * own persona, optional dedicated model, and optional restricted toolset.
 * Since v46 a profile is also a Bot Mode roster entry: title (role), avatar,
 * hidden flag and a lazily created canonical chat conversation.
 */

import { randomUUID } from 'node:crypto'
import type { AgentProfile, AgentProfileInput, AgentProfilePatch, BotAvatar } from '@shared/types'
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
  created_at: number
  updated_at: number
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
        createdAt: now,
        updatedAt: now,
      }
      driver.run(
        `INSERT INTO agents
           (id, name, description, system_prompt, provider_id, model_id,
            tool_ids_json, max_rounds, enabled, title, avatar_json, hidden,
            chat_conversation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        },
        { touchUpdatedAt: true }
      )
      return getById(id)
    },

    setChatConversation(id, conversationId) {
      driver.run('UPDATE agents SET chat_conversation_id = ? WHERE id = ?', [conversationId, id])
    },

    remove(id) {
      driver.run('DELETE FROM agents WHERE id = ?', [id])
    },
  }
}
