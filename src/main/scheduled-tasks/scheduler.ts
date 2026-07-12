/** Clock scheduler for standalone prompt tasks (independent from workflows). */

import type { ScheduledTask, ScheduledTasksChangedEvent } from '@shared/types'
import type { AppDatabase } from '../db/database'
import { toNormalizedError } from '../providers/errors'
import { ScheduledRunQueue } from '../scheduling/run-queue'

const MAX_WAKE_MS = 60_000
const RESULT_LIMIT = 40_000

export interface ScheduledTaskSchedulerDeps {
  db: AppDatabase
  /** Runs the task's prompt headlessly (with its per-task grants applied). */
  run: (task: ScheduledTask) => Promise<string>
  onChanged?: (event: ScheduledTasksChangedEvent) => void
  queue?: ScheduledRunQueue
}

/** Next local-calendar occurrence after a finished run. */
export function nextOccurrence(task: ScheduledTask, now: number): number | null {
  if (task.recurrence === 'once' || task.nextRunAt === null) return null
  if (task.recurrence === 'hourly') {
    // Fixed 60-minute stride (not wall-clock days), so DST shifts never skip
    // or double a run.
    let next = task.nextRunAt
    do {
      next += 3_600_000
    } while (next <= now)
    return next
  }
  const next = new Date(task.nextRunAt)
  const days = task.recurrence === 'daily' ? 1 : 7
  do {
    next.setDate(next.getDate() + days)
  } while (next.getTime() <= now)
  return next.getTime()
}

export class ScheduledTaskScheduler {
  private timer: NodeJS.Timeout | null = null
  private readonly running = new Set<string>()
  private readonly queue: ScheduledRunQueue
  /** A run can outlast the tick interval; ticks must never overlap. */
  private ticking = false
  private started = false

  constructor(private readonly deps: ScheduledTaskSchedulerDeps) {
    this.queue = deps.queue ?? new ScheduledRunQueue()
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.wake()
  }

  /** Recomputes the one-shot timer after any schedule mutation. */
  wake(): void {
    if (!this.started) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.ticking) return
    const next = this.deps.db.scheduledTasks.nextEnabledRunAt()
    const delay = Math.min(MAX_WAKE_MS, Math.max(0, (next ?? Date.now() + MAX_WAKE_MS) - Date.now()))
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
    let due: ScheduledTask[]
    try {
      due = this.deps.db.scheduledTasks.listDue(now)
    } catch {
      return
    }

    const jobs = due.map((listed) =>
      this.queue.enqueue(`task:${listed.id}`, async () => {
        if (this.running.has(listed.id)) return
        // Queue wait can be long: always re-read pause/delete/due state at launch.
        const task = this.deps.db.scheduledTasks.getById(listed.id)
        const launchNow = Math.max(now, Date.now())
        if (!task || !task.enabled || task.nextRunAt === null || task.nextRunAt > launchNow) return
        this.running.add(task.id)
        const startedAt = launchNow
        this.deps.db.scheduledTasks.markRunning(task.id, startedAt)
        const runningTask = this.deps.db.scheduledTasks.getById(task.id)
        if (runningTask) this.deps.onChanged?.({ type: 'upsert', task: runningTask })
        try {
          const output = await this.deps.run(task)
          const finishedAt = Date.now()
          const current = this.deps.db.scheduledTasks.getById(task.id)
          if (!current) return
          this.deps.db.scheduledTasks.finish(task.id, {
            status: 'ok',
            output: output.slice(0, RESULT_LIMIT),
            error: null,
            nextRunAt: nextOccurrence(task, finishedAt),
            enabled: task.recurrence === 'once' ? false : current.enabled,
            finishedAt,
          })
        } catch (error) {
          const finishedAt = Date.now()
          const current = this.deps.db.scheduledTasks.getById(task.id)
          if (!current) return
          this.deps.db.scheduledTasks.finish(task.id, {
            status: 'error',
            output: '',
            error: toNormalizedError(error).message.slice(0, 4_000),
            nextRunAt: nextOccurrence(task, finishedAt),
            enabled: task.recurrence === 'once' ? false : current.enabled,
            finishedAt,
          })
        } finally {
          this.running.delete(task.id)
          const finished = this.deps.db.scheduledTasks.getById(task.id)
          if (finished) this.deps.onChanged?.({ type: 'upsert', task: finished })
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
