import { randomUUID } from 'node:crypto'
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskStatus,
} from '@shared/types'
import type { SqliteDriver } from '../driver'

interface ScheduledTaskRow {
  id: string
  title: string
  prompt: string
  recurrence: ScheduledTask['recurrence']
  next_run_at: number | null
  enabled: number
  approved_tools_json: string
  project_id: string | null
  agent_id: string | null
  budget_usd: number | null
  webhook_url: string | null
  last_run_at: number | null
  last_status: ScheduledTaskStatus
  last_output: string
  last_error: string | null
  created_at: number
  updated_at: number
}

function parseApprovedTools(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function toTask(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    recurrence: row.recurrence,
    nextRunAt: row.next_run_at,
    enabled: row.enabled === 1,
    approvedToolIds: parseApprovedTools(row.approved_tools_json),
    projectId: row.project_id,
    agentId: row.agent_id,
    budgetUsd: row.budget_usd ?? null,
    webhookUrl: row.webhook_url ?? null,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastOutput: row.last_output,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface ScheduledTasksRepository {
  list(): ScheduledTask[]
  getById(id: string): ScheduledTask | null
  create(input: ScheduledTaskInput): ScheduledTask
  setEnabled(id: string, enabled: boolean): ScheduledTask | null
  /** Sets/clears the task's monthly spend cap (USD). */
  setBudget(id: string, budgetUsd: number | null): ScheduledTask | null
  remove(id: string): void
  deleteAll(): void
  listDue(now: number): ScheduledTask[]
  nextEnabledRunAt(): number | null
  markRunning(id: string, startedAt: number): void
  finish(
    id: string,
    input: {
      status: 'ok' | 'error'
      output: string
      error: string | null
      nextRunAt: number | null
      enabled: boolean
      finishedAt: number
    }
  ): void
}

export function createScheduledTasksRepository(driver: SqliteDriver): ScheduledTasksRepository {
  const getById = (id: string): ScheduledTask | null => {
    const row = driver.get<ScheduledTaskRow>('SELECT * FROM scheduled_tasks WHERE id = ?', [id])
    return row ? toTask(row) : null
  }

  return {
    list() {
      return driver
        .all<ScheduledTaskRow>(
          `SELECT * FROM scheduled_tasks
           ORDER BY enabled DESC, next_run_at IS NULL, next_run_at ASC, updated_at DESC`
        )
        .map(toTask)
    },

    getById,

    create(input) {
      const now = Date.now()
      const task: ScheduledTask = {
        id: randomUUID(),
        title: input.title,
        prompt: input.prompt,
        recurrence: input.recurrence,
        nextRunAt: input.runAt,
        enabled: true,
        approvedToolIds: input.approvedToolIds ?? [],
        projectId: input.projectId ?? null,
        agentId: input.agentId ?? null,
        // Not in the INSERT below — the column defaults to NULL; caps are set
        // after creation via setBudget.
        budgetUsd: null,
        webhookUrl: input.webhookUrl ?? null,
        lastRunAt: null,
        lastStatus: 'idle',
        lastOutput: '',
        lastError: null,
        createdAt: now,
        updatedAt: now,
      }
      driver.run(
        `INSERT INTO scheduled_tasks
           (id, title, prompt, recurrence, next_run_at, enabled, approved_tools_json,
            project_id, agent_id, webhook_url, last_run_at, last_status, last_output, last_error,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, 'idle', '', NULL, ?, ?)`,
        [
          task.id,
          task.title,
          task.prompt,
          task.recurrence,
          task.nextRunAt,
          JSON.stringify(task.approvedToolIds),
          task.projectId,
          task.agentId,
          task.webhookUrl ?? null,
          now,
          now,
        ]
      )
      return task
    },

    setEnabled(id, enabled) {
      driver.run('UPDATE scheduled_tasks SET enabled = ?, updated_at = ? WHERE id = ?', [
        enabled ? 1 : 0,
        Date.now(),
        id,
      ])
      return getById(id)
    },

    setBudget(id, budgetUsd) {
      driver.run('UPDATE scheduled_tasks SET budget_usd = ?, updated_at = ? WHERE id = ?', [
        budgetUsd,
        Date.now(),
        id,
      ])
      return getById(id)
    },

    remove(id) {
      driver.run('DELETE FROM scheduled_tasks WHERE id = ?', [id])
    },

    deleteAll() {
      driver.run('DELETE FROM scheduled_tasks')
    },

    listDue(now) {
      return driver
        .all<ScheduledTaskRow>(
          `SELECT * FROM scheduled_tasks
           WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
           ORDER BY next_run_at ASC`,
          [now]
        )
        .map(toTask)
    },

    nextEnabledRunAt() {
      const row = driver.get<{ next_run_at: number | null }>(
        `SELECT MIN(next_run_at) AS next_run_at FROM scheduled_tasks
         WHERE enabled = 1 AND next_run_at IS NOT NULL`
      )
      return row?.next_run_at ?? null
    },

    markRunning(id, startedAt) {
      driver.run(
        `UPDATE scheduled_tasks
         SET last_run_at = ?, last_status = 'running', last_error = NULL, updated_at = ?
         WHERE id = ?`,
        [startedAt, startedAt, id]
      )
    },

    finish(id, input) {
      driver.run(
        `UPDATE scheduled_tasks
         SET last_status = ?, last_output = ?, last_error = ?, next_run_at = ?,
             enabled = ?, updated_at = ?
         WHERE id = ?`,
        [
          input.status,
          input.output,
          input.error,
          input.nextRunAt,
          input.enabled ? 1 : 0,
          input.finishedAt,
          id,
        ]
      )
    },
  }
}
