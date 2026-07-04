/**
 * Cowork workspaces + workspace items.
 */

import { randomUUID } from 'node:crypto'
import type { Workspace, WorkspaceItem, WorkspaceItemKind } from '@shared/types'
import type { SqliteDriver, SqlValue } from '../driver'

export interface WorkspaceCreateInput {
  name: string
  goal?: string | null
}

export type WorkspacePatch = Partial<Pick<Workspace, 'name' | 'goal' | 'status'>>

export interface WorkspaceItemCreateInput {
  workspaceId: string
  kind: WorkspaceItemKind
  title: string
  content?: string
  /** Defaults to 'todo' for kind 'task', null otherwise. */
  status?: 'todo' | 'doing' | 'done' | null
  /** Defaults to max(sort)+1 within the workspace. */
  sort?: number
  origin: 'user' | 'assistant'
}

export type WorkspaceItemPatch = Partial<
  Pick<WorkspaceItem, 'title' | 'content' | 'status' | 'sort' | 'kind'>
>

export interface WorkspacesRepository {
  list(): Workspace[]
  /** Generates the id (crypto.randomUUID) and timestamps. */
  create(input: WorkspaceCreateInput): Workspace
  getById(id: string): Workspace | null
  update(id: string, patch: WorkspacePatch): Workspace | null
  remove(id: string): void
  itemsList(workspaceId: string): WorkspaceItem[]
  /** Generates the id (crypto.randomUUID) and timestamps. */
  itemCreate(input: WorkspaceItemCreateInput): WorkspaceItem
  itemUpdate(id: string, patch: WorkspaceItemPatch): WorkspaceItem | null
  itemDelete(id: string): void
}

interface WorkspaceRow {
  id: string
  name: string
  goal: string | null
  status: string
  created_at: number
  updated_at: number
}

interface WorkspaceItemRow {
  id: string
  workspace_id: string
  kind: string
  title: string
  content: string
  status: string | null
  sort: number
  origin: string
  created_at: number
  updated_at: number
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    status: row.status as Workspace['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toWorkspaceItem(row: WorkspaceItemRow): WorkspaceItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind as WorkspaceItemKind,
    title: row.title,
    content: row.content,
    status: row.status as WorkspaceItem['status'],
    sort: row.sort,
    origin: row.origin as WorkspaceItem['origin'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createWorkspacesRepository(driver: SqliteDriver): WorkspacesRepository {
  const getById = (id: string): Workspace | null => {
    const row = driver.get<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', [id])
    return row ? toWorkspace(row) : null
  }

  const itemGetById = (id: string): WorkspaceItem | null => {
    const row = driver.get<WorkspaceItemRow>('SELECT * FROM workspace_items WHERE id = ?', [id])
    return row ? toWorkspaceItem(row) : null
  }

  return {
    list() {
      const rows = driver.all<WorkspaceRow>(
        'SELECT * FROM workspaces ORDER BY updated_at DESC'
      )
      return rows.map(toWorkspace)
    },

    create(input) {
      const now = Date.now()
      const workspace: Workspace = {
        id: randomUUID(),
        name: input.name,
        goal: input.goal ?? null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }
      driver.run(
        `INSERT INTO workspaces (id, name, goal, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [workspace.id, workspace.name, workspace.goal, workspace.status, now, now]
      )
      return workspace
    },

    getById,

    update(id, patch) {
      const sets: string[] = []
      const params: SqlValue[] = []
      if (patch.name !== undefined) {
        sets.push('name = ?')
        params.push(patch.name)
      }
      if (patch.goal !== undefined) {
        sets.push('goal = ?')
        params.push(patch.goal)
      }
      if (patch.status !== undefined) {
        sets.push('status = ?')
        params.push(patch.status)
      }
      if (sets.length > 0) {
        sets.push('updated_at = ?')
        params.push(Date.now(), id)
        driver.run(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`, params)
      }
      return getById(id)
    },

    remove(id) {
      // Items cascade via FK.
      driver.run('DELETE FROM workspaces WHERE id = ?', [id])
    },

    itemsList(workspaceId) {
      const rows = driver.all<WorkspaceItemRow>(
        'SELECT * FROM workspace_items WHERE workspace_id = ? ORDER BY sort ASC, created_at ASC',
        [workspaceId]
      )
      return rows.map(toWorkspaceItem)
    },

    itemCreate(input) {
      const now = Date.now()
      let sort = input.sort
      if (sort === undefined) {
        const row = driver.get<{ next: number }>(
          'SELECT COALESCE(MAX(sort), 0) + 1 AS next FROM workspace_items WHERE workspace_id = ?',
          [input.workspaceId]
        )
        sort = row ? row.next : 1
      }
      const item: WorkspaceItem = {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        kind: input.kind,
        title: input.title,
        content: input.content ?? '',
        status: input.status !== undefined ? input.status : input.kind === 'task' ? 'todo' : null,
        sort,
        origin: input.origin,
        createdAt: now,
        updatedAt: now,
      }
      driver.run(
        `INSERT INTO workspace_items
           (id, workspace_id, kind, title, content, status, sort, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          item.workspaceId,
          item.kind,
          item.title,
          item.content,
          item.status,
          item.sort,
          item.origin,
          now,
          now,
        ]
      )
      return item
    },

    itemUpdate(id, patch) {
      const sets: string[] = []
      const params: SqlValue[] = []
      if (patch.title !== undefined) {
        sets.push('title = ?')
        params.push(patch.title)
      }
      if (patch.content !== undefined) {
        sets.push('content = ?')
        params.push(patch.content)
      }
      if (patch.status !== undefined) {
        sets.push('status = ?')
        params.push(patch.status)
      }
      if (patch.sort !== undefined) {
        sets.push('sort = ?')
        params.push(patch.sort)
      }
      if (patch.kind !== undefined) {
        sets.push('kind = ?')
        params.push(patch.kind)
      }
      if (sets.length > 0) {
        sets.push('updated_at = ?')
        params.push(Date.now(), id)
        driver.run(`UPDATE workspace_items SET ${sets.join(', ')} WHERE id = ?`, params)
      }
      return itemGetById(id)
    },

    itemDelete(id) {
      driver.run('DELETE FROM workspace_items WHERE id = ?', [id])
    },
  }
}
