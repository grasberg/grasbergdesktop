/**
 * Agent-profile storage (migration v21): user-defined sub-agents with their
 * own persona, optional dedicated model, and optional restricted toolset.
 */

import { randomUUID } from 'node:crypto'
import type { AgentProfile, AgentProfileInput, AgentProfilePatch } from '@shared/types'
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
  created_at: number
  updated_at: number
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
        createdAt: now,
        updatedAt: now,
      }
      driver.run(
        `INSERT INTO agents
           (id, name, description, system_prompt, provider_id, model_id,
            tool_ids_json, max_rounds, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        },
        { touchUpdatedAt: true }
      )
      return getById(id)
    },

    remove(id) {
      driver.run('DELETE FROM agents WHERE id = ?', [id])
    },
  }
}
