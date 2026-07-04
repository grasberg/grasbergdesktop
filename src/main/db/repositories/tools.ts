/**
 * Tool permissions ('always_allow' | 'ask' | 'deny') and per-tool enable flags.
 */

import type { ToolPermission, ToolPermissionDecision } from '@shared/types'
import type { SqliteDriver } from '../driver'

export interface ToolsRepository {
  permissionsList(): ToolPermission[]
  permissionSet(toolId: string, decision: ToolPermissionDecision): void
  /** toolId -> enabled; tools without a row have no entry (caller applies defaults). */
  enabledMap(): Record<string, boolean>
  setEnabled(toolId: string, enabled: boolean): void
}

interface ToolPermissionRow {
  tool_id: string
  decision: string
  updated_at: number
}

interface ToolSettingRow {
  tool_id: string
  enabled: number
}

export function createToolsRepository(driver: SqliteDriver): ToolsRepository {
  return {
    permissionsList() {
      const rows = driver.all<ToolPermissionRow>(
        'SELECT tool_id, decision, updated_at FROM tool_permissions'
      )
      return rows.map((row) => ({
        toolId: row.tool_id,
        decision: row.decision as ToolPermissionDecision,
        updatedAt: row.updated_at,
      }))
    },

    permissionSet(toolId, decision) {
      driver.run(
        `INSERT INTO tool_permissions (tool_id, decision, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(tool_id) DO UPDATE SET
           decision = excluded.decision,
           updated_at = excluded.updated_at`,
        [toolId, decision, Date.now()]
      )
    },

    enabledMap() {
      const rows = driver.all<ToolSettingRow>('SELECT tool_id, enabled FROM tool_settings')
      const map: Record<string, boolean> = {}
      for (const row of rows) map[row.tool_id] = row.enabled !== 0
      return map
    },

    setEnabled(toolId, enabled) {
      driver.run(
        `INSERT INTO tool_settings (tool_id, enabled, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(tool_id) DO UPDATE SET
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
        [toolId, enabled ? 1 : 0, Date.now()]
      )
    },
  }
}
