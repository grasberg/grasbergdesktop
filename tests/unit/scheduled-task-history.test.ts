/**
 * Run history for scheduled tasks, and the honesty that goes with it: a slot
 * missed while Grasberg was closed runs ONCE at the next opportunity, and the
 * recorded run says it ran late rather than implying the schedule was kept.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { ScheduledTaskScheduler } from '../../src/main/scheduled-tasks/scheduler'
import { MAX_RUNS_PER_TASK } from '../../src/main/db/repositories/scheduled-task-runs'

let dir: string
let db: AppDatabase

const MIN = 60_000
const HOUR = 60 * MIN

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-task-history-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
})

function makeTask(overrides: Partial<{ runAt: number; recurrence: ScheduledTask['recurrence'] }> = {}): ScheduledTask {
  return db.scheduledTasks.create({
    title: 'Nightly summary',
    prompt: 'Summarize the day',
    recurrence: overrides.recurrence ?? 'hourly',
    runAt: overrides.runAt ?? Date.now() - MIN,
  })
}

function scheduler(run: (task: ScheduledTask) => Promise<string>): ScheduledTaskScheduler {
  return new ScheduledTaskScheduler({ db, run })
}

describe('scheduled-task run history', () => {
  it('records a successful run with its output', async () => {
    const task = makeTask()
    await scheduler(async () => 'all quiet').tick()

    const runs = db.scheduledTaskRuns.list(task.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'ok', output: 'all quiet', error: null })
    expect(runs[0].finishedAt).toBeGreaterThanOrEqual(runs[0].startedAt)
  })

  it('records a failed run with its error, and keeps the task scheduled', async () => {
    const task = makeTask()
    await scheduler(async () => {
      throw new Error('the provider timed out')
    }).tick()

    const runs = db.scheduledTaskRuns.list(task.id)
    expect(runs[0]).toMatchObject({ status: 'error' })
    expect(runs[0].error).toContain('timed out')
    // An hourly task that failed is still hourly.
    expect(db.scheduledTasks.getById(task.id)?.nextRunAt).not.toBeNull()
  })

  it('keeps a history the task row cannot: several runs, newest first', async () => {
    const task = makeTask()
    const results = ['first', 'second', 'third']
    for (const result of results) {
      // Re-arm the task for another immediate run.
      db.driver.run('UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?', [
        Date.now() - MIN,
        task.id,
      ])
      await scheduler(async () => result).tick()
    }
    const runs = db.scheduledTaskRuns.list(task.id)
    expect(runs.map((r) => r.output)).toEqual(['third', 'second', 'first'])
    // The task row itself only ever remembers the last one — which is exactly
    // why the history exists.
    expect(db.scheduledTasks.getById(task.id)?.lastOutput).toBe('third')
  })

  it('flags a run that started late because the app was closed', async () => {
    // Due three hours ago: nothing was running when the slot came round.
    const task = makeTask({ runAt: Date.now() - 3 * HOUR })
    await scheduler(async () => 'caught up').tick()

    const [run] = db.scheduledTaskRuns.list(task.id)
    expect(run.catchUp).toBe(true)
  })

  it('does not flag a run that started on time', async () => {
    const task = makeTask({ runAt: Date.now() - 5_000 })
    await scheduler(async () => 'on time').tick()
    expect(db.scheduledTaskRuns.list(task.id)[0].catchUp).toBe(false)
  })

  it('runs a missed occurrence once, not once per slot slept through', async () => {
    // Hourly, last due three hours ago. One tick must produce ONE run, and the
    // next slot must be in the future rather than two more backlogged ones.
    const task = makeTask({ runAt: Date.now() - 3 * HOUR })
    const run = vi.fn(async () => 'caught up')
    await scheduler(run).tick()

    expect(run).toHaveBeenCalledTimes(1)
    expect(db.scheduledTaskRuns.list(task.id)).toHaveLength(1)
    const next = db.scheduledTasks.getById(task.id)?.nextRunAt
    expect(next).not.toBeNull()
    expect(next!).toBeGreaterThan(Date.now())
  })

  it('caps the history per task', () => {
    const task = makeTask()
    for (let i = 0; i < MAX_RUNS_PER_TASK + 5; i++) {
      db.scheduledTaskRuns.insert({
        taskId: task.id,
        status: 'ok',
        output: `run ${i}`,
        error: null,
        startedAt: 1000 + i,
        finishedAt: 1001 + i,
        catchUp: false,
      })
    }
    const runs = db.scheduledTaskRuns.list(task.id)
    expect(runs).toHaveLength(MAX_RUNS_PER_TASK)
    // The oldest were pruned, not the newest.
    expect(runs[0].output).toBe(`run ${MAX_RUNS_PER_TASK + 4}`)
  })

  it('history dies with its task', () => {
    const task = makeTask()
    db.scheduledTaskRuns.insert({
      taskId: task.id,
      status: 'ok',
      output: 'x',
      error: null,
      startedAt: 1,
      finishedAt: 2,
      catchUp: false,
    })
    db.scheduledTasks.remove(task.id)
    expect(db.scheduledTaskRuns.list(task.id)).toHaveLength(0)
  })
})
