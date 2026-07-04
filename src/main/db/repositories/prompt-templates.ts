/**
 * Prompt library (migration v5, table `prompt_templates`): reusable saved
 * prompts a user inserts into the composer or sets as a conversation's system
 * prompt.
 */

import { randomUUID } from 'node:crypto'
import type { PromptTemplate, PromptTemplateInput, PromptTemplatePatch } from '@shared/types'
import type { SqliteDriver } from '../driver'

export interface PromptTemplatesRepository {
  /** Ordered by updated_at DESC (most recently edited first). */
  list(): PromptTemplate[]
  getById(id: string): PromptTemplate | null
  create(input: PromptTemplateInput): PromptTemplate
  update(id: string, patch: PromptTemplatePatch): PromptTemplate | null
  remove(id: string): void
}

interface PromptTemplateRow {
  id: string
  title: string
  body: string
  variables_json: string | null
  created_at: number
  updated_at: number
}

function parseVariables(text: string | null): string[] | null {
  if (!text) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : null
  } catch {
    return null
  }
}

function toTemplate(row: PromptTemplateRow): PromptTemplate {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    variables: parseVariables(row.variables_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createPromptTemplatesRepository(driver: SqliteDriver): PromptTemplatesRepository {
  const getById = (id: string): PromptTemplate | null => {
    const row = driver.get<PromptTemplateRow>('SELECT * FROM prompt_templates WHERE id = ?', [id])
    return row ? toTemplate(row) : null
  }

  return {
    list() {
      const rows = driver.all<PromptTemplateRow>(
        'SELECT * FROM prompt_templates ORDER BY updated_at DESC'
      )
      return rows.map(toTemplate)
    },

    getById,

    create(input) {
      const now = Date.now()
      const template: PromptTemplate = {
        id: randomUUID(),
        title: input.title,
        body: input.body,
        variables: null,
        createdAt: now,
        updatedAt: now,
      }
      driver.run(
        `INSERT INTO prompt_templates (id, title, body, variables_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [template.id, template.title, template.body, null, template.createdAt, template.updatedAt]
      )
      return template
    },

    update(id, patch) {
      const sets: string[] = []
      const params: (string | number)[] = []
      if (patch.title !== undefined) {
        sets.push('title = ?')
        params.push(patch.title)
      }
      if (patch.body !== undefined) {
        sets.push('body = ?')
        params.push(patch.body)
      }
      if (sets.length > 0) {
        sets.push('updated_at = ?')
        params.push(Date.now(), id)
        driver.run(`UPDATE prompt_templates SET ${sets.join(', ')} WHERE id = ?`, params)
      }
      return getById(id)
    },

    remove(id) {
      driver.run('DELETE FROM prompt_templates WHERE id = ?', [id])
    },
  }
}
