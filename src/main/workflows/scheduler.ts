/**
 * Scheduler for workflows with a recurring trigger. Two kinds (see nextDueAt):
 * an INTERVAL schedule fires every N minutes since the last run, a CALENDAR one
 * fires at a wall-clock time on chosen weekdays. lastRunAt survives restarts via
 * the workflows table, so a slot missed while the app was closed runs ONCE at
 * the next opportunity instead of being replayed for every occurrence slept
 * through. Per-workflow concurrency is guarded by the runner.
 */

import type { Workflow } from '@shared/types'
import { nextRunAt } from '@shared/workflow-status'
import type { AppDatabase } from '../db/database'
import type { WorkflowRunner } from './runner'
import { ScheduledRunQueue } from '../scheduling/run-queue'

const MAX_WAKE_MS = 60_000

export interface WorkflowSchedulerDeps {
  db: AppDatabase
  runner: WorkflowRunner
  onError?: (workflowId: string, error: unknown) => void
  queue?: ScheduledRunQueue
}

/**
 * Pure due check (exported for tests). The "when" lives in @shared's
 * `nextRunAt` so the scheduler and every UI label read from one definition —
 * a workflow that says "in 25m" in the sidebar has to be the workflow that
 * fires in 25 minutes. A missed slot runs ONCE at the next opportunity: the
 * app catches up, it does not replay every occurrence it slept through.
 */
export function isDue(workflow: Workflow, now: number): boolean {
  const at = nextRunAt(workflow, now)
  return at !== null && at <= now
}

export class WorkflowScheduler {
  private timer: NodeJS.Timeout | null = null
  private readonly queue: ScheduledRunQueue
  /** A run lasts up to WORKFLOW_RUN_TIMEOUT_MS; ticks must never overlap. */
  private ticking = false
  private started = false

  constructor(private readonly deps: WorkflowSchedulerDeps) {
    this.queue = deps.queue ?? new ScheduledRunQueue()
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.wake()
  }

  /** Recomputes the next one-shot wake after schedule mutations and runs. */
  wake(): void {
    if (!this.started) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.ticking) return
    const now = Date.now()
    let next = now + MAX_WAKE_MS
    try {
      for (const workflow of this.deps.db.workflows.listScheduled()) {
        if (isDue(workflow, now)) {
          next = now
          break
        }
        const due = nextRunAt(workflow, now)
        if (due !== null) next = Math.min(next, due)
      }
    } catch {
      // Retry on the fallback wake.
    }
    const delay = Math.min(MAX_WAKE_MS, Math.max(0, next - now))
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, delay)
    this.timer.unref?.()
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.runDue(now)
    } finally {
      this.ticking = false
      this.wake()
    }
  }

  private async runDue(now: number): Promise<void> {
    let due: Workflow[]
    try {
      due = this.deps.db.workflows.listScheduled().filter((w) => isDue(w, now))
    } catch {
      return
    }
    const jobs = due.map((workflow) =>
      this.queue.enqueue(`workflow:${workflow.id}`, async () => {
        // Queue wait can be long: re-check the current row immediately before launch.
        const fresh = this.deps.db.workflows.getById(workflow.id)
        if (!fresh || !isDue(fresh, Math.max(now, Date.now()))) return
        try {
          await this.deps.runner.runById(fresh.id, 'schedule')
        } catch (e) {
          this.deps.onError?.(workflow.id, e)
        }
      })
    )
    await Promise.allSettled(jobs)
  }

  stop(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
