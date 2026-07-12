import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import {
  nextOccurrence,
  ScheduledTaskScheduler,
} from '../../src/main/scheduled-tasks/scheduler'
import { resolveFirstRun } from '../../src/main/scheduled-tasks/resolve'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grasberg-scheduled-task-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('scheduled tasks repository', () => {
  it('creates, lists, pauses and removes a standalone task', () => {
    const runAt = Date.now() + 60_000
    const task = db.scheduledTasks.create({
      title: 'Morning brief',
      prompt: 'Summarize today.',
      recurrence: 'daily',
      runAt,
    })

    expect(db.scheduledTasks.list()).toHaveLength(1)
    expect(db.scheduledTasks.getById(task.id)?.nextRunAt).toBe(runAt)
    expect(db.scheduledTasks.listDue(runAt - 1)).toEqual([])
    expect(db.scheduledTasks.listDue(runAt).map((item) => item.id)).toEqual([task.id])

    expect(db.scheduledTasks.setEnabled(task.id, false)?.enabled).toBe(false)
    expect(db.scheduledTasks.listDue(runAt + 1)).toEqual([])
    db.scheduledTasks.remove(task.id)
    expect(db.scheduledTasks.list()).toEqual([])
  })

  it('stores hourly recurrence (v28 dropped the recurrence CHECK)', () => {
    const task = db.scheduledTasks.create({
      title: 'Hourly ping',
      prompt: 'Ping.',
      recurrence: 'hourly',
      runAt: Date.now() + 60_000,
    })
    expect(db.scheduledTasks.getById(task.id)?.recurrence).toBe('hourly')
  })

  it('round-trips per-task grants and working folder (v29)', () => {
    const task = db.scheduledTasks.create({
      title: 'Script run',
      prompt: 'Run the script.',
      recurrence: 'daily',
      runAt: Date.now() + 60_000,
      approvedToolIds: ['run_shell_command', 'write_file'],
      projectId: 'proj-1',
    })
    const stored = db.scheduledTasks.getById(task.id)!
    expect(stored.approvedToolIds).toEqual(['run_shell_command', 'write_file'])
    expect(stored.projectId).toBe('proj-1')
    // Defaults when omitted.
    const plain = db.scheduledTasks.create({
      title: 'Plain',
      prompt: 'P.',
      recurrence: 'once',
      runAt: Date.now() + 60_000,
    })
    expect(db.scheduledTasks.getById(plain.id)?.approvedToolIds).toEqual([])
    expect(db.scheduledTasks.getById(plain.id)?.projectId).toBeNull()
  })
})

describe('standalone scheduled task scheduler', () => {
  it('runs a due one-time prompt and marks it completed', async () => {
    const task = db.scheduledTasks.create({
      title: 'One shot',
      prompt: 'Do the thing',
      recurrence: 'once',
      runAt: Date.now() - 10,
    })
    const run = vi.fn(async () => 'Finished result')
    const onChanged = vi.fn()
    const scheduler = new ScheduledTaskScheduler({ db, run, onChanged })

    await scheduler.tick()

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id, prompt: 'Do the thing' })
    )
    const finished = db.scheduledTasks.getById(task.id)!
    expect(finished.lastStatus).toBe('ok')
    expect(finished.lastOutput).toBe('Finished result')
    expect(finished.nextRunAt).toBeNull()
    expect(finished.enabled).toBe(false)
    expect(onChanged).toHaveBeenCalled()
  })

  it('records a safe error and advances recurring tasks', async () => {
    const runAt = Date.now() - 10
    const task = db.scheduledTasks.create({
      title: 'Daily',
      prompt: 'Fail safely',
      recurrence: 'daily',
      runAt,
    })
    const scheduler = new ScheduledTaskScheduler({
      db,
      run: async () => {
        throw new Error('Bearer secret-value-123456789')
      },
    })

    await scheduler.tick()

    const finished = db.scheduledTasks.getById(task.id)!
    expect(finished.lastStatus).toBe('error')
    expect(finished.lastError).not.toContain('secret-value')
    expect(finished.nextRunAt).toBeGreaterThan(Date.now())
    expect(finished.enabled).toBe(true)
  })

  it('never runs a task twice when an earlier due run outlasts the tick', async () => {
    const runAt = Date.now() - 10
    db.scheduledTasks.create({ title: 'Slow', prompt: 'Slow one', recurrence: 'daily', runAt })
    const once = db.scheduledTasks.create({
      title: 'Once',
      prompt: 'Send the email',
      recurrence: 'once',
      runAt,
    })
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = vi.fn(async () => {
      await gate
      return 'ok'
    })
    const scheduler = new ScheduledTaskScheduler({ db, run })

    // The first task's run outlasts the 30 s interval: the next tick still sees
    // the 'once' task as due, and the first tick's due list is stale by then.
    const tickA = scheduler.tick()
    const tickB = scheduler.tick()
    release()
    await Promise.all([tickA, tickB])

    expect(run).toHaveBeenCalledTimes(2)
    const finished = db.scheduledTasks.getById(once.id)!
    expect(finished.enabled).toBe(false)
    expect(finished.nextRunAt).toBeNull()
  })

  it('re-reads each task before running it, so one paused mid-tick is skipped', async () => {
    const runAt = Date.now() - 10
    const first = db.scheduledTasks.create({
      title: 'First',
      prompt: 'First',
      recurrence: 'daily',
      runAt,
    })
    const second = db.scheduledTasks.create({
      title: 'Second',
      prompt: 'Second',
      recurrence: 'daily',
      runAt,
    })
    const run = vi.fn(async (task: ScheduledTask) => {
      // The user pauses the still-queued task while this one is generating.
      if (task.id === first.id) db.scheduledTasks.setEnabled(second.id, false)
      return 'ok'
    })
    const scheduler = new ScheduledTaskScheduler({ db, run })

    await scheduler.tick()

    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0].id).toBe(first.id)
    expect(db.scheduledTasks.getById(second.id)?.lastStatus).toBe('idle')
  })
})

