/**
 * User-defined HTTP tools (migration v2, table `custom_tools`).
 *
 * Rows are raw storage records; mapping to the LLM-facing ToolDefinition
 * ('custom:<uuid>' ids, risk 'sensitive') lives in src/main/tools/custom-tools.ts.
 */

import { randomUUID } from 'node:crypto'
import type { SqliteDriver } from '../driver'

/** Stored custom tool. `id` is the bare UUID (no 'custom:' prefix). */
export interface CustomToolRecord {
  id: string
  name: string
  description: string
  baseUrl: string
  /** Uppercase HTTP method, e.g. 'GET' or 'POST'. */
  method: string
  /** JSON object of request headers ({} when none). */
  headersJson: string
  /** JSON Schema for the tool arguments (OpenAI tool format). */
  paramsSchemaJson: string
  createdAt: number
}

export interface CustomToolCreateInput {
  name: string
  description: string
  baseUrl: string
  method: string
  headersJson: string
  paramsSchemaJson: string
}

/** Partial update; only the provided fields change. */
export type CustomToolUpdateInput = Partial<CustomToolCreateInput>

export interface CustomToolsRepository {
  /** Ordered by created_at ASC (stable tool order for the model). */
  list(): CustomToolRecord[]
  getById(id: string): CustomToolRecord | null
  /** Generates the id and created_at. */
  create(input: CustomToolCreateInput): CustomToolRecord
  /** Updates the given fields; returns the updated record or null if unknown. */
  update(id: string, patch: CustomToolUpdateInput): CustomToolRecord | null
  remove(id: string): void
}

interface CustomToolRow {
  id: string
  name: string
  description: string
  base_url: string
  method: string
  headers_json: string
  params_schema_json: string
  created_at: number
}

function toCustomTool(row: CustomToolRow): CustomToolRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    baseUrl: row.base_url,
    method: row.method,
    headersJson: row.headers_json,
    paramsSchemaJson: row.params_schema_json,
    createdAt: row.created_at,
  }
}

export function createCustomToolsRepository(driver: SqliteDriver): CustomToolsRepository {
  return {
    list() {
      const rows = driver.all<CustomToolRow>('SELECT * FROM custom_tools ORDER BY created_at ASC')
      return rows.map(toCustomTool)
    },

    getById(id) {
      const row = driver.get<CustomToolRow>('SELECT * FROM custom_tools WHERE id = ?', [id])
      return row ? toCustomTool(row) : null
    },

    create(input) {
      const record: CustomToolRecord = {
        id: randomUUID(),
        name: input.name,
        description: input.description,
        baseUrl: input.baseUrl,
        method: input.method,
        headersJson: input.headersJson,
        paramsSchemaJson: input.paramsSchemaJson,
        createdAt: Date.now(),
      }
      driver.run(
        `INSERT INTO custom_tools
           (id, name, description, base_url, method, headers_json, params_schema_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.name,
          record.description,
          record.baseUrl,
          record.method,
          record.headersJson,
          record.paramsSchemaJson,
          record.createdAt,
        ]
      )
      return record
    },

    update(id, patch) {
      const sets: string[] = []
      const params: (string | number)[] = []
      const push = (column: string, value: string): void => {
        sets.push(`${column} = ?`)
        params.push(value)
      }
      if (patch.name !== undefined) push('name', patch.name)
      if (patch.description !== undefined) push('description', patch.description)
      if (patch.baseUrl !== undefined) push('base_url', patch.baseUrl)
      if (patch.method !== undefined) push('method', patch.method)
      if (patch.headersJson !== undefined) push('headers_json', patch.headersJson)
      if (patch.paramsSchemaJson !== undefined) push('params_schema_json', patch.paramsSchemaJson)
      if (sets.length > 0) {
        params.push(id)
        driver.run(`UPDATE custom_tools SET ${sets.join(', ')} WHERE id = ?`, params)
      }
      const row = driver.get<CustomToolRow>('SELECT * FROM custom_tools WHERE id = ?', [id])
      return row ? toCustomTool(row) : null
    },

    remove(id) {
      driver.run('DELETE FROM custom_tools WHERE id = ?', [id])
    },
  }
}
