/**
 * Code mode: approved project folders + proposed/applied file changes.
 */

import { randomUUID } from 'node:crypto'
import type { CodeChange, CodeChangeStatus, CodeChangeType, CodeProject } from '@shared/types'
import type { SqliteDriver } from '../driver'

export interface CodeChangeCreateInput {
  projectId: string
  conversationId: string | null
  filePath: string
  changeType: CodeChangeType
  diff: string
  newContent: string | null
  /** Baseline content at proposal time ('' for create; null when unknown). */
  oldContent: string | null
}

export interface CodeRepository {
  projectsList(): CodeProject[]
  projectGetById(id: string): CodeProject | null
  /**
   * Registers a folder or refreshes an existing registration (matched by
   * absolute path). Generates the id on first insert; always bumps
   * last_opened_at and updates the display name.
   */
  projectUpsertByPath(path: string, name: string): CodeProject
  projectForget(id: string): void
  /**
   * Ordered by created_at DESC (newest proposals first), capped at the most
   * recent 200. Listing never marshals the file bodies: newContent/oldContent
   * are always null here — apply/revert re-read the full row via changeGet.
   */
  changesList(projectId: string): CodeChange[]
  /** Generates the id; status starts as 'proposed'. */
  changeCreate(input: CodeChangeCreateInput): CodeChange
  changeGet(id: string): CodeChange | null
  /**
   * Sets status; applied_at becomes `appliedAtMs` when given, otherwise now
   * for status 'applied' and null for other statuses. Returns updated row.
   */
  changeSetStatus(id: string, status: CodeChangeStatus, appliedAtMs?: number): CodeChange | null
}

interface CodeProjectRow {
  id: string
  path: string
  name: string
  approved_at: number
  last_opened_at: number | null
}

interface CodeChangeRow {
  id: string
  project_id: string
  conversation_id: string | null
  file_path: string
  change_type: string
  diff: string
  new_content: string | null
  old_content: string | null
  status: string
  created_at: number
  applied_at: number | null
}

type CodeChangeListRow = Omit<CodeChangeRow, 'new_content' | 'old_content'>

/** Review-queue window — an old project accumulates changes without bound. */
const CHANGES_LIST_LIMIT = 200

function toCodeProject(row: CodeProjectRow): CodeProject {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    approvedAt: row.approved_at,
    lastOpenedAt: row.last_opened_at,
  }
}

function toCodeChange(row: CodeChangeRow): CodeChange {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    filePath: row.file_path,
    changeType: row.change_type as CodeChangeType,
    diff: row.diff,
    newContent: row.new_content,
    oldContent: row.old_content,
    status: row.status as CodeChangeStatus,
    createdAt: row.created_at,
    appliedAt: row.applied_at,
  }
}

export function createCodeRepository(driver: SqliteDriver): CodeRepository {
  const projectGetById = (id: string): CodeProject | null => {
    const row = driver.get<CodeProjectRow>('SELECT * FROM code_projects WHERE id = ?', [id])
    return row ? toCodeProject(row) : null
  }

  const changeGet = (id: string): CodeChange | null => {
    const row = driver.get<CodeChangeRow>('SELECT * FROM code_changes WHERE id = ?', [id])
    return row ? toCodeChange(row) : null
  }

  return {
    projectsList() {
      const rows = driver.all<CodeProjectRow>(
        'SELECT * FROM code_projects ORDER BY COALESCE(last_opened_at, approved_at) DESC'
      )
      return rows.map(toCodeProject)
    },

    projectGetById,

    projectUpsertByPath(path, name) {
      const now = Date.now()
      const existing = driver.get<CodeProjectRow>(
        'SELECT * FROM code_projects WHERE path = ?',
        [path]
      )
      if (existing) {
        driver.run('UPDATE code_projects SET name = ?, last_opened_at = ? WHERE id = ?', [
          name,
          now,
          existing.id,
        ])
        return { ...toCodeProject(existing), name, lastOpenedAt: now }
      }
      const project: CodeProject = {
        id: randomUUID(),
        path,
        name,
        approvedAt: now,
        lastOpenedAt: now,
      }
      driver.run(
        `INSERT INTO code_projects (id, path, name, approved_at, last_opened_at)
         VALUES (?, ?, ?, ?, ?)`,
        [project.id, project.path, project.name, project.approvedAt, project.lastOpenedAt]
      )
      return project
    },

    projectForget(id) {
      // code_changes cascade via FK.
      driver.run('DELETE FROM code_projects WHERE id = ?', [id])
    },

    changesList(projectId) {
      const rows = driver.all<CodeChangeListRow>(
        `SELECT id, project_id, conversation_id, file_path, change_type, diff,
                status, created_at, applied_at
           FROM code_changes WHERE project_id = ?
          ORDER BY created_at DESC LIMIT ?`,
        [projectId, CHANGES_LIST_LIMIT]
      )
      return rows.map((row) => toCodeChange({ ...row, new_content: null, old_content: null }))
    },

    changeCreate(input) {
      const change: CodeChange = {
        id: randomUUID(),
        projectId: input.projectId,
        conversationId: input.conversationId,
        filePath: input.filePath,
        changeType: input.changeType,
        diff: input.diff,
        newContent: input.newContent,
        oldContent: input.oldContent,
        status: 'proposed',
        createdAt: Date.now(),
        appliedAt: null,
      }
      driver.run(
        `INSERT INTO code_changes
           (id, project_id, conversation_id, file_path, change_type, diff,
            new_content, old_content, status, created_at, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          change.id,
          change.projectId,
          change.conversationId,
          change.filePath,
          change.changeType,
          change.diff,
          change.newContent,
          change.oldContent ?? null,
          change.status,
          change.createdAt,
          change.appliedAt,
        ]
      )
      return change
    },

    changeGet,

    changeSetStatus(id, status, appliedAtMs) {
      const appliedAt = appliedAtMs ?? (status === 'applied' ? Date.now() : null)
      driver.run('UPDATE code_changes SET status = ?, applied_at = ? WHERE id = ?', [
        status,
        appliedAt,
        id,
      ])
      return changeGet(id)
    },
  }
}
