import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
  it('accepts equal-or-better scores only (maximize, the default)', () => {
    expect(decideAccept({ ...passing, bestScore: 10 })).toBe(true)
    expect(decideAccept({ ...passing, bestScore: 9 })).toBe(true)
    expect(decideAccept({ ...passing, bestScore: 11 })).toBe(false)
  })
  it('accepts equal-or-lower scores only when minimizing', () => {
    expect(decideAccept({ ...passing, bestScore: 10, direction: 'minimize' })).toBe(true)
    expect(decideAccept({ ...passing, bestScore: 11, direction: 'minimize' })).toBe(true)
    expect(decideAccept({ ...passing, bestScore: 9, direction: 'minimize' })).toBe(false)
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
    direction: 'maximize' as const,
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
    expect(prompt).toContain('HIGHER is better')
    expect(prompt).not.toContain('REDIRECT')
  })

  it('states the minimize direction when set', () => {
    const prompt = buildRoundPrompt({ ...base, direction: 'minimize' })
    expect(prompt).toContain('LOWER is better')
    expect(prompt).toContain('undercuts')
  })

  it('adds a redirect hint and shows kept vs discarded lineage when due', () => {
    const prompt = buildRoundPrompt({
      ...base,
      redirectHint: true,
      versions: [
        { seq: 2, score: 105, summary: 'unrolled the loop', accepted: true },
        { seq: 1, score: 99, summary: 'tried caching', accepted: false },
      ],
    })
    expect(prompt).toContain('REDIRECT')
    expect(prompt).toContain('tried caching')
    expect(prompt).toContain('[discarded]')
    expect(prompt).toContain('[kept]')
  })
})

/** Fakes that script the agent + command outcomes per round. */
function makeDeps(
  scripted: Array<{ exitCode: number; output: string }>,
  gitLog: { commits: string[]; discards: number; stages: number }
) {
  let round = -1
  let commandStep = 0
  type StatusResult = {
    isRepo: boolean
    branch: string | null
    staged: unknown[]
    unstaged: unknown[]
    untracked: unknown[]
  }
  type CmdResult = { ok: boolean; exitCode: number | null; output: string; aborted?: boolean }
  return {
    db: db!,
    git: {
      status: async (): Promise<StatusResult> => ({
        isRepo: true,
        branch: 'main',
        staged: [],
        unstaged: [],
        untracked: [],
      }),
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
      revision: async () => 'base-sha',
      createWorktree: async (_root: string, worktreesDir: string, projectId: string) => {
        const worktreePath = join(worktreesDir, 'optimizer-isolated')
        mkdirSync(worktreePath, { recursive: true })
        return { path: worktreePath, branch: 'grasberg/optimizer-test', projectId }
      },
      removeWorktree: async () => undefined,
      fastForwardWorktree: async () => undefined,
    },
    generate: async () => {
      round += 1
      return scripted[round]?.output ? `round ${round + 1} summary` : `round ${round + 1} summary`
    },
    runCommand: async (): Promise<CmdResult> => {
      const step = scripted[commandStep]
      commandStep += 1
      return {
        ok: (step?.exitCode ?? 1) === 0,
        exitCode: step?.exitCode ?? 1,
        output: step?.output ?? '',
      }
    },
    broadcast: vi.fn(),
    notify: vi.fn(),
    worktreesDir: join(dir, 'worktrees'),
  }
}

