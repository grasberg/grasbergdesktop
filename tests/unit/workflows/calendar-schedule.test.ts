/**
 * Calendar schedules: "08:00 on weekdays" rather than "every N minutes".
 *
 * The value of these tests is in the two things that are easy to get wrong and
 * expensive when they are: the ANCHOR (a never-run calendar schedule must not
 * fire the moment it is saved) and CATCH-UP (a slot missed while the app was
 * closed runs once, not once per slot slept through).
 */

import { describe, expect, it } from 'vitest'
import type { Workflow, WorkflowSchedule } from '@shared/types'
import { nextCalendarSlot, nextRunAt, scheduleLabel } from '@shared/workflow-status'
import { isDue } from '../../../src/main/workflows/scheduler'

/** A local timestamp, so the tests read in the same clock the code uses. */
function at(year: number, month: number, day: number, hours: number, minutes = 0): number {
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime()
}

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'w1',
    name: 'Morning digest',
    graph: { nodes: [], edges: [] },
    schedule: { kind: 'calendar', days: [], time: '08:00' },
    scheduleEnabled: true,
    webhookEnabled: false,
    lastRunAt: null,
    createdAt: 0,
    updatedAt: at(2026, 8, 20, 14, 0),
    ...overrides,
  }
}

describe('nextCalendarSlot', () => {
  const daily: WorkflowSchedule = { kind: 'calendar', days: [], time: '08:00' }

  it('finds the same day when the time is still ahead', () => {
    expect(nextCalendarSlot(daily as never, at(2026, 8, 20, 6, 30))).toBe(at(2026, 8, 20, 8, 0))
  })

  it('rolls to tomorrow once the time has passed', () => {
    expect(nextCalendarSlot(daily as never, at(2026, 8, 20, 8, 0))).toBe(at(2026, 8, 21, 8, 0))
    expect(nextCalendarSlot(daily as never, at(2026, 8, 20, 14, 0))).toBe(at(2026, 8, 21, 8, 0))
  })

  it('walks forward to an allowed weekday', () => {
    // 2026-08-22 is a Saturday; weekdays-only lands on the Monday.
    const weekdays = { kind: 'calendar' as const, days: [1, 2, 3, 4, 5], time: '08:00' }
    expect(nextCalendarSlot(weekdays, at(2026, 8, 21, 9, 0))).toBe(at(2026, 8, 24, 8, 0))
  })

  it('handles a single-day schedule a whole week out', () => {
    const sundays = { kind: 'calendar' as const, days: [0], time: '20:00' }
    // From Sunday evening after the slot, the next one is a week later.
    expect(nextCalendarSlot(sundays, at(2026, 8, 23, 21, 0))).toBe(at(2026, 8, 30, 20, 0))
  })

  it('returns null for a time it cannot parse', () => {
    expect(nextCalendarSlot({ kind: 'calendar', days: [], time: 'lunchtime' }, 0)).toBeNull()
  })
})

describe('nextRunAt — anchoring', () => {
  it('does not fire a never-run calendar schedule on the spot', () => {
    // Saved at 14:00 for 08:00: it must wait for tomorrow morning, not run now.
    const saved = workflow({ lastRunAt: null, updatedAt: at(2026, 8, 20, 14, 0) })
    expect(nextRunAt(saved, at(2026, 8, 20, 14, 0))).toBe(at(2026, 8, 21, 8, 0))
    expect(isDue(saved, at(2026, 8, 20, 14, 0))).toBe(false)
  })

  it('DOES fire a never-run interval schedule immediately', () => {
    // The two kinds anchor differently on purpose: an interval is relative.
    const interval = workflow({ schedule: { kind: 'interval', everyMinutes: 30 }, lastRunAt: null })
    const now = at(2026, 8, 20, 14, 0)
    expect(nextRunAt(interval, now)).toBe(now)
    expect(isDue(interval, now)).toBe(true)
  })

  it('anchors on the last run once there is one', () => {
    const ran = workflow({ lastRunAt: at(2026, 8, 20, 8, 0) })
    expect(nextRunAt(ran, at(2026, 8, 20, 9, 0))).toBe(at(2026, 8, 21, 8, 0))
  })

  it('is null while paused', () => {
    expect(nextRunAt(workflow({ scheduleEnabled: false }), at(2026, 8, 20, 9, 0))).toBeNull()
  })
})

describe('catch-up', () => {
  it('runs a slot missed while the app was closed, once', () => {
    // Ran Monday 08:00, then the app was closed until Thursday lunchtime.
    const missed = workflow({ lastRunAt: at(2026, 8, 17, 8, 0) })
    const backOnThursday = at(2026, 8, 20, 12, 0)
    expect(isDue(missed, backOnThursday)).toBe(true)

    // After that catch-up run the next slot is tomorrow morning — the two
    // occurrences slept through are gone, not queued up behind it.
    const afterCatchUp = { ...missed, lastRunAt: backOnThursday }
    expect(nextRunAt(afterCatchUp, backOnThursday)).toBe(at(2026, 8, 21, 8, 0))
    expect(isDue(afterCatchUp, backOnThursday)).toBe(false)
  })
})

describe('scheduleLabel', () => {
  it('names each shape the way a person would say it', () => {
    expect(scheduleLabel({ kind: 'interval', everyMinutes: 45 })).toBe('every 45m')
    expect(scheduleLabel({ kind: 'calendar', days: [], time: '08:00' })).toBe('08:00 daily')
    expect(scheduleLabel({ kind: 'calendar', days: [0, 1, 2, 3, 4, 5, 6], time: '08:00' })).toBe(
      '08:00 daily'
    )
    expect(scheduleLabel({ kind: 'calendar', days: [1, 2, 3, 4, 5], time: '08:00' })).toBe(
      '08:00 Mon–Fri'
    )
    expect(scheduleLabel({ kind: 'calendar', days: [6, 0], time: '10:30' })).toBe(
      '10:30 Sun, Sat'
    )
  })
})
