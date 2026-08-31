/**
 * Pure status helpers for scheduled workflows, shared by main (run-snippet
 * truncation, the runner's wall-clock cap) and the renderer (sidebar + Home
 * labels). No runtime deps — unit-tested in plain Node, like task-groups.ts.
 */

import type {
  Workflow,
  WorkflowCalendarSchedule,
  WorkflowRun,
  WorkflowRunListItem,
  WorkflowSchedule,
} from './types'

/** Output/error cap on list surfaces (repo SQL substr + push payloads). */
export const WORKFLOW_RUN_SNIPPET_MAX = 500

/**
 * How far past due still reads as "due" rather than "overdue": the scheduler
 * ticks every 60s, so up to a minute of lag is normal operation.
 */
export const DUE_GRACE_MS = 90_000

/** Wall-clock cap per run (the runner aborts past it). */
export const WORKFLOW_RUN_TIMEOUT_MS = 10 * 60_000

type ScheduleFields = Pick<Workflow, 'schedule' | 'scheduleEnabled' | 'lastRunAt'> & {
  /**
   * Anchor for a calendar schedule that has never run — when the schedule was
   * last edited. Omitted means "now", i.e. the next matching slot from here.
   */
  updatedAt?: number
  scheduleUpdatedAt?: number
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "every 45m" / "every 2h" / "every 1.5h" label for a schedule interval. */
export function intervalLabel(everyMinutes: number): string {
  if (everyMinutes < 60) return `every ${everyMinutes}m`
  if (everyMinutes % 60 === 0) return `every ${everyMinutes / 60}h`
  return `every ${(everyMinutes / 60).toFixed(1)}h`
}

/** Compact duration: "45s", "25m", "2h", "1.5h", "3d". Floors at 1s. */
export function formatDuration(ms: number): string {
  const clamped = Math.max(0, ms)
  if (clamped < 60_000) return `${Math.max(1, Math.round(clamped / 1000))}s`
  const minutes = Math.round(clamped / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = clamped / 3_600_000
  if (hours < 48) {
    const rounded = Math.round(hours * 10) / 10
    return Number.isInteger(rounded) ? `${rounded}h` : `${rounded.toFixed(1)}h`
  }
  return `${Math.round(hours / 24)}d`
}

/**
 * The first wall-clock slot strictly after `after` that a calendar schedule
 * matches. Local Date arithmetic, not fixed offsets, so "08:00 on weekdays"
 * stays 08:00 across a daylight-saving change.
 */
export function nextCalendarSlot(schedule: WorkflowCalendarSchedule, after: number): number | null {
  const [rawHours, rawMinutes] = schedule.time.split(':')
  const hours = Number.parseInt(rawHours ?? '', 10)
  const minutes = Number.parseInt(rawMinutes ?? '', 10)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  const slot = new Date(after)
  slot.setHours(hours, minutes, 0, 0)
  if (slot.getTime() <= after) slot.setDate(slot.getDate() + 1)
  // Empty `days` means every day; otherwise walk forward to an allowed one.
  // Bounded at 7 steps — one week contains every non-empty subset of weekdays.
  if (schedule.days.length > 0) {
    for (let step = 0; step < 7 && !schedule.days.includes(slot.getDay()); step++) {
      slot.setDate(slot.getDate() + 1)
    }
    if (!schedule.days.includes(slot.getDay())) return null
  }
  return slot.getTime()
}

/**
 * Epoch ms of the next scheduled run — the SINGLE definition of "due", shared
 * by the scheduler and by every label the UI shows, so the two can never
 * disagree about when something will happen. null when there is no schedule,
 * it is paused, or it can never match.
 *
 * The two kinds anchor differently, deliberately. An INTERVAL schedule is
 * relative ("every 30 minutes"), so a never-run one is due immediately. A
 * CALENDAR schedule is absolute ("08:00 on weekdays"), so a never-run one is
 * anchored on when it was last edited: saving an 08:00 digest at 14:00 waits
 * for tomorrow morning rather than firing on the spot.
 */
export function nextRunAt(w: ScheduleFields, now: number): number | null {
  if (!w.schedule || !w.scheduleEnabled) return null
  if (w.schedule.kind === 'calendar') {
    // Unrelated edits must not erase catch-up, but a schedule edit must anchor
    // the newly configured calendar after the edit rather than firing an old
    // missed slot. Older callers without scheduleUpdatedAt retain the previous
    // updatedAt fallback.
    return nextCalendarSlot(
      w.schedule,
      Math.max(w.lastRunAt ?? -Infinity, w.scheduleUpdatedAt ?? w.updatedAt ?? now)
    )
  }
  if (w.lastRunAt === null) return now
  return w.lastRunAt + w.schedule.everyMinutes * 60_000
}

/** "every 45m" / "08:00 daily" / "08:00 Mon–Fri" — one schedule, one line. */
export function scheduleLabel(schedule: WorkflowSchedule): string {
  if (schedule.kind === 'interval') return intervalLabel(schedule.everyMinutes)
  if (schedule.days.length === 0 || schedule.days.length === 7) return `${schedule.time} daily`
  const days = [...schedule.days].sort((a, b) => a - b)
  const isWeekdays = days.length === 5 && days.every((d) => d >= 1 && d <= 5)
  if (isWeekdays) return `${schedule.time} Mon–Fri`
  return `${schedule.time} ${days.map((d) => WEEKDAY_NAMES[d]).join(', ')}`
}

/**
 * Row label for the next run: 'paused' | 'due' | 'overdue 5m' | 'in 25m'.
 * Empty string when the workflow has no schedule at all.
 */
export function nextRunLabel(w: ScheduleFields, now: number): string {
  if (!w.schedule) return ''
  const at = nextRunAt(w, now)
  if (at === null) return 'paused'
  const delta = at - now
  if (delta <= 0) {
    return -delta <= DUE_GRACE_MS ? 'due' : `overdue ${formatDuration(-delta)}`
  }
  return `in ${formatDuration(delta)}`
}

/**
 * In-flight heuristic: lastRunAt is stamped when a run STARTS; its history row
 * is inserted (with the same startedAt) when it FINISHES. A start newer than
 * the newest recorded run means the run is still going. Bounded by the
 * runner's wall-clock cap so a crashed/unrecorded run can't read as running
 * forever.
 */
export function isWorkflowRunning(
  w: Pick<Workflow, 'lastRunAt'>,
  latestRun: WorkflowRun | null,
  now: number
): boolean {
  if (w.lastRunAt === null) return false
  if (now - w.lastRunAt >= WORKFLOW_RUN_TIMEOUT_MS) return false
  return latestRun === null || latestRun.startedAt < w.lastRunAt
}

/** Truncates output/error for list surfaces and attaches the workflow name. */
export function toRunSnippet(run: WorkflowRun, workflowName: string): WorkflowRunListItem {
  return {
    ...run,
    output: run.output.slice(0, WORKFLOW_RUN_SNIPPET_MAX),
    error: run.error === null ? null : run.error.slice(0, WORKFLOW_RUN_SNIPPET_MAX),
    workflowName,
  }
}
