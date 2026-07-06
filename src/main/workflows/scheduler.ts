/**
 * Interval scheduler for workflows with a recurring trigger: once a minute it
 * runs every enabled scheduled workflow whose interval has elapsed since its
 * last run (lastRunAt survives restarts via the workflows table). Runs are
 * sequential within a tick; per-workflow concurrency is guarded by the runner.
 */

import type { Workflow } from '@shared/types'
import type { AppDatabase } from '../db/database'
import type { WorkflowRunner } from './runner'

const TICK_MS = 60_000

export interface WorkflowSchedulerDeps {
  db: AppDatabase
  runner: WorkflowRunner
  onError?: (workflowId: string, error: unknown) => void
}

/** Pure due check (exported for tests). Never-run schedules are due at once. */
export function isDue(workflow: Workflow, now: number): boolean {
  if (!workflow.scheduleEnabled || !workflow.schedule) return false
  if (workflow.lastRunAt === null) return true
  return now - workflow.lastRunAt >= workflow.schedule.everyMinutes * 60_000
}

export class WorkflowScheduler {
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: WorkflowSchedulerDeps) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    // Never keep the process alive just for the scheduler.
    this.timer.unref?.()
    void this.tick()
  }

  async tick(now = Date.now()): Promise<void> {
    let due: Workflow[]
    try {
      due = this.deps.db.workflows.listScheduled().filter((w) => isDue(w, now))
    } catch {
      return
    }
    for (const workflow of due) {
      try {
        await this.deps.runner.runById(workflow.id, 'schedule')
      } catch (e) {
        this.deps.onError?.(workflow.id, e)
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
