/**
 * Pure status helpers for scheduled workflows, shared by main (run-snippet
 * truncation, the runner's wall-clock cap) and the renderer (sidebar + Home
 * labels). No runtime deps — unit-tested in plain Node, like task-groups.ts.
 */

import type { Workflow, WorkflowRun, WorkflowRunListItem } from './types'

/** Output/error cap on list surfaces (repo SQL substr + push payloads). */
export const WORKFLOW_RUN_SNIPPET_MAX = 500

/**
 * How far past due still reads as "due" rather than "overdue": the scheduler
 * ticks every 60s, so up to a minute of lag is normal operation.
 */
export const DUE_GRACE_MS = 90_000

/** Wall-clock cap per run (the runner aborts past it). */
export const WORKFLOW_RUN_TIMEOUT_MS = 10 * 60_000

type ScheduleFields = Pick<Workflow, 'schedule' | 'scheduleEnabled' | 'lastRunAt'>

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
 * Epoch ms of the next scheduled run, mirroring the scheduler's due check
 * (a never-run enabled schedule is due immediately). null when there is no
 * schedule or it is paused.
 */
export function nextRunAt(w: ScheduleFields, now: number): number | null {
  if (!w.schedule || !w.scheduleEnabled) return null
  if (w.lastRunAt === null) return now
  return w.lastRunAt + w.schedule.everyMinutes * 60_000
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
