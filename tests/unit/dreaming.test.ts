/**
 * Dreaming (automatic memory consolidation): the model's operations are
 * validated and applied conservatively, the auto path honors the settings /
 * interval / activity gates, and a manual run bypasses those gates.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memory } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { DreamingService } from '../../src/main/services/dreaming'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-dreaming-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function seedMemories(count: number): Memory[] {
  return Array.from({ length: count }, (_, i) =>
    db.memories.create({ title: `fact-${i}`, content: `Content ${i}` })
  )
}

function service(
  responses: string[],
  now?: () => number
): { dreaming: DreamingService; generate: ReturnType<typeof vi.fn> } {
  let call = 0
  const generate = vi.fn(async () => responses[Math.min(call++, responses.length - 1)])
  return { dreaming: new DreamingService({ db, generate, now }), generate }
}

function setLastRunAt(at: number): void {
  db.driver.run(
    `INSERT INTO meta (key, value) VALUES ('dreaming_last_run_at', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [String(at)]
  )
}

function readLastRunAt(): number {
  const row = db.driver.get<{ value: string }>(
    "SELECT value FROM meta WHERE key = 'dreaming_last_run_at'"
  )
  return row ? Number(row.value) : 0
}

describe('dreamNow: applying operations', () => {
  it('applies update/delete/create ops and reports counts', async () => {
    const [a, b, c] = seedMemories(3)
    const { dreaming } = service([
      JSON.stringify({
        operations: [
          { action: 'create', title: 'merged-fact', content: 'Content 0 + Content 1' },
          { action: 'delete', id: a.id },
          { action: 'delete', id: b.id },
          { action: 'update', id: c.id, title: 'fact-2-fresh', content: 'Rewritten' },
        ],
      }),
    ])

    const result = await dreaming.dreamNow(true)
    expect(result).toEqual({ ran: true, before: 3, after: 2, updated: 1, removed: 2, created: 1 })

    const titles = db.memories.list().map((m) => m.title).sort()
    expect(titles).toEqual(['fact-2-fresh', 'merged-fact'])
    expect(db.memories.list().find((m) => m.title === 'fact-2-fresh')?.content).toBe('Rewritten')
    expect(readLastRunAt()).toBeGreaterThan(0)
  })

  it('parses JSON wrapped in prose or a code fence', async () => {
    const [a] = seedMemories(2)
    const { dreaming } = service([
      'Here you go:\n```json\n' +
        JSON.stringify({ operations: [{ action: 'delete', id: a.id }] }) +
        '\n```\nDone!',
    ])
    const result = await dreaming.dreamNow(true)
    expect(result.removed).toBe(1)
    expect(db.memories.list()).toHaveLength(1)
  })

  it('ignores operations referencing unknown ids', async () => {
    seedMemories(2)
    const { dreaming } = service([
      JSON.stringify({
        operations: [
          { action: 'delete', id: 'no-such-id' },
          { action: 'update', id: 'also-missing', title: 'x', content: 'y' },
        ],
      }),
    ])
    const result = await dreaming.dreamNow(true)
    expect(result).toMatchObject({ ran: true, updated: 0, removed: 0, created: 0 })
    expect(db.memories.list()).toHaveLength(2)
  })

  it('rejects an unusable response without touching memories (but stamps the run)', async () => {
    seedMemories(3)
    const { dreaming } = service(['I could not produce JSON, sorry.'])
    await expect(dreaming.dreamNow(true)).rejects.toThrow(/unusable/i)
    expect(db.memories.list()).toHaveLength(3)
    // Stamped anyway: a misbehaving model retries daily, not hourly.
    expect(readLastRunAt()).toBeGreaterThan(0)
  })

  it('rejects a response that deletes every memory and creates none', async () => {
    const seeded = seedMemories(3)
    const { dreaming } = service([
      JSON.stringify({ operations: seeded.map((m) => ({ action: 'delete', id: m.id })) }),
    ])
    await expect(dreaming.dreamNow(true)).rejects.toThrow(/delete every memory/i)
    expect(db.memories.list()).toHaveLength(3)
  })

  it('skips entirely when fewer than two memories exist, even when forced', async () => {
    seedMemories(1)
    const { dreaming, generate } = service(['{"operations":[]}'])
    const result = await dreaming.dreamNow(true)
    expect(result.ran).toBe(false)
    expect(generate).not.toHaveBeenCalled()
  })
})

describe('dreamNow: automatic gates', () => {
  it('skips when dreaming or memory is disabled; force still runs', async () => {
    seedMemories(6)
    db.settings.update({ dreamingEnabled: false })
    const { dreaming, generate } = service(['{"operations":[]}'])
    expect((await dreaming.dreamNow(false)).ran).toBe(false)

    db.settings.update({ dreamingEnabled: true, memoryEnabled: false })
    expect((await dreaming.dreamNow(false)).ran).toBe(false)
    expect(generate).not.toHaveBeenCalled()

    // The manual action is an explicit user request — it bypasses the toggles.
    expect((await dreaming.dreamNow(true)).ran).toBe(true)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('skips below the minimum memory count', async () => {
    seedMemories(3)
    const { dreaming, generate } = service(['{"operations":[]}'])
    expect((await dreaming.dreamNow(false)).ran).toBe(false)
    expect(generate).not.toHaveBeenCalled()
  })

  it('runs at most once per interval', async () => {
    seedMemories(6)
    const clock = Date.now() + 1000
    const { dreaming, generate } = service(['{"operations":[]}'], () => clock)
    setLastRunAt(clock - 60 * 60_000) // last dream one hour ago
    expect((await dreaming.dreamNow(false)).ran).toBe(false)
    expect(generate).not.toHaveBeenCalled()
  })

  it('skips when nothing changed since the last dream, runs when something did', async () => {
    seedMemories(6)
    const clock = Date.now() + 1000
    const { dreaming, generate } = service(['{"operations":[]}'], () => clock)

    // Interval elapsed, but every memory predates the last run: nothing new.
    setLastRunAt(clock - 25 * 60 * 60_000)
    db.driver.run('UPDATE memories SET updated_at = ?', [clock - 26 * 60 * 60_000])
    expect((await dreaming.dreamNow(false)).ran).toBe(false)
    expect(generate).not.toHaveBeenCalled()

    // One memory touched after the last run: due.
    db.driver.run('UPDATE memories SET updated_at = ? WHERE title = ?', [clock - 1000, 'fact-0'])
    expect((await dreaming.dreamNow(false)).ran).toBe(true)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(readLastRunAt()).toBe(clock)
  })
})
