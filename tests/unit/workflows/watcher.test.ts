/**
 * Folder-watch triggers: glob matching, real fs.watch end-to-end over temp
 * dirs (debounce + settle + created/changed classification + content rules),
 * reconcile on config change, queue behavior, and the v42 repository
 * round-trip over a real temp db.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowRunResult, WorkflowWatchConfig } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import { ScheduledRunQueue } from '../../../src/main/scheduling/run-queue'
import { WORKFLOW_ALREADY_RUNNING_ERROR } from '../../../src/main/workflows/runner'
import {
  WorkflowWatcherService,
  buildWatchPayload,
  globToRegExp,
  matchesGlob,
} from '../../../src/main/workflows/watcher'

function okResult(): WorkflowRunResult {
  return { ok: true, nodeOutputs: {}, order: [] }
}

/** Polls until the condition holds, so a test never sleeps a fixed guess. */
async function until(condition: () => boolean, iterations = 400): Promise<void> {
  for (let i = 0; i < iterations && !condition(); i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  if (!condition()) throw new Error('condition never became true')
}

/** Bounded settle for negative assertions ("nothing fired"). */
function settle(ms = 300): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('globToRegExp / matchesGlob', () => {
  it('matches basenames for globs without a slash', () => {
    expect(matchesGlob('a.csv', '*.csv')).toBe(true)
    // Basename rule: a slash-less glob matches files at any depth.
    expect(matchesGlob('sub/b.csv', '*.csv')).toBe(true)
    expect(matchesGlob('a.txt', '*.csv')).toBe(false)
  })

  it('matches the relative path for globs with a slash', () => {
    expect(matchesGlob('sub/b.csv', 'sub/*.csv')).toBe(true)
    expect(matchesGlob('other/b.csv', 'sub/*.csv')).toBe(false)
    expect(matchesGlob('sub/deep/c.csv', 'sub/*.csv')).toBe(false)
  })

  it('supports ** across depths and ? for one character', () => {
    expect(matchesGlob('a/b/c/d.log', '**/*.log')).toBe(true)
    expect(matchesGlob('top.log', '**.log')).toBe(true)
    expect(matchesGlob('a1.txt', 'a?.txt')).toBe(true)
    expect(matchesGlob('a12.txt', 'a?.txt')).toBe(false)
  })

  it("globstar '**/' matches zero directories, so '**/*.log' hits the watch root", () => {
    expect(matchesGlob('report.log', '**/*.log')).toBe(true)
    expect(matchesGlob('sub/report.log', '**/*.log')).toBe(true)
    expect(matchesGlob('report.txt', '**/*.log')).toBe(false)
  })

  it('empty glob matches everything', () => {
    expect(matchesGlob('anything.bin', '')).toBe(true)
    expect(matchesGlob('deep/path/x', '  ')).toBe(true)
  })

  it('treats regex metacharacters as literals', () => {
    expect(matchesGlob('a+b(1).txt', 'a+b(1).txt')).toBe(true)
    expect(matchesGlob('axb1x.txt', 'a+b(1).txt')).toBe(false)
    expect(globToRegExp('a.b').test('axb')).toBe(false)
  })

  it('normalizes win32 backslashes in the path', () => {
    expect(matchesGlob('sub\\b.csv', 'sub/*.csv')).toBe(true)
  })
})

describe('buildWatchPayload', () => {
  it('omits the content key entirely when there is none', () => {
    const parsed = JSON.parse(buildWatchPayload('/x/y.txt', 'created', { size: 3, mtimeMs: 7 }))
    expect(parsed).toEqual({ path: '/x/y.txt', name: 'y.txt', event: 'created', size: 3, mtimeMs: 7 })
    expect('content' in parsed).toBe(false)
  })
})

describe('WorkflowWatcherService', () => {
  let dir: string
  let folder: string
  let configs: Array<{ id: string; watch: WorkflowWatchConfig }>
  let run: ReturnType<typeof vi.fn>
  let onError: ReturnType<typeof vi.fn>
  let service: WorkflowWatcherService

  function watchConfig(overrides: Partial<WorkflowWatchConfig> = {}): WorkflowWatchConfig {
    return {
      enabled: true,
      folderPath: folder,
      glob: '',
      event: 'created',
      debounceMs: 100,
      ...overrides,
    }
  }

  function makeService(): WorkflowWatcherService {
    return new WorkflowWatcherService({
      listWatched: () => configs,
      run,
      queue: new ScheduledRunQueue(2),
      onError,
      settleMs: 10,
      maxSettleChecks: 20,
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uld-watch-'))
    folder = join(dir, 'watched')
    mkdirSync(folder)
    configs = []
    run = vi.fn(async () => okResult())
    onError = vi.fn()
    service = makeService()
  })

  afterEach(() => {
    service.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('fires once for a created text file, with a full payload', async () => {
    configs = [{ id: 'wf1', watch: watchConfig() }]
    service.sync()
    expect(service.statusFor('wf1')).toEqual({ watching: true, lastError: null })

    writeFileSync(join(folder, 'note.txt'), 'hello watch')
    await until(() => run.mock.calls.length >= 1)
    await settle()
    expect(run).toHaveBeenCalledTimes(1)

    const [id, trigger, payload] = run.mock.calls[0]
    expect(id).toBe('wf1')
    expect(trigger).toBe('watch')
    const parsed = JSON.parse(payload)
    expect(parsed.name).toBe('note.txt')
    expect(parsed.event).toBe('created')
    expect(parsed.path).toBe(join(folder, 'note.txt'))
    expect(parsed.size).toBe(Buffer.byteLength('hello watch'))
    expect(typeof parsed.mtimeMs).toBe('number')
    expect(parsed.content).toBe('hello watch')
  })

  it("filters by the configured event: 'changed' ignores new files, fires on edits to seeded ones", async () => {
    const seeded = join(folder, 'seeded.txt')
    writeFileSync(seeded, 'v1')
    configs = [{ id: 'wf1', watch: watchConfig({ event: 'changed' }) }]
    service.sync()

    writeFileSync(join(folder, 'brand-new.txt'), 'never fires')
    await settle(500)
    expect(run).not.toHaveBeenCalled()

    appendFileSync(seeded, ' v2')
    await until(() => run.mock.calls.length >= 1)
    const parsed = JSON.parse(run.mock.calls[0][2])
    expect(parsed.event).toBe('changed')
    expect(parsed.name).toBe('seeded.txt')
    expect(parsed.content).toBe('v1 v2')
  })

  it('collapses a burst of writes into one run with the final content', async () => {
    configs = [{ id: 'wf1', watch: watchConfig() }]
    service.sync()

    const file = join(folder, 'burst.txt')
    for (let i = 1; i <= 5; i++) writeFileSync(file, `content ${i}`)
    await until(() => run.mock.calls.length >= 1)
    await settle()
    expect(run).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(run.mock.calls[0][2])
    expect(parsed.size).toBe(Buffer.byteLength('content 5'))
    expect(parsed.content).toBe('content 5')
  })

  it('omits content for binary heads, oversized text files, and non-text names', async () => {
    configs = [{ id: 'wf1', watch: watchConfig() }]
    service.sync()

    writeFileSync(join(folder, 'nul.txt'), Buffer.from('bad\u0000data'))
    writeFileSync(join(folder, 'big.txt'), 'x'.repeat(300 * 1024))
    writeFileSync(join(folder, 'img.png'), 'not really a png')
    await until(() => run.mock.calls.length >= 3)

    for (const call of run.mock.calls) {
      const parsed = JSON.parse(call[2])
      expect('content' in parsed).toBe(false)
    }
  })

  it('reports a missing folder through onError and statusFor without throwing', () => {
    configs = [{ id: 'wf1', watch: watchConfig({ folderPath: join(dir, 'nope') }) }]
    expect(() => service.sync()).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBe('wf1')
    const status = service.statusFor('wf1')
    expect(status.watching).toBe(false)
    expect(status.lastError).not.toBeNull()
  })

  it('does not re-toast the same persistent failure on every sync', () => {
    configs = [{ id: 'wf1', watch: watchConfig({ folderPath: join(dir, 'nope') }) }]
    service.sync()
    expect(onError).toHaveBeenCalledTimes(1)
    // Saving unrelated workflows re-runs sync(), which retries the failed
    // watcher — the identical failure must not toast again.
    service.sync()
    service.sync()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(service.statusFor('wf1').lastError).not.toBeNull()
  })

  it('reconciles on sync: removal closes, a folder change moves the watch', async () => {
    configs = [{ id: 'wf1', watch: watchConfig() }]
    service.sync()
    expect(service.statusFor('wf1').watching).toBe(true)

    // Disabled configs are filtered out of listWatched (listWatchedLite's
    // contract), so the watcher just sees the workflow disappear.
    configs = []
    service.sync()
    expect(service.statusFor('wf1').watching).toBe(false)
    writeFileSync(join(folder, 'after-close.txt'), 'nothing')
    await settle(500)
    expect(run).not.toHaveBeenCalled()

    const second = join(dir, 'second')
    mkdirSync(second)
    configs = [{ id: 'wf1', watch: watchConfig({ folderPath: second }) }]
    service.sync()
    expect(service.statusFor('wf1').watching).toBe(true)
    writeFileSync(join(second, 'moved.txt'), 'in the new folder')
    await until(() => run.mock.calls.length >= 1)
    expect(JSON.parse(run.mock.calls[0][2]).path).toBe(join(second, 'moved.txt'))
  })

  it('swallows an already-running rejection into lastError + onError', async () => {
    run = vi.fn(async () => {
      throw new Error(WORKFLOW_ALREADY_RUNNING_ERROR)
    })
    service = makeService()
    configs = [{ id: 'wf1', watch: watchConfig() }]
    service.sync()

    writeFileSync(join(folder, 'busy.txt'), 'x')
    await until(() => onError.mock.calls.length >= 1)
    expect(onError.mock.calls[0]).toEqual(['wf1', WORKFLOW_ALREADY_RUNNING_ERROR])
    expect(service.statusFor('wf1').lastError).toBe(WORKFLOW_ALREADY_RUNNING_ERROR)
    // Still watching: a refusal is not a watcher failure.
    expect(service.statusFor('wf1').watching).toBe(true)
  })

  it('coalesces overlapping fires for one workflow through the shared queue key', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    run = vi.fn(async () => {
      await gate
      return okResult()
    })
    service = makeService()
    configs = [{ id: 'wf1', watch: watchConfig() }]
    service.sync()

    writeFileSync(join(folder, 'one.txt'), 'a')
    writeFileSync(join(folder, 'two.txt'), 'b')
    // Both files settle and dispatch; the second enqueue joins the first's
    // pending promise under the same 'workflow:wf1' key.
    await until(() => run.mock.calls.length >= 1)
    await settle()
    expect(run).toHaveBeenCalledTimes(1)
    release()
  })

  it('does nothing under SMOKE_TEST', () => {
    process.env.SMOKE_TEST = '1'
    try {
      configs = [{ id: 'wf1', watch: watchConfig() }]
      service.sync()
      expect(service.statusFor('wf1').watching).toBe(false)
    } finally {
      delete process.env.SMOKE_TEST
    }
  })
})

describe('workflows repository watch round-trip (v42)', () => {
  let dir: string
  let db: AppDatabase

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uld-watch-db-'))
    db = openDatabase(join(dir, 'app.db'))
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const GRAPH = { nodes: [], edges: [] }
  const WATCH: WorkflowWatchConfig = {
    enabled: true,
    folderPath: 'C:\\data\\in',
    glob: '*.csv',
    event: 'created',
    debounceMs: 500,
  }

  it('round-trips a watch config through create/getById', () => {
    const wf = db.workflows.create({ name: 'W', graph: GRAPH, watch: WATCH })
    expect(wf.watch).toEqual(WATCH)
    expect(db.workflows.getById(wf.id)?.watch).toEqual(WATCH)
  })

  it('keeps the stored watch when a patch omits it, clears on explicit null', () => {
    const wf = db.workflows.create({ name: 'W', graph: GRAPH, watch: WATCH })
    db.workflows.update(wf.id, { name: 'Renamed' })
    expect(db.workflows.getById(wf.id)?.watch).toEqual(WATCH)

    db.workflows.update(wf.id, { watch: null })
    expect(db.workflows.getById(wf.id)?.watch).toBeNull()
  })

  it('reads corrupt watch_json back as null', () => {
    const wf = db.workflows.create({ name: 'W', graph: GRAPH, watch: WATCH })
    db.driver.run('UPDATE workflows SET watch_json = ? WHERE id = ?', ['{not json', wf.id])
    expect(db.workflows.getById(wf.id)?.watch).toBeNull()
    db.driver.run('UPDATE workflows SET watch_json = ? WHERE id = ?', [
      JSON.stringify({ enabled: true, event: 'created' }),
      wf.id,
    ])
    expect(db.workflows.getById(wf.id)?.watch).toBeNull()
  })

  it('listWatchedLite returns only enabled configs', () => {
    const on = db.workflows.create({ name: 'On', graph: GRAPH, watch: WATCH })
    db.workflows.create({ name: 'Off', graph: GRAPH, watch: { ...WATCH, enabled: false } })
    db.workflows.create({ name: 'None', graph: GRAPH })
    const lite = db.workflows.listWatchedLite()
    expect(lite).toHaveLength(1)
    expect(lite[0]).toEqual({ id: on.id, watch: WATCH })
  })
})
