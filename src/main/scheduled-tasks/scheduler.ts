/** Clock scheduler for standalone prompt tasks (independent from workflows). */

import type { ScheduledTask } from '@shared/types'
import type { AppDatabase } from '../db/database'
import { toNormalizedError } from '../providers/errors'

const TICK_MS = 30_000
const RESULT_LIMIT = 40_000

export interface ScheduledTaskSchedulerDeps {
  db: AppDatabase
  /** Runs the task's prompt headlessly (with its per-task grants applied). */
  run: (task: ScheduledTask) => Promise<string>
  onChanged?: () => void
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
  /** A run can outlast the tick interval; ticks must never overlap. */
  private ticking = false

  constructor(private readonly deps: ScheduledTaskSchedulerDeps) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
    void this.tick()
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.runDue(now)
    } finally {
      this.ticking = false
    }
  }

  private async runDue(now: number): Promise<void> {
    let due: ScheduledTask[]
    try {
      due = this.deps.db.scheduledTasks.listDue(now)
    } catch {
      return
    }

    for (const listed of due) {
      if (this.running.has(listed.id)) continue
      // The due list is a snapshot: awaiting the task ahead of this one can take
      // minutes, during which the row may have run, been paused or rescheduled.
      // Re-read it and re-check due-ness so a task never fires twice.
      const task = this.deps.db.scheduledTasks.getById(listed.id)
      if (!task || !task.enabled || task.nextRunAt === null || task.nextRunAt > now) continue
      this.running.add(task.id)
      const startedAt = Date.now()
      this.deps.db.scheduledTasks.markRunning(task.id, startedAt)
      this.deps.onChanged?.()
      try {
        const output = await this.deps.run(task)
        const finishedAt = Date.now()
        const current = this.deps.db.scheduledTasks.getById(task.id)
        if (!current) continue
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
        if (!current) continue
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
        this.deps.onChanged?.()
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
