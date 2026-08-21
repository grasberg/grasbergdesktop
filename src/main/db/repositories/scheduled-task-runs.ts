/**
 * Run history for standalone scheduled tasks (migration v33), mirroring
 * workflow_runs. The task row itself only carries its LAST outcome, so without
 * this a task that started failing days ago was invisible unless someone read
 * the inbox that day.
 *
 * History is capped per task (MAX_RUNS_PER_TASK, matching what the workflow
 * side keeps) and pruned on insert.
 */

import { randomUUID } from 'node:crypto'
import type { ScheduledTaskRun } from '@shared/types'
import type { SqliteDriver } from '../driver'

/** Runs kept per task; older ones are pruned as new ones land. */
export const MAX_RUNS_PER_TASK = 20

export type ScheduledTaskRunInput = Omit<ScheduledTaskRun, 'id'>

export interface ScheduledTaskRunsRepository {
  insert(input: ScheduledTaskRunInput): ScheduledTaskRun
  /** Newest first. */
  list(taskId: string, limit?: number): ScheduledTaskRun[]
}

interface ScheduledTaskRunRow {
  id: string
  task_id: string
  status: ScheduledTaskRun['status']
  output: string
  error: string | null
  started_at: number
  finished_at: number
  catch_up: number
}

function toRun(row: ScheduledTaskRunRow): ScheduledTaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    output: row.output,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    catchUp: row.catch_up === 1,
  }
}

export function createScheduledTaskRunsRepository(
  driver: SqliteDriver
): ScheduledTaskRunsRepository {
  return {
    insert(input) {
      const run: ScheduledTaskRun = { id: randomUUID(), ...input }
      driver.run(
        `INSERT INTO scheduled_task_runs
           (id, task_id, status, output, error, started_at, finished_at, catch_up)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          run.id,
          run.taskId,
          run.status,
          run.output,
          run.error,
          run.startedAt,
          run.finishedAt,
          run.catchUp ? 1 : 0,
        ]
      )
      driver.run(
        `DELETE FROM scheduled_task_runs
         WHERE task_id = ? AND rowid NOT IN (
           SELECT rowid FROM scheduled_task_runs
           WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?
         )`,
        [run.taskId, run.taskId, MAX_RUNS_PER_TASK]
      )
      return run
    },

    list(taskId, limit = MAX_RUNS_PER_TASK) {
      return driver
        .all<ScheduledTaskRunRow>(
          `SELECT * FROM scheduled_task_runs
           WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`,
          [taskId, Math.min(Math.max(1, Math.floor(limit)), MAX_RUNS_PER_TASK)]
        )
        .map(toRun)
    },
  }
}
