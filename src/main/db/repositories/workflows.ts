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
  WorkflowRunListItem,
  WorkflowSchedule,
} from '@shared/types'
import { WORKFLOW_RUN_SNIPPET_MAX } from '@shared/workflow-status'
import type { SqliteDriver } from '../driver'
import { parseJson, updateById } from './util'

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
  /**
   * Patch: a field left undefined keeps its stored value (omitting
   * `webhookEnabled` must never revoke a workflow's trigger opt-in), while an
   * explicit null/false still clears it.
   */
  update(id: string, patch: Partial<WorkflowInput>): Workflow | null
  remove(id: string): void
  /** Workflows whose schedule is enabled and configured. */
  listScheduled(): Workflow[]
  /**
   * Schedule fields only, for due-time math (the scheduler runs this on every
   * wake): skips decoding the potentially large graph_json per row. Rows are
   * filtered to schedule_enabled = 1, hence the constant.
   */
  listScheduledLite(): Array<{
    id: string
    schedule: WorkflowSchedule
    scheduleEnabled: true
    lastRunAt: number | null
    updatedAt: number
  }>
  /** Records that a run started (drives the scheduler's due check). */
  touchLastRun(id: string, startedAtMs: number): void
  /** Persists a finished run and prunes history beyond the per-workflow cap. */
  insertRun(input: WorkflowRunInput): WorkflowRun
  listRuns(workflowId: string, limit?: number): WorkflowRun[]
  /**
   * The single most recent run of each workflow that has any (output/error
   * truncated to the list snippet cap) — the overview's latest-status source.
   */
  latestRunsPerWorkflow(): WorkflowRun[]
  /** Recent runs across ALL workflows joined with their names, newest first. */
  listRecentRunsWithNames(limit?: number): WorkflowRunListItem[]
}

interface WorkflowRow {
  id: string
  name: string
  graph_json: string
  schedule_json: string | null
  schedule_enabled: number
  webhook_enabled: number
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

/** "HH:MM", 24-hour. */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * Reads a stored schedule. Rows written before v33 hold the bare
 * `{everyMinutes}` shape with no `kind`, so an untagged object with a valid
 * interval is read back as an interval schedule — an old workflow keeps firing
 * exactly as it did, without a data migration.
 */
function parseSchedule(text: string | null): WorkflowSchedule | null {
  const v = parseJson<unknown>(text ?? null, undefined)
  if (!v || typeof v !== 'object') return null
  const raw = v as Partial<WorkflowSchedule> & { everyMinutes?: unknown; kind?: unknown }

  if (raw.kind === 'calendar') {
    const time = typeof raw.time === 'string' && TIME_PATTERN.test(raw.time) ? raw.time : null
    if (!time) return null
    const days = Array.isArray(raw.days)
      ? [...new Set(raw.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))]
          .sort((a, b) => a - b)
      : []
    return { kind: 'calendar', days, time }
  }

  // 'interval', or a pre-v33 row with no kind at all.
  const every = raw.everyMinutes
  if (typeof every === 'number' && Number.isFinite(every) && every >= 1) {
    return { kind: 'interval', everyMinutes: Math.floor(every) }
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
    webhookEnabled: row.webhook_enabled === 1,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Patch encoders for updateById: undefined leaves the column untouched. */
function scheduleColumn(schedule: WorkflowSchedule | null | undefined): string | null | undefined {
  if (schedule === undefined) return undefined
  return schedule ? JSON.stringify(schedule) : null
}

function flagColumn(value: boolean | undefined): number | undefined {
  return value === undefined ? undefined : value ? 1 : 0
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
        webhookEnabled: input.webhookEnabled === true,
        lastRunAt: null,
        createdAt: now,
        updatedAt: now,
      }
      driver.run(
        `INSERT INTO workflows
           (id, name, graph_json, schedule_json, schedule_enabled, webhook_enabled,
            last_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workflow.id,
          workflow.name,
          JSON.stringify(workflow.graph),
          workflow.schedule ? JSON.stringify(workflow.schedule) : null,
          workflow.scheduleEnabled ? 1 : 0,
          workflow.webhookEnabled ? 1 : 0,
          null,
          now,
          now,
        ]
      )
      return workflow
    },

    update(id, patch) {
      updateById(
        driver,
        'workflows',
        id,
        {
          name: patch.name,
          graph_json: patch.graph === undefined ? undefined : JSON.stringify(patch.graph),
          schedule_json: scheduleColumn(patch.schedule),
          schedule_enabled: flagColumn(patch.scheduleEnabled),
          webhook_enabled: flagColumn(patch.webhookEnabled),
        },
        { touchUpdatedAt: true }
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

    listScheduledLite() {
      const rows = driver.all<
        Pick<WorkflowRow, 'id' | 'schedule_json' | 'last_run_at' | 'updated_at'>
      >(
        'SELECT id, schedule_json, last_run_at, updated_at FROM workflows WHERE schedule_enabled = 1 AND schedule_json IS NOT NULL'
      )
      const result: Array<{
        id: string
        schedule: WorkflowSchedule
        scheduleEnabled: true
        lastRunAt: number | null
        updatedAt: number
      }> = []
      for (const row of rows) {
        const schedule = parseSchedule(row.schedule_json)
        if (schedule === null) continue
        result.push({
          id: row.id,
          schedule,
          scheduleEnabled: true,
          lastRunAt: row.last_run_at ?? null,
          updatedAt: row.updated_at,
        })
      }
      return result
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

    latestRunsPerWorkflow() {
      return driver
        .all<WorkflowRunRow>(
          `SELECT id, workflow_id, trigger, status,
                  substr(output, 1, ?) AS output,
                  substr(error, 1, ?) AS error,
                  started_at, finished_at
           FROM (
             SELECT r.*,
                    ROW_NUMBER() OVER (
                      PARTITION BY workflow_id ORDER BY started_at DESC, id DESC
                    ) AS rn
             FROM workflow_runs r
           )
           WHERE rn = 1`,
          [WORKFLOW_RUN_SNIPPET_MAX, WORKFLOW_RUN_SNIPPET_MAX]
        )
        .map(toRun)
    },

    listRecentRunsWithNames(limit = 20) {
      return driver
        .all<WorkflowRunRow & { workflow_name: string }>(
          `SELECT r.id, r.workflow_id, r.trigger, r.status,
                  substr(r.output, 1, ?) AS output,
                  substr(r.error, 1, ?) AS error,
                  r.started_at, r.finished_at,
                  w.name AS workflow_name
           FROM workflow_runs r
           JOIN workflows w ON w.id = r.workflow_id
           ORDER BY r.started_at DESC, r.id DESC
           LIMIT ?`,
          [
            WORKFLOW_RUN_SNIPPET_MAX,
            WORKFLOW_RUN_SNIPPET_MAX,
            Math.max(1, Math.min(limit, MAX_RUNS_PER_WORKFLOW)),
          ]
        )
        .map((row) => ({ ...toRun(row), workflowName: row.workflow_name }))
    },
  }
}
