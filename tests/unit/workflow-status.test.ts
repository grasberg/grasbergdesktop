/**
 * Pure scheduled-workflow status helpers: interval/next-run labels, the due
 * grace window, the in-flight heuristic, and run-snippet truncation.
 */

import { describe, expect, it } from 'vitest'
import type { WorkflowRun, WorkflowSchedule } from '@shared/types'
import {
  DUE_GRACE_MS,
  WORKFLOW_RUN_SNIPPET_MAX,
  WORKFLOW_RUN_TIMEOUT_MS,
  formatDuration,
  intervalLabel,
  isWorkflowRunning,
  nextRunAt,
  nextRunLabel,
  toRunSnippet,
} from '@shared/workflow-status'

const MIN = 60_000
const NOW = 100 * MIN

function sched(overrides: {
  everyMinutes?: number | null
  scheduleEnabled?: boolean
  lastRunAt?: number | null
}): {
  schedule: WorkflowSchedule | null
  scheduleEnabled: boolean
  lastRunAt: number | null
} {
  const everyMinutes = overrides.everyMinutes === undefined ? 30 : overrides.everyMinutes
  return {
    schedule: everyMinutes === null ? null : { kind: 'interval', everyMinutes },
    scheduleEnabled: overrides.scheduleEnabled ?? true,
    lastRunAt: overrides.lastRunAt === undefined ? null : overrides.lastRunAt,
  }
}

function run(overrides: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: 'r1',
    workflowId: 'w1',
    trigger: 'manual',
    status: 'ok',
    output: 'out',
    error: null,
    startedAt: NOW - MIN,
    finishedAt: NOW - MIN + 1000,
    ...overrides,
  }
}

describe('intervalLabel', () => {
  it('formats minutes, whole hours and fractional hours', () => {
    expect(intervalLabel(45)).toBe('every 45m')
    expect(intervalLabel(120)).toBe('every 2h')
    expect(intervalLabel(90)).toBe('every 1.5h')
  })
})

describe('formatDuration', () => {
  it('scales seconds → minutes → hours → days', () => {
    expect(formatDuration(0)).toBe('1s')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(25 * MIN)).toBe('25m')
    expect(formatDuration(2 * 60 * MIN)).toBe('2h')
    expect(formatDuration(90 * MIN)).toBe('1.5h')
    expect(formatDuration(72 * 60 * MIN)).toBe('3d')
  })
})

describe('nextRunAt', () => {
  it('is null without a schedule or while paused', () => {
    expect(nextRunAt(sched({ everyMinutes: null }), NOW)).toBeNull()
    expect(nextRunAt(sched({ scheduleEnabled: false }), NOW)).toBeNull()
  })

  it('is due now when never run, else lastRunAt + interval', () => {
    expect(nextRunAt(sched({ lastRunAt: null }), NOW)).toBe(NOW)
    expect(nextRunAt(sched({ everyMinutes: 30, lastRunAt: NOW - 10 * MIN }), NOW)).toBe(
      NOW + 20 * MIN
    )
  })
})

describe('nextRunLabel', () => {
  it('is empty without a schedule and "paused" when disabled', () => {
    expect(nextRunLabel(sched({ everyMinutes: null }), NOW)).toBe('')
    expect(nextRunLabel(sched({ scheduleEnabled: false }), NOW)).toBe('paused')
  })

  it('reads "due" at the due time and through the grace window', () => {
    expect(nextRunLabel(sched({ lastRunAt: null }), NOW)).toBe('due')
    expect(nextRunLabel(sched({ everyMinutes: 30, lastRunAt: NOW - 30 * MIN }), NOW)).toBe('due')
    const justInsideGrace = sched({ everyMinutes: 30, lastRunAt: NOW - 30 * MIN - DUE_GRACE_MS })
    expect(nextRunLabel(justInsideGrace, NOW)).toBe('due')
  })

  it('reads "overdue Xm" past the grace window', () => {
    const w = sched({ everyMinutes: 30, lastRunAt: NOW - 35 * MIN })
    expect(nextRunLabel(w, NOW)).toBe('overdue 5m')
  })

  it('reads "in X" for future runs', () => {
    expect(nextRunLabel(sched({ everyMinutes: 30, lastRunAt: NOW - 5 * MIN }), NOW)).toBe('in 25m')
    expect(nextRunLabel(sched({ everyMinutes: 90, lastRunAt: NOW }), NOW)).toBe('in 1.5h')
    expect(nextRunLabel(sched({ everyMinutes: 2 * 24 * 60, lastRunAt: NOW }), NOW)).toBe('in 2d')
  })
})

describe('isWorkflowRunning', () => {
  it('is false when never started', () => {
    expect(isWorkflowRunning({ lastRunAt: null }, null, NOW)).toBe(false)
  })

  it('is true while a fresh start has no recorded run yet', () => {
    expect(isWorkflowRunning({ lastRunAt: NOW - MIN }, null, NOW)).toBe(true)
    const older = run({ startedAt: NOW - 10 * MIN })
    expect(isWorkflowRunning({ lastRunAt: NOW - MIN }, older, NOW)).toBe(true)
  })

  it('is false once the run row for that start is recorded', () => {
    const recorded = run({ startedAt: NOW - MIN })
    expect(isWorkflowRunning({ lastRunAt: NOW - MIN }, recorded, NOW)).toBe(false)
  })

  it('is false past the runner timeout (unrecorded run cannot wedge the UI)', () => {
    const stale = NOW - WORKFLOW_RUN_TIMEOUT_MS
    expect(isWorkflowRunning({ lastRunAt: stale }, null, NOW)).toBe(false)
  })
})

describe('toRunSnippet', () => {
  it('truncates output and error to the cap and attaches the name', () => {
    const long = 'x'.repeat(WORKFLOW_RUN_SNIPPET_MAX + 100)
    const snip = toRunSnippet(run({ output: long, error: long }), 'Digest')
    expect(snip.workflowName).toBe('Digest')
    expect(snip.output).toHaveLength(WORKFLOW_RUN_SNIPPET_MAX)
    expect(snip.error).toHaveLength(WORKFLOW_RUN_SNIPPET_MAX)
  })

  it('keeps short values and null error intact', () => {
    const snip = toRunSnippet(run({ output: 'ok', error: null }), 'W')
    expect(snip.output).toBe('ok')
    expect(snip.error).toBeNull()
  })
})
