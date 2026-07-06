/**
 * Workflow storage (migrations v10 + v20). The node graph is serialized JSON;
 * the engine (src/main/workflows/engine.ts) interprets it. v20 adds recurring
 * schedules and a persisted run history (workflow_runs).
 */

import { randomUUID } from 'node:crypto'
import type {
  Workflow,
  WorkflowGraph,
  WorkflowInput,
  WorkflowRun,
  WorkflowSchedule,
} from '@shared/types'
import type { SqliteDriver } from '../driver'
import { parseJson } from './util'

const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [] }

/** Runs kept per workflow; older ones are pruned on insert. */
const MAX_RUNS_PER_WORKFLOW = 50

export interface WorkflowRunInput {
  workflowId: string
  trigger: WorkflowRun['trigger']
  status: WorkflowRun['status']
  output: string
  error: string | null
  startedAt: number
  finishedAt: number
}

export interface WorkflowsRepository {
  list(): Workflow[]
  getById(id: string): Workflow | null
  create(input: WorkflowInput): Workflow
  update(id: string, input: WorkflowInput): Workflow | null
  remove(id: string): void
  /** Workflows whose schedule is enabled and configured. */
  listScheduled(): Workflow[]
  /** Records that a run started (drives the scheduler's due check). */
  touchLastRun(id: string, startedAtMs: number): void
  /** Persists a finished run and prunes history beyond the per-workflow cap. */
  insertRun(input: WorkflowRunInput): WorkflowRun
  listRuns(workflowId: string, limit?: number): WorkflowRun[]
}

interface WorkflowRow {
  id: string
  name: string
  graph_json: string
  schedule_json: string | null
  schedule_enabled: number
  last_run_at: number | null
  created_at: number
  updated_at: number
}

interface WorkflowRunRow {
  id: string
  workflow_id: string
  trigger: string
  status: string
  output: string
  error: string | null
  started_at: number
  finished_at: number
}

function parseGraph(text: string): WorkflowGraph {
  const v = parseJson<unknown>(text, undefined)
  if (v && typeof v === 'object' && Array.isArray((v as WorkflowGraph).nodes)) {
    const g = v as WorkflowGraph
    return { nodes: g.nodes ?? [], edges: Array.isArray(g.edges) ? g.edges : [] }
  }
  return { ...EMPTY_GRAPH }
}

function parseSchedule(text: string | null): WorkflowSchedule | null {
  const v = parseJson<unknown>(text ?? null, undefined)
  if (
    v &&
    typeof v === 'object' &&
    typeof (v as WorkflowSchedule).everyMinutes === 'number' &&
    (v as WorkflowSchedule).everyMinutes >= 1
  ) {
    return { everyMinutes: Math.floor((v as WorkflowSchedule).everyMinutes) }
  }
  return null
}

function toWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    name: row.name,
    graph: parseGraph(row.graph_json),
    schedule: parseSchedule(row.schedule_json),
    scheduleEnabled: row.schedule_enabled === 1,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    trigger: row.trigger as WorkflowRun['trigger'],
    status: row.status as WorkflowRun['status'],
    output: row.output,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
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
        schedule: input.schedule ?? null,
        scheduleEnabled: input.scheduleEnabled === true,
        lastRunAt: null,
        createdAt: now,
        updatedAt: now,
      }
      driver.run(
        `INSERT INTO workflows
           (id, name, graph_json, schedule_json, schedule_enabled, last_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workflow.id,
          workflow.name,
          JSON.stringify(workflow.graph),
          workflow.schedule ? JSON.stringify(workflow.schedule) : null,
          workflow.scheduleEnabled ? 1 : 0,
          null,
          now,
          now,
        ]
      )
      return workflow
    },

    update(id, input) {
      driver.run(
        `UPDATE workflows
           SET name = ?, graph_json = ?, schedule_json = ?, schedule_enabled = ?, updated_at = ?
         WHERE id = ?`,
        [
          input.name,
          JSON.stringify(input.graph ?? EMPTY_GRAPH),
          input.schedule ? JSON.stringify(input.schedule) : null,
          input.scheduleEnabled === true ? 1 : 0,
          Date.now(),
          id,
        ]
      )
      return getById(id)
    },

    remove(id) {
      driver.run('DELETE FROM workflows WHERE id = ?', [id])
    },

    listScheduled() {
      return driver
        .all<WorkflowRow>(
          'SELECT * FROM workflows WHERE schedule_enabled = 1 AND schedule_json IS NOT NULL'
        )
        .map(toWorkflow)
        .filter((w) => w.schedule !== null)
    },

    touchLastRun(id, startedAtMs) {
      driver.run('UPDATE workflows SET last_run_at = ? WHERE id = ?', [startedAtMs, id])
    },

    insertRun(input) {
      const run: WorkflowRun = { id: randomUUID(), ...input, error: input.error ?? null }
      driver.run(
        `INSERT INTO workflow_runs
           (id, workflow_id, trigger, status, output, error, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          run.id,
          run.workflowId,
          run.trigger,
          run.status,
          run.output,
          run.error,
          run.startedAt,
          run.finishedAt,
        ]
      )
      driver.run(
        `DELETE FROM workflow_runs
         WHERE workflow_id = ?
           AND id NOT IN (
             SELECT id FROM workflow_runs WHERE workflow_id = ?
             ORDER BY started_at DESC LIMIT ?
           )`,
        [run.workflowId, run.workflowId, MAX_RUNS_PER_WORKFLOW]
      )
      return run
    },

    listRuns(workflowId, limit = 20) {
      return driver
        .all<WorkflowRunRow>(
          'SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?',
          [workflowId, Math.max(1, Math.min(limit, MAX_RUNS_PER_WORKFLOW))]
        )
        .map(toRun)
    },
  }
}
