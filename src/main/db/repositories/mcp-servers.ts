/**
 * MCP server configs (migration v7, table `mcp_servers`). Stores only
 * non-secret fields; secret env vars / headers live in `tool_secrets`
 * (scope 'mcp_server'). `secretNames` on the returned config is always empty
 * here — the IPC layer fills it from the secrets repo.
 */

import { randomUUID } from 'node:crypto'
import type { McpServerConfig, McpTransport } from '@shared/types'
import type { SqliteDriver } from '../driver'
import { parseStringArray, parseStringMap, updateById } from './util'

export interface McpServerCreateInput {
  name: string
  transport: McpTransport
  command: string | null
  args: string[]
  env: Record<string, string>
  url: string | null
  headers: Record<string, string>
  enabled: boolean
}

export interface McpServerUpdateInput {
  name?: string
  command?: string | null
  args?: string[]
  env?: Record<string, string>
  url?: string | null
  headers?: Record<string, string>
  enabled?: boolean
}

export interface McpServersRepository {
  /** All servers (secretNames empty; the IPC layer fills them). */
  list(): McpServerConfig[]
  getById(id: string): McpServerConfig | null
  create(input: McpServerCreateInput): McpServerConfig
  update(id: string, patch: McpServerUpdateInput): McpServerConfig | null
  remove(id: string): void
  setEnabled(id: string, enabled: boolean): void
}

interface McpServerRow {
  id: string
  key: string
  name: string
  transport: string
  command: string | null
  args_json: string
  env_json: string
  url: string | null
  headers_json: string
  enabled: number
  created_at: number
  updated_at: number
}

function toConfig(row: McpServerRow): McpServerConfig {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    transport: row.transport as McpTransport,
    command: row.command,
    args: parseStringArray(row.args_json, []),
    env: parseStringMap(row.env_json),
    url: row.url,
    headers: parseStringMap(row.headers_json),
    enabled: row.enabled !== 0,
    secretNames: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createMcpServersRepository(driver: SqliteDriver): McpServersRepository {
  const getById = (id: string): McpServerConfig | null => {
    const row = driver.get<McpServerRow>('SELECT * FROM mcp_servers WHERE id = ?', [id])
    return row ? toConfig(row) : null
  }

  return {
    list() {
      return driver
        .all<McpServerRow>('SELECT * FROM mcp_servers ORDER BY created_at ASC')
        .map(toConfig)
    },

    getById,

    create(input) {
      const now = Date.now()
      const id = randomUUID()
      const key = randomUUID().slice(0, 8)
      driver.run(
        `INSERT INTO mcp_servers
           (id, key, name, transport, command, args_json, env_json, url, headers_json, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          key,
          input.name,
          input.transport,
          input.command,
          JSON.stringify(input.args),
          JSON.stringify(input.env),
          input.url,
          JSON.stringify(input.headers),
          input.enabled ? 1 : 0,
          now,
          now,
        ]
      )
      return getById(id)!
    },

    update(id, patch) {
      updateById(
        driver,
        'mcp_servers',
        id,
        {
          name: patch.name,
          command: patch.command,
          args_json: patch.args === undefined ? undefined : JSON.stringify(patch.args),
          env_json: patch.env === undefined ? undefined : JSON.stringify(patch.env),
          url: patch.url,
          headers_json: patch.headers === undefined ? undefined : JSON.stringify(patch.headers),
          enabled: patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0,
        },
        { touchUpdatedAt: true }
      )
      return getById(id)
    },

    remove(id) {
      driver.run('DELETE FROM mcp_servers WHERE id = ?', [id])
    },

    setEnabled(id, enabled) {
      driver.run('UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?', [
        enabled ? 1 : 0,
        Date.now(),
        id,
      ])
    },
  }
}
