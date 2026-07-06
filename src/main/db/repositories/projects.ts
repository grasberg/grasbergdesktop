/**
 * Per-mode organizational projects: a lightweight folder grouping conversations
 * within a single mode. Deleting a project unfiles its tasks (sets their
 * project_ref to NULL) rather than deleting them — there is no FK on
 * conversations.project_ref, so the unfiling is done here explicitly.
 */

import { randomUUID } from 'node:crypto'
import type { ConversationMode, Project, ProjectInput, ProjectPatch } from '@shared/types'
import type { SqliteDriver } from '../driver'
import { updateById } from './util'

export interface ProjectsRepository {
  /** Newest first; scoped to `mode` when given, otherwise every mode. */
  list(mode?: ConversationMode): Project[]
  getById(id: string): Project | null
  /** Generates the id (crypto.randomUUID) and timestamps. */
  create(input: ProjectInput): Project
  update(id: string, patch: ProjectPatch): Project | null
  /** Deletes the project and unfiles its tasks (project_ref -> NULL). */
  remove(id: string): void
  /** Deletes every project. Callers are responsible for unfiling tasks. */
  deleteAll(): void
}

interface ProjectRow {
  id: string
  mode: string
  name: string
  created_at: number
  updated_at: number
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    mode: row.mode as ConversationMode,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createProjectsRepository(driver: SqliteDriver): ProjectsRepository {
  const getById = (id: string): Project | null => {
    const row = driver.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [id])
    return row ? toProject(row) : null
  }

  return {
    list(mode) {
      const rows = mode
        ? driver.all<ProjectRow>(
            'SELECT * FROM projects WHERE mode = ? ORDER BY updated_at DESC',
            [mode]
          )
        : driver.all<ProjectRow>('SELECT * FROM projects ORDER BY updated_at DESC')
      return rows.map(toProject)
    },

    getById,

    create(input) {
      const now = Date.now()
      const project: Project = {
        id: randomUUID(),
        mode: input.mode,
        name: input.name,
        createdAt: now,
        updatedAt: now,
      }
      driver.run(
        `INSERT INTO projects (id, mode, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [project.id, project.mode, project.name, project.createdAt, project.updatedAt]
      )
      return project
    },

    update(id, patch) {
      updateById(driver, 'projects', id, { name: patch.name }, { touchUpdatedAt: true })
      return getById(id)
    },

    remove(id) {
      // Unfile the project's tasks before removing it — no FK does this for us.
      driver.run('UPDATE conversations SET project_ref = NULL WHERE project_ref = ?', [id])
      driver.run('DELETE FROM projects WHERE id = ?', [id])
    },

    deleteAll() {
      driver.run('DELETE FROM projects')
    },
  }
}
