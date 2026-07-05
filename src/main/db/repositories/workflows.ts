/**
 * Workflow storage (migration v10). The node graph is serialized JSON; the
 * engine (src/main/workflows/engine.ts) interprets it.
 */

import { randomUUID } from 'node:crypto'
import type { Workflow, WorkflowGraph, WorkflowInput } from '@shared/types'
import type { SqliteDriver } from '../driver'
import { parseJson } from './util'

const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [] }

export interface WorkflowsRepository {
  list(): Workflow[]
  getById(id: string): Workflow | null
  create(input: WorkflowInput): Workflow
  update(id: string, input: WorkflowInput): Workflow | null
  remove(id: string): void
}

interface WorkflowRow {
  id: string
  name: string
  graph_json: string
  created_at: number
  updated_at: number
}

function parseGraph(text: string): WorkflowGraph {
  const v = parseJson<unknown>(text, undefined)
  if (v && typeof v === 'object' && Array.isArray((v as WorkflowGraph).nodes)) {
    const g = v as WorkflowGraph
    return { nodes: g.nodes ?? [], edges: Array.isArray(g.edges) ? g.edges : [] }
  }
  return { ...EMPTY_GRAPH }
}

function toWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    name: row.name,
    graph: parseGraph(row.graph_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createWorkflowsRepository(driver: SqliteDriver): WorkflowsRepository {
  const getById = (id: string): Workflow | null => {
    const row = driver.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', [id])
    return row ? toWorkflow(row) : null
  }

  return {
    list() {
      return driver
        .all<WorkflowRow>('SELECT * FROM workflows ORDER BY updated_at DESC')
        .map(toWorkflow)
    },

    getById,

    create(input) {
      const now = Date.now()
      const workflow: Workflow = {
        id: randomUUID(),
        name: input.name,
        graph: input.graph ?? { ...EMPTY_GRAPH },
        createdAt: now,
        updatedAt: now,
      }
      driver.run(
        'INSERT INTO workflows (id, name, graph_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [workflow.id, workflow.name, JSON.stringify(workflow.graph), now, now]
      )
      return workflow
    },

    update(id, input) {
      driver.run('UPDATE workflows SET name = ?, graph_json = ?, updated_at = ? WHERE id = ?', [
        input.name,
        JSON.stringify(input.graph ?? EMPTY_GRAPH),
        Date.now(),
        id,
      ])
      return getById(id)
    },

    remove(id) {
      driver.run('DELETE FROM workflows WHERE id = ?', [id])
    },
  }
}
