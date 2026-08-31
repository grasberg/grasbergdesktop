/**
 * Morning brief: due-slot math, once-a-day consumption (error entries count),
 * catch-up flagging, context collection, delivery toggles and dismissal.
 * Test times are built with new Date(y, m, d, h, min) — local, never ISO —
 * so the local-time slot math is timezone-independent.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MorningBrief, MorningBriefSettings } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import {
  ALL_CLEAR_TEXT,
  BriefService,
  briefDue,
  briefSlotAt,
  collectBriefContext,
  isEmptyContext,
  localDateKey,
} from '../../src/main/services/brief'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-brief-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** 2026-08-28 (a Friday), local time. */
const at = (h: number, min: number, s = 0): number => new Date(2026, 7, 28, h, min, s).getTime()

function configure(overrides: Partial<MorningBriefSettings> = {}): MorningBriefSettings {
  const cfg: MorningBriefSettings = {
    enabled: true,
    time: '08:00',
    agentId: null,
    deliverTelegram: false,
    deliverNotification: true,
    ...overrides,
  }
  db.settings.update({ morningBrief: cfg })
  return cfg
}

function makeService(responses: Array<string | Error> = []): {
  brief: BriefService
  generate: ReturnType<typeof vi.fn>
  onBrief: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  sendTelegram: ReturnType<typeof vi.fn>
} {
  const queue = [...responses]
  const generate = vi.fn(async () => {
    const next = queue.length > 0 ? queue.shift() : '## Brief'
    if (next instanceof Error) throw next
    return next as string
  })
  const onBrief = vi.fn()
  const notify = vi.fn()
  const sendTelegram = vi.fn(async () => true)
  const brief = new BriefService({ db, generate, onBrief, notify, sendTelegram })
  return { brief, generate, onBrief, notify, sendTelegram }
}

function history(): MorningBrief[] {
  return db.settings.get().morningBriefHistory
}

/** Seeds an inbox-visible failure so the context is non-empty. */
function seedFailedRun(now: number): void {
  const workflow = db.workflows.create({
    name: 'Nightly digest',
    graph: { nodes: [], edges: [] },
  })
  db.workflows.insertRun({
    workflowId: workflow.id,
    trigger: 'schedule',
    status: 'error',
    output: '',
    error: 'provider exploded',
    startedAt: now - 60_000,
    finishedAt: now - 30_000,
  })
}

describe('briefSlotAt / briefDue', () => {
  it('is not due before the slot, due at/after it', () => {
    const cfg = configure()
    expect(briefDue(cfg, null, at(7, 59)).due).toBe(false)
    expect(briefDue(cfg, null, at(8, 0)).due).toBe(true)
    expect(briefDue(cfg, null, at(23, 30)).due).toBe(true)
  })

  it('flags catchUp only past the 60s slack', () => {
    const cfg = configure()
    expect(briefDue(cfg, null, at(8, 0, 30))).toEqual({ due: true, catchUp: false })
    expect(briefDue(cfg, null, at(10, 0))).toEqual({ due: true, catchUp: true })
  })

  it('is never due when disabled, unconfigured, or the time is malformed', () => {
    expect(briefDue(null, null, at(9, 0)).due).toBe(false)
    expect(briefDue(configure({ enabled: false }), null, at(9, 0)).due).toBe(false)
    expect(briefDue(configure({ time: '25:99' }), null, at(9, 0)).due).toBe(false)
    expect(briefSlotAt('25:99', at(9, 0))).toBeNull()
    expect(briefSlotAt('nope', at(9, 0))).toBeNull()
  })

  it('consumes the day via the newest history dateKey and re-arms next day', () => {
    const cfg = configure()
    const today = localDateKey(at(9, 0))
    expect(briefDue(cfg, today, at(9, 0)).due).toBe(false)
    const nextDay = new Date(2026, 7, 29, 8, 1).getTime()
    expect(briefDue(cfg, today, nextDay).due).toBe(true)
  })
})