describe('OptimizerService loop', () => {
  it('commits accepted rounds, rolls back rejected ones, updates the ledger', async () => {
    const project = db!.code.projectUpsertByPath(dir, 'optimizer')
    const gitLog = { commits: [], discards: 0, stages: 0 }
    const deps = makeDeps(
      [
        { exitCode: 0, output: 'bench\n10' }, // pristine baseline
        { exitCode: 0, output: '8' }, // regression -> rejected
        { exitCode: 0, output: '12' }, // improvement -> accepted
        { exitCode: 0, output: '11' }, // regression -> rejected
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
    expect(finalRun.bestVersion).toBe(2)
    expect(finalRun.roundsDone).toBe(3)
    // The pristine baseline is measured before edits; only one improvement commits.
    expect(gitLog.commits).toHaveLength(1)
    expect(gitLog.stages).toBe(1)
    expect(gitLog.discards).toBe(3) // two rejects + final isolated-tree cleanup
    const versions = service.versions(run.id)
    expect(versions.map((v) => v.accepted)).toEqual([true, false, true, false])
    expect(versions[2].commitSha).toBe('sha-1')
    // Experiment log recorded every attempt for future sessions.
    expect(deps.db.experiments.listForProject(project.id)).toHaveLength(3)
    expect(deps.broadcast).toHaveBeenCalled()
  })

  it('stops as plateau after six consecutive rejects even with rounds left', async () => {
    const project = db!.code.projectUpsertByPath(dir, 'optimizer')
    const gitLog = { commits: [], discards: 0, stages: 0 }
    // Pristine baseline, then six straight regressions -> plateau stop.
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
    expect(finalRun.roundsDone).toBe(6)
    expect(finalRun.bestScore).toBe(10)
    expect(gitLog.commits).toHaveLength(0)
    expect(gitLog.discards).toBe(7) // six attempts + final cleanup
  })

  it('preserves the isolated branch instead of touching a dirty main checkout', async () => {
    const project = db!.code.projectUpsertByPath(dir, 'optimizer')
    const gitLog = { commits: [] as string[], discards: 0, stages: 0 }
    const deps = makeDeps(
      [
        { exitCode: 0, output: '10' }, // pristine baseline
        { exitCode: 0, output: '12' }, // accepted improvement
      ],
      gitLog
    )
    deps.git.fastForwardWorktree = async () => {
      throw new Error('The project has uncommitted changes.')
    }
    const service = new OptimizerService(deps)
    const run = await service.start({
      projectId: project.id,
      goal: 'g',
      evalCommand: 'bench',
      maxRounds: 1,
    })
    await vi.waitFor(() => {
      expect(deps.db.optimizer.getById(run.id)?.status).not.toBe('running')
    })
    const finalRun = deps.db.optimizer.getById(run.id)!
    expect(finalRun.status).toBe('done')
    expect(finalRun.lastError).toContain('Accepted commits were preserved')
    expect(finalRun.worktreePath).toContain('optimizer-isolated')
    expect(service.versions(run.id)).toHaveLength(2)
  })

  it('a stop landing mid-eval does not record a phantom failed round', async () => {
    const project = db!.code.projectUpsertByPath(dir, 'optimizer')
    const gitLog = { commits: [] as string[], discards: 0, stages: 0 }
    const deps = makeDeps([{ exitCode: 0, output: '10' }], gitLog)
    let command = 0
    deps.runCommand = async () => {
      command += 1
      return command === 1
        ? { ok: true, exitCode: 0, output: '10' }
        : { ok: false, exitCode: null, output: '', aborted: true }
    }
    const service = new OptimizerService(deps)
    const run = await service.start({
      projectId: project.id,
      goal: 'g',
      evalCommand: 'bench',
      maxRounds: 3,
    })
    await vi.waitFor(() => {
      expect(deps.db.optimizer.getById(run.id)?.status).not.toBe('running')
    })
    expect(deps.db.optimizer.getById(run.id)!.status).toBe('stopped')
    // No version, no experiment-log pollution, no rollback.
    expect(service.versions(run.id)).toHaveLength(1) // pristine baseline only
    expect(deps.db.experiments.listForProject(project.id)).toHaveLength(0)
    expect(gitLog.discards).toBe(1) // safe cleanup in the isolated worktree
  })

  it('fails honestly when the rollback itself breaks', async () => {
    const project = db!.code.projectUpsertByPath(dir, 'optimizer')
    const gitLog = {
      commits: [] as string[],
      discards: 0,
      stages: 0,
    }
    const deps = makeDeps(
      [
        { exitCode: 0, output: '10' },
        { exitCode: 1, output: '' },
      ],
      gitLog
    )
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
