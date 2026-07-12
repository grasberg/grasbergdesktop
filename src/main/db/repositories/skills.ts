/**
 * Skills (migration v15, table `skills`): Agent-Skills-standard instruction
 * sets (SKILL.md) imported from folders/plugins or authored in Settings →
 * Skills. Enabled skills are listed in the system prompt; the model loads a
 * skill's full content through the use_skill tool.
 */

import { randomUUID } from 'node:crypto'
import type { Skill, SkillInput, SkillPatch } from '@shared/types'
import type { SqliteDriver } from '../driver'
import { updateById } from './util'

export interface SkillsRepository {
  /** Ordered by plugin name, then skill name (stable settings listing). */
  list(): Skill[]
  /** Enabled skills only — what reaches the system prompt / use_skill. */
  listEnabled(): Skill[]
  /** How many skills are enabled, without loading their content. */
  countEnabled(): number
  getById(id: string): Skill | null
  /** Case-insensitive name lookup (models type names loosely). */
  getByName(name: string): Skill | null
  create(input: SkillInput): Skill
  update(id: string, patch: SkillPatch): Skill | null
  remove(id: string): void
  /**
   * Creates the skill, or — when one with the same name already exists
   * (case-insensitive) — replaces its description/content/provenance instead.
   * Re-importing a folder therefore updates in place. The enabled flag of an
   * existing skill is preserved.
   */
  upsertByName(input: SkillInput): Skill
}

interface SkillRow {
  id: string
  name: string
  description: string
  content: string
  plugin_name: string | null
  source_path: string | null
  enabled: number
  created_at: number
  updated_at: number
}

function toSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    pluginName: row.plugin_name,
    sourcePath: row.source_path,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const LIST_ORDER = 'ORDER BY plugin_name IS NOT NULL, plugin_name ASC, name COLLATE NOCASE ASC'

export function createSkillsRepository(driver: SqliteDriver): SkillsRepository {
  const getById = (id: string): Skill | null => {
    const row = driver.get<SkillRow>('SELECT * FROM skills WHERE id = ?', [id])
    return row ? toSkill(row) : null
  }

  const getByName = (name: string): Skill | null => {
    const row = driver.get<SkillRow>(
      'SELECT * FROM skills WHERE name = ? COLLATE NOCASE ORDER BY created_at ASC LIMIT 1',
      [name]
    )
    return row ? toSkill(row) : null
  }

  const create = (input: SkillInput): Skill => {
    const now = Date.now()
    const skill: Skill = {
      id: randomUUID(),
      name: input.name,
      description: input.description ?? '',
      content: input.content,
      pluginName: input.pluginName ?? null,
      sourcePath: input.sourcePath ?? null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }
    driver.run(
      `INSERT INTO skills
         (id, name, description, content, plugin_name, source_path, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [skill.id, skill.name, skill.description, skill.content, skill.pluginName, skill.sourcePath, now, now]
    )
    return skill
  }

  return {
    list() {
      const rows = driver.all<SkillRow>(`SELECT * FROM skills ${LIST_ORDER}`)
      return rows.map(toSkill)
    },

    listEnabled() {
      const rows = driver.all<SkillRow>(`SELECT * FROM skills WHERE enabled = 1 ${LIST_ORDER}`)
      return rows.map(toSkill)
    },

    countEnabled() {
      const row = driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM skills WHERE enabled = 1'
      )
      return row ? row.count : 0
    },

    getById,

    getByName,

    create,

    update(id, patch) {
      updateById(
        driver,
        'skills',
        id,
        {
          name: patch.name,
          description: patch.description,
          content: patch.content,
          enabled: patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0,
        },
        { touchUpdatedAt: true }
      )
      return getById(id)
    },

    remove(id) {
      driver.run('DELETE FROM skills WHERE id = ?', [id])
    },

    upsertByName(input) {
      const existing = getByName(input.name)
      if (!existing) return create(input)
      driver.run(
        `UPDATE skills
         SET description = ?, content = ?, plugin_name = ?, source_path = ?, updated_at = ?
         WHERE id = ?`,
        [
          input.description ?? '',
          input.content,
          input.pluginName ?? null,
          input.sourcePath ?? null,
          Date.now(),
          existing.id,
        ]
      )
      // The row exists, so getById cannot return null here.
      return getById(existing.id) as Skill
    },
  }
}