describe('tick: generation and storage', () => {
  it('generates from the collected context and stores the brief', async () => {
    const now = at(8, 0, 30)
    // A due scheduled workflow (interval, never run → due immediately = today).
    db.workflows.create({
      name: 'Inbox sweeper',
      graph: { nodes: [], edges: [] },
      schedule: { kind: 'interval', everyMinutes: 60 },
      scheduleEnabled: true,
    })
    seedFailedRun(now)
    const task = db.scheduledTasks.create({
      title: 'Stuck reporter',
      prompt: 'do things',
      recurrence: 'daily',
      runAt: at(15, 0),
    })
    db.scheduledTasks.finish(task.id, {
      status: 'error',
      output: '',
      error: 'auth failed',
      nextRunAt: at(15, 0),
      enabled: true,
      finishedAt: now - 10_000,
    })
    configure()
    const { brief, generate, onBrief } = makeService(['## Brief'])

    await brief.tick(now)

    expect(generate).toHaveBeenCalledTimes(1)
    const prompt = generate.mock.calls[0]![0] as string
    expect(prompt).toContain('Inbox sweeper')
    expect(prompt).toContain('Stuck reporter')
    expect(prompt).toContain('Nightly digest')

    const stored = history()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      status: 'ok',
      content: '## Brief',
      dateKey: localDateKey(now),
      catchUp: false,
      dismissedAt: null,
    })
    expect(onBrief).toHaveBeenCalledWith(stored[0])
  })

  it('runs once per day', async () => {
    seedFailedRun(at(8, 0))
    configure()
    const { brief, generate } = makeService()
    await brief.tick(at(8, 0, 30))
    await brief.tick(at(8, 5, 30))
    expect(generate).toHaveBeenCalledTimes(1)
    expect(history()).toHaveLength(1)
  })

  it('records a catch-up once when the slot was missed', async () => {
    seedFailedRun(at(10, 0))
    configure()
    const { brief, generate } = makeService()
    await brief.tick(at(10, 0))
    expect(history()[0]?.catchUp).toBe(true)
    await brief.tick(at(10, 5))
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('stores an error entry on generation failure and does not retry that day', async () => {
    seedFailedRun(at(8, 1))
    configure({ deliverTelegram: true })
    const { brief, generate, notify, sendTelegram } = makeService([new Error('model down')])

    await brief.tick(at(8, 1))
    const stored = history()
    expect(stored[0]).toMatchObject({ status: 'error', content: '' })
    expect(stored[0]?.error).toContain('model down')
    // The failure notification still fires; the Telegram send is skipped.
    expect(notify).toHaveBeenCalledTimes(1)
    expect(sendTelegram).not.toHaveBeenCalled()

    await brief.tick(at(8, 6))
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('treats an empty generation as a failure, not a blank ok card', async () => {
    seedFailedRun(at(8, 1))
    configure({ deliverTelegram: true })
    const { brief, generate, sendTelegram } = makeService(['   '])

    await brief.tick(at(8, 1))
    const stored = history()
    expect(stored[0]).toMatchObject({ status: 'error', content: '' })
    expect(stored[0]?.error).toContain('empty')
    expect(sendTelegram).not.toHaveBeenCalled()
    // The day is still consumed — no 30 s retry loop on a misbehaving model.
    await brief.tick(at(8, 6))
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('skips the LLM entirely on an empty context and stores the all-clear', async () => {
    configure({ deliverTelegram: true })
    const { brief, generate, notify, sendTelegram } = makeService()
    await brief.tick(at(8, 0, 30))
    expect(generate).not.toHaveBeenCalled()
    expect(history()[0]).toMatchObject({ status: 'ok', content: ALL_CLEAR_TEXT })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(sendTelegram).toHaveBeenCalledWith(ALL_CLEAR_TEXT)
  })

  it('honors the delivery toggles', async () => {
    configure({ deliverNotification: false, deliverTelegram: false })
    const { brief, notify, sendTelegram } = makeService()
    await brief.tick(at(8, 0, 30))
    expect(notify).not.toHaveBeenCalled()
    expect(sendTelegram).not.toHaveBeenCalled()
  })

  it('sends the content to Telegram when enabled', async () => {
    seedFailedRun(at(8, 1))
    configure({ deliverTelegram: true })
    const { brief, sendTelegram } = makeService(['daily words'])
    await brief.tick(at(8, 1))
    expect(sendTelegram).toHaveBeenCalledWith('daily words')
  })

  it('passes the configured agent through (and omits it when unset)', async () => {
    seedFailedRun(at(8, 1))
    configure({ agentId: 'agent-1' })
    const withAgent = makeService()
    await withAgent.brief.tick(at(8, 1))
    expect(withAgent.generate.mock.calls[0]![1]).toEqual({ agentId: 'agent-1' })

    db.settings.update({ morningBriefHistory: [] })
    configure({ agentId: null })
    const without = makeService()
    await without.brief.tick(at(8, 2))
    expect(without.generate.mock.calls[0]![1]).toEqual({})
  })

  it('caps the history at 7 entries, newest first', async () => {
    const old: MorningBrief[] = Array.from({ length: 7 }, (_, i) => ({
      id: `old-${i}`,
      dateKey: `2026-08-${String(20 - i).padStart(2, '0')}`,
      generatedAt: at(8, 0) - (i + 1) * 86_400_000,
      status: 'ok',
      content: `old ${i}`,
      error: null,
      catchUp: false,
      dismissedAt: null,
    }))
    db.settings.update({ morningBriefHistory: old })
    configure()
    const { brief } = makeService()
    await brief.tick(at(8, 0, 30))

    const stored = history()
    expect(stored).toHaveLength(7)
    expect(stored[0]?.dateKey).toBe(localDateKey(at(8, 0)))
    expect(stored.some((b) => b.id === 'old-6')).toBe(false)
    expect(stored[1]?.id).toBe('old-0')
  })

  it('truncates over-long content to 20000 chars', async () => {
    seedFailedRun(at(8, 1))
    configure()
    const { brief } = makeService(['x'.repeat(25_000)])
    await brief.tick(at(8, 1))
    expect(history()[0]?.content).toHaveLength(20_000)
  })
})

describe('dismiss', () => {
  it('persists dismissedAt and pushes the updated entry; unknown id is a no-op', async () => {
    configure()
    const { brief, onBrief } = makeService()
    await brief.tick(at(8, 0, 30))
    const entry = history()[0]!
    onBrief.mockClear()

    brief.dismiss(entry.id)
    const stored = history()[0]!
    expect(stored.dismissedAt).not.toBeNull()
    expect(onBrief).toHaveBeenCalledWith(stored)

    expect(() => brief.dismiss('nope')).not.toThrow()
  })
})

describe('collectBriefContext', () => {
  it('is empty on a fresh database', () => {
    const ctx = collectBriefContext(db, at(9, 0))
    expect(isEmptyContext(ctx)).toBe(true)
  })

  it('excludes workflows whose next run falls on another day', () => {
    const w = db.workflows.create({
      name: 'Late runner',
      graph: { nodes: [], edges: [] },
      schedule: { kind: 'interval', everyMinutes: 60 },
      scheduleEnabled: true,
    })
    // Last ran 23:50 → next run 00:50 tomorrow.
    db.workflows.touchLastRun(w.id, at(23, 50))
    const ctx = collectBriefContext(db, at(23, 55))
    expect(ctx.dueToday.filter((d) => d.name === 'Late runner')).toHaveLength(0)
  })

  it("includes an overdue (catch-up) schedule as 'due now'", () => {
    const w = db.workflows.create({
      name: 'Weekly export',
      graph: { nodes: [], edges: [] },
      schedule: { kind: 'interval', everyMinutes: 7 * 24 * 60 },
      scheduleEnabled: true,
    })
    // Last ran 8 days ago: the slot was missed while the app was closed and
    // catches up TODAY — the brief must list it, not drop it as 'yesterday'.
    db.workflows.touchLastRun(w.id, at(9, 0) - 8 * 86_400_000)
    const ctx = collectBriefContext(db, at(9, 0))
    const entry = ctx.dueToday.find((d) => d.name === 'Weekly export')
    expect(entry).toBeDefined()
    expect(entry?.at).toBe('due now')
  })

  it('includes due-today workflows, tasks and failing tasks with capped errors', () => {
    db.workflows.create({
      name: 'Sweeper',
      graph: { nodes: [], edges: [] },
      schedule: { kind: 'interval', everyMinutes: 30 },
      scheduleEnabled: true,
    })
    const task = db.scheduledTasks.create({
      title: 'Reporter',
      prompt: 'p',
      recurrence: 'daily',
      runAt: at(15, 0),
    })
    db.scheduledTasks.finish(task.id, {
      status: 'error',
      output: '',
      error: 'e'.repeat(1000),
      nextRunAt: at(15, 0),
      enabled: true,
      finishedAt: at(8, 0),
    })
    const ctx = collectBriefContext(db, at(9, 0))
    expect(ctx.dueToday.map((d) => d.kind).sort()).toEqual(['task', 'workflow'])
    expect(ctx.dueToday.find((d) => d.kind === 'task')?.at).toBe('15:00')
    expect(ctx.failingTasks).toHaveLength(1)
    expect(ctx.failingTasks[0]?.error).toHaveLength(240)
  })
})