describe('nextOccurrence', () => {
  it('advances daily and weekly schedules by local calendar days', () => {
    const base = new Date(2026, 6, 11, 9, 30).getTime()
    const task = {
      recurrence: 'daily',
      nextRunAt: base,
    } as ScheduledTask
    const daily = new Date(nextOccurrence(task, base)!)
    expect(daily.getDate()).toBe(new Date(base).getDate() + 1)
    expect(daily.getHours()).toBe(9)
    expect(daily.getMinutes()).toBe(30)

    task.recurrence = 'weekly'
    expect(nextOccurrence(task, base)).toBe(new Date(2026, 6, 18, 9, 30).getTime())
  })

  it('advances hourly schedules by a fixed 60-minute stride, skipping missed slots', () => {
    const base = new Date(2026, 6, 11, 9, 30).getTime()
    const task = { recurrence: 'hourly', nextRunAt: base } as ScheduledTask
    expect(nextOccurrence(task, base)).toBe(base + 3_600_000)
    // The app was closed for a while: missed occurrences are skipped.
    expect(nextOccurrence(task, base + 3 * 3_600_000)).toBe(base + 4 * 3_600_000)
  })
})

describe('resolveFirstRun', () => {
  const now = new Date(2026, 6, 11, 14, 0).getTime() // Sat 2026-07-11 14:00 local

  it('resolves a future wall-clock time to today', () => {
    const result = resolveFirstRun({ recurrence: 'once', time: '15:30' }, now)
    expect(result).toEqual({ runAt: new Date(2026, 6, 11, 15, 30).getTime() })
  })

  it('rolls a passed time to the next occurrence per recurrence', () => {
    expect(resolveFirstRun({ recurrence: 'once', time: '09:00' }, now)).toEqual({
      runAt: new Date(2026, 6, 12, 9, 0).getTime(),
    })
    expect(resolveFirstRun({ recurrence: 'weekly', time: '09:00' }, now)).toEqual({
      runAt: new Date(2026, 6, 18, 9, 0).getTime(),
    })
    expect(resolveFirstRun({ recurrence: 'hourly', time: '13:45' }, now)).toEqual({
      runAt: new Date(2026, 6, 11, 14, 45).getTime(),
    })
  })

  it('supports explicit dates, in_minutes, and an anchor-free hourly start', () => {
    expect(
      resolveFirstRun({ recurrence: 'once', date: '2026-07-20', time: '08:00' }, now)
    ).toEqual({ runAt: new Date(2026, 6, 20, 8, 0).getTime() })
    expect(resolveFirstRun({ recurrence: 'once', inMinutes: 90 }, now)).toEqual({
      runAt: now + 90 * 60_000,
    })
    expect(resolveFirstRun({ recurrence: 'hourly' }, now)).toEqual({ runAt: now + 3_600_000 })
  })

  it('rejects bad input with readable errors', () => {
    const past = resolveFirstRun({ recurrence: 'once', date: '2026-07-01', time: '08:00' }, now)
    expect(past).toHaveProperty('error')
    expect((past as { error: string }).error).toContain('already passed')

    expect(resolveFirstRun({ recurrence: 'once', time: '25:00' }, now)).toHaveProperty('error')
    expect(resolveFirstRun({ recurrence: 'once', date: '2026-02-30', time: '08:00' }, now)).toHaveProperty('error')
    expect(resolveFirstRun({ recurrence: 'daily' }, now)).toHaveProperty('error')
    expect(
      resolveFirstRun({ recurrence: 'once', time: '15:00', inMinutes: 5 }, now)
    ).toHaveProperty('error')
  })
})
