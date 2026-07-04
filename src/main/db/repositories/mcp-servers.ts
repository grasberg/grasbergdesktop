/**
 * MCP server configs (migration v7, table `mcp_servers`). Stores only
 * non-secret fields; secret env vars / headers live in `tool_secrets`
 * (scope 'mcp_server'). `secretNames` on the returned config is always empty
 * here — the IPC layer fills it from the secrets repo.
 */

import { randomUUID } from 'node:crypto'
import type { McpServerConfig, McpTransport } from '@shared/types'
import type { SqliteDriver } from '../driver'

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

function parseStringArray(text: string): string[] {
  try {
    const v: unknown = JSON.parse(text)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function parseStringMap(text: string): Record<string, string> {
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const out: Record<string, string> = {}
      for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val
      return out
    }
  } catch {
    // fall through
  }
  return {}
}

function toConfig(row: McpServerRow): McpServerConfig {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    transport: row.transport as McpTransport,
    command: row.command,
    args: parseStringArray(row.args_json),
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
      const sets: string[] = []
      const params: (string | number | null)[] = []
      const push = (column: string, value: string | number | null): void => {
        sets.push(`${column} = ?`)
        params.push(value)
      }
      if (patch.name !== undefined) push('name', patch.name)
      if (patch.command !== undefined) push('command', patch.command)
      if (patch.args !== undefined) push('args_json', JSON.stringify(patch.args))
      if (patch.env !== undefined) push('env_json', JSON.stringify(patch.env))
      if (patch.url !== undefined) push('url', patch.url)
      if (patch.headers !== undefined) push('headers_json', JSON.stringify(patch.headers))
      if (patch.enabled !== undefined) push('enabled', patch.enabled ? 1 : 0)
      if (sets.length > 0) {
        push('updated_at', Date.now())
        params.push(id)
        driver.run(`UPDATE mcp_servers SET ${sets.join(', ')} WHERE id = ?`, params)
      }
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
