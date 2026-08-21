/**
 * Standing approval rules (migration v31, table `tool_rules`): what the user
 * answered "always allow" / "always ask" to, kept across restarts. The
 * matching logic lives in tools/tool-rules.ts; this is storage only.
 *
 * create() is an upsert on (tool_id, effect, scope, scope_id, pattern) so
 * clicking "Always allow" twice leaves one rule, not a growing pile.
 */

import { randomUUID } from 'node:crypto'
import type { ToolRule, ToolRuleEffect, ToolRuleInput, ToolRuleScope } from '@shared/types'
import type { SqliteDriver } from '../driver'

export interface ToolRulesRepository {
  /** Newest first. The executor reads the whole (small) set per call. */
  list(): ToolRule[]
  create(input: ToolRuleInput): ToolRule
  remove(id: string): void
  /** Drops every rule scoped to one conversation/project (used on delete). */
  removeByScope(scope: ToolRuleScope, scopeId: string): void
  deleteAll(): void
}

interface ToolRuleRow {
  id: string
  tool_id: string
  effect: ToolRuleEffect
  scope: ToolRuleScope
  scope_id: string | null
  pattern: string | null
  created_at: number
}

function toRule(row: ToolRuleRow): ToolRule {
  return {
    id: row.id,
    toolId: row.tool_id,
    effect: row.effect,
    scope: row.scope,
    scopeId: row.scope_id,
    pattern: row.pattern,
    createdAt: row.created_at,
  }
}

/** Empty/whitespace patterns are stored as NULL ("every call of this tool"). */
function normalizePattern(pattern: string | null | undefined): string | null {
  const trimmed = pattern?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

export function createToolRulesRepository(driver: SqliteDriver): ToolRulesRepository {
  return {
    list() {
      return driver
        .all<ToolRuleRow>('SELECT * FROM tool_rules ORDER BY created_at DESC')
        .map(toRule)
    },

    create(input) {
      const scopeId = input.scope === 'global' ? null : (input.scopeId ?? null)
      const pattern = normalizePattern(input.pattern)
      // Identical rule already stored? Return it instead of duplicating.
      const existing = driver.get<ToolRuleRow>(
        `SELECT * FROM tool_rules
         WHERE tool_id = ? AND effect = ? AND scope = ?
           AND scope_id IS ? AND pattern IS ?`,
        [input.toolId, input.effect, input.scope, scopeId, pattern]
      )
      if (existing) return toRule(existing)
      const rule: ToolRule = {
        id: randomUUID(),
        toolId: input.toolId,
        effect: input.effect,
        scope: input.scope,
        scopeId,
        pattern,
        createdAt: Date.now(),
      }
      driver.run(
        `INSERT INTO tool_rules (id, tool_id, effect, scope, scope_id, pattern, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [rule.id, rule.toolId, rule.effect, rule.scope, rule.scopeId, rule.pattern, rule.createdAt]
      )
      return rule
    },

    remove(id) {
      driver.run('DELETE FROM tool_rules WHERE id = ?', [id])
    },

    removeByScope(scope, scopeId) {
      driver.run('DELETE FROM tool_rules WHERE scope = ? AND scope_id = ?', [scope, scopeId])
    },

    deleteAll() {
      driver.run('DELETE FROM tool_rules')
    },
  }
}
