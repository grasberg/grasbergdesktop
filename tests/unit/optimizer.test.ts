import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import {
  OptimizerService,
  buildRoundPrompt,
  decideAccept,
  parseScore,
} from '../../src/main/services/optimizer'

let dir: string
let db: AppDatabase | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-optimizer-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  db?.close()
  db = null
  rmSync(dir, { recursive: true, force: true })
})

describe('parseScore', () => {
  it('prefers the number on the last line', () => {
    expect(parseScore('running...\n42.5\n')).toBe(42.5)
    expect(parseScore('warmup done\n1234')).toBe(1234)
  })

  it('falls back to the last number anywhere in the tail', () => {
    expect(parseScore('done in 3.2s (12 ops)')).toBe(12)
  })

  it('returns null without any number', () => {
    expect(parseScore('no numbers here')).toBeNull()
    expect(parseScore('')).toBeNull()
  })
})

describe('decideAccept', () => {
  const passing = { evalExitCode: 0, score: 10, testPassed: true }
  it('accepts the first passing version as baseline', () => {
    expect(decideAccept({ ...passing, bestScore: null })).toBe(true)
  })
  it('accepts equal-or-better scores only', () => {
    expect(decideAccept({ ...passing, bestScore: 10 })).toBe(true)
    expect(decideAccept({ ...passing, bestScore: 9 })).toBe(true)
    expect(decideAccept({ ...passing, bestScore: 11 })).toBe(false)
  })
  it('never accepts a failing gate or missing score', () => {
    expect(decideAccept({ ...passing, evalExitCode: 1, bestScore: null })).toBe(false)
    expect(decideAccept({ ...passing, score: null, bestScore: null })).toBe(false)
    expect(decideAccept({ ...passing, testPassed: false, bestScore: null })).toBe(false)
  })
})

describe('buildRoundPrompt', () => {
  const base = {
    goal: 'make it fast',
    evalCommand: 'npm run bench',
    testCommand: null,
    round: 2,
    maxRounds: 6,
    bestScore: 100,
    bestVersion: 1,
    versions: [],
    redirectHint: false,
  }

  it('contains the protocol essentials', () => {
    const prompt = buildRoundPrompt(base)
    expect(prompt).toContain('make it fast')
    expect(prompt).toContain('npm run bench')
    expect(prompt).toContain('v1 (score 100)')
    expect(prompt).not.toContain('REDIRECT')
  })

  it('adds a redirect hint and lineage when due', () => {
    const prompt = buildRoundPrompt({
      ...base,
      redirectHint: true,
      versions: [{ seq: 1, score: 99, summary: 'tried caching' }],
    })
    expect(prompt).toContain('REDIRECT')
    expect(prompt).toContain('tried caching')
  })
})

/** Fakes that script the agent + command outcomes per round. */
function makeDeps(
  scripted: Array<{ exitCode: number; output: string }>,
  gitLog: { commits: string[]; discards: number; stages: number }
) {
  let round = -1
  return {
    db: db!,
    git: {
      status: async () => ({ isRepo: true, staged: [], unstaged: [], untracked: [] }),
      stage: async () => {
        gitLog.stages += 1
        return {}
      },
      commit: async (_root: string, message: string) => {
        gitLog.commits.push(message)
        return { sha: `sha-${gitLog.commits.length}`, branch: 'main' }
      },
      discardAllChanges: async () => {
        gitLog.discards += 1
      },
    },
    generate: async () => {
      round += 1
      return scripted[round]?.output ? `round ${round + 1} summary` : `round ${round + 1} summary`
    },
    runCommand: async () => {
      const step = scripted[round]
      return {
        ok: (step?.exitCode ?? 1) === 0,
        exitCode: step?.exitCode ?? 1,
        output: step?.output ?? '',
      }
    },
    broadcast: vi.fn(),
    notify: vi.fn(),
  }
}

describe('OptimizerService loop', () => {
  it('commits accepted rounds, rolls back rejected ones, updates the ledger', async () => {
    const project = db!.code.projectUpsertByPath(dir, 'optimizer')
    const gitLog = { commits: [], discards: 0, stages: 0 }
    const deps = makeDeps(
      [
        { exitCode: 0, output: 'bench\n10' }, // accepted baseline
        { exitCode: 0, output: '8' }, // regression -> rejected
        { exitCode: 0, output: '12' }, // improvement -> accepted
      ],
      gitLog
    )
    const service = new OptimizerService(deps)
    const run = await service.start({
      projectId: project.id,
      goal: 'speed up parser',
      evalCommand: 'npm run bench',
      maxRounds: 3,
    })
    // Let the fire-and-forget loop settle.
    await vi.waitFor(() => {
      expect(deps.db.optimizer.getById(run.id)?.status).not.toBe('running')
    })
    const finalRun = deps.db.optimizer.getById(run.id)!
    expect(finalRun.status).toBe('done')
    expect(finalRun.bestScore).toBe(12)
    expect(finalRun.bestVersion).toBe(3)
    expect(finalRun.roundsDone).toBe(3)
    // Two accepts committed+staged; one reject rolled back.
    expect(gitLog.commits).toHaveLength(2)
    expect(gitLog.stages).toBe(2)
    expect(gitLog.discards).toBe(1)
    const versions = service.versions(run.id)
    expect(versions.map((v) => v.accepted)).toEqual([true, false, true])
    expect(versions[2].commitSha).toBe('sha-2') // second commit
    // Experiment log recorded every attempt for future sessions.
    expect(deps.db.experiments.listForProject(project.id)).toHaveLength(3)
    expect(deps.broadcast).toHaveBeenCalled()
  })

  it('stops as plateau after six consecutive rejects even with rounds left', async () => {
    const project = db!.code.projectUpsertByPath(dir, 'optimizer')
    const gitLog = { commits: [], discards: 0, stages: 0 }
    // One accepted baseline, then six straight regressions -> plateau stop.
    const deps = makeDeps(
      [{ exitCode: 0, output: '10' }, ...Array.from({ length: 6 }, () => ({ exitCode: 0, output: '5' }))],
      gitLog
    )
    const service = new OptimizerService(deps)
    const run = await service.start({
      projectId: project.id,
      goal: 'stuck task',
      evalCommand: 'bench',
      maxRounds: 20,
    })
    await vi.waitFor(() => {
      expect(deps.db.optimizer.getById(run.id)?.status).not.toBe('running')
    })
    const finalRun = deps.db.optimizer.getById(run.id)!
    expect(finalRun.status).toBe('done')
    expect(finalRun.roundsDone).toBe(7)
    expect(finalRun.bestScore).toBe(10)
    expect(gitLog.commits).toHaveLength(1)
    expect(gitLog.discards).toBe(6)
  })

  it('fails honestly when the rollback itself breaks', async () => {
    const project = db!.code.projectUpsertByPath(dir, 'optimizer')
    const gitLog = {
      commits: [] as string[],
      discards: 0,
      stages: 0,
    }
    const deps = makeDeps([{ exitCode: 1, output: '' }], gitLog)
    deps.git.discardAllChanges = async () => {
      throw new Error('dirty tree locked')
    }
    const service = new OptimizerService(deps)
    const run = await service.start({
      projectId: project.id,
      goal: 'g',
      evalCommand: 'x',
      maxRounds: 2,
    })
    await vi.waitFor(() => {
      expect(deps.db.optimizer.getById(run.id)?.status).not.toBe('running')
    })
    const finalRun = deps.db.optimizer.getById(run.id)!
    expect(finalRun.status).toBe('failed')
    expect(finalRun.lastError).toContain('rolled back')
  })
})
