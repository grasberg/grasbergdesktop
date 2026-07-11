/**
 * Resolves the schedule_task tool's time arguments to a concrete first-run
 * timestamp. Pure local-time arithmetic, designed so the model never needs to
 * know the current clock time: "HH:MM" means the NEXT occurrence of that
 * wall-clock time, and past times roll forward instead of failing (except an
 * explicitly dated one-off, which is a genuine user error).
 */

import type { ScheduledTaskRecurrence } from '@shared/types'

export interface FirstRunSpec {
  recurrence: ScheduledTaskRecurrence
  /** Wall-clock time "HH:MM" (24h, local). */
  time?: string | null
  /** Calendar date "YYYY-MM-DD" (local). */
  date?: string | null
  /** Minutes from now — alternative to time/date. */
  inMinutes?: number | null
}

export type FirstRunResult = { runAt: number } | { error: string }

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
/** in_minutes is clamped to at most one year out. */
const MAX_IN_MINUTES = 366 * 24 * 60

/** "Sat, Jul 11, 2026, 15:00" — model/user-readable local run time. */
export function formatLocalRunTime(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(ms)
}

/** Advances a timestamp by one recurrence interval (local-calendar for days). */
function advance(ms: number, recurrence: ScheduledTaskRecurrence): number {
  if (recurrence === 'hourly') return ms + 3_600_000
  const next = new Date(ms)
  next.setDate(next.getDate() + (recurrence === 'weekly' ? 7 : 1))
  return next.getTime()
}

export function resolveFirstRun(spec: FirstRunSpec, now: number): FirstRunResult {
  const { recurrence } = spec
  const time = spec.time?.trim() || null
  const date = spec.date?.trim() || null

  if (typeof spec.inMinutes === 'number') {
    if (time || date) {
      return { error: "Error: give either 'in_minutes' or 'time'/'date', not both." }
    }
    const minutes = Math.floor(spec.inMinutes)
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_IN_MINUTES) {
      return { error: `Error: 'in_minutes' must be an integer between 1 and ${MAX_IN_MINUTES}.` }
    }
    return { runAt: now + minutes * 60_000 }
  }

  if (!time) {
    // "Every hour" needs no anchor: start one interval from now.
    if (recurrence === 'hourly' && !date) return { runAt: now + 3_600_000 }
    return {
      error:
        "Error: provide 'time' as \"HH:MM\" (24-hour, the user's local time), or 'in_minutes'.",
    }
  }

  const timeMatch = TIME_RE.exec(time)
  if (!timeMatch) {
    return { error: `Error: 'time' must be "HH:MM" (24-hour), got "${time}".` }
  }
  const hours = Number(timeMatch[1])
  const minutes = Number(timeMatch[2])

  let base: Date
  if (date) {
    const dateMatch = DATE_RE.exec(date)
    if (!dateMatch) {
      return { error: `Error: 'date' must be "YYYY-MM-DD", got "${date}".` }
    }
    base = new Date(
      Number(dateMatch[1]),
      Number(dateMatch[2]) - 1,
      Number(dateMatch[3]),
      hours,
      minutes,
      0,
      0
    )
    // new Date() normalizes overflow (e.g. Feb 30 -> Mar 2): reject those.
    if (
      base.getFullYear() !== Number(dateMatch[1]) ||
      base.getMonth() !== Number(dateMatch[2]) - 1 ||
      base.getDate() !== Number(dateMatch[3])
    ) {
      return { error: `Error: "${date}" is not a valid calendar date.` }
    }
  } else {
    base = new Date(now)
    base.setHours(hours, minutes, 0, 0)
  }

  let runAt = base.getTime()
  if (runAt > now) return { runAt }

  // The moment has passed. An explicitly dated one-off is a real conflict the
  // user must resolve; everything else rolls forward to the next occurrence.
  if (recurrence === 'once' && date) {
    return {
      error: `Error: ${formatLocalRunTime(runAt)} has already passed (it is now ${formatLocalRunTime(now)}).`,
    }
  }
  do {
    runAt = advance(runAt, recurrence === 'once' ? 'daily' : recurrence)
  } while (runAt <= now)
  return { runAt }
}
