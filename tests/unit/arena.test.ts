/**
 * Code Arena: N models race the same task in isolated worktrees. Fully faked
 * ports (git/code/generate) + a real temp database for the agent_runs
 * control-plane rows. Covers: fan-out + run rows, diff capture, applying the
 * winner through the change pipeline, the worktree path-jail on discard, and
 * abort semantics.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitFileChange } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { ArenaService, arenaPrompt } from '../../src/main/services/arena'

let dir: string
let db: AppDatabase
let projectDir: string
let worktreesDir: string
let conversationId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-arena-'))
  db = openDatabase(join(dir, 'app.db'))
  projectDir = join(dir, 'project')
  worktreesDir = join(dir, 'worktrees')
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(worktreesDir, { recursive: true })
  writeFileSync(join(projectDir, 'existing.ts'), 'old content\n')
  const projectId = db.code.projectUpsertByPath(projectDir, 'project').id
  conversationId = db.conversations.create({ mode: 'work', projectId }).id
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

interface FakePorts {
  files?: GitFileChange[]
  generate?: (prompt: string, providerId: string, modelId: string, opts: { signal?: AbortSignal }) => Promise<string>
}

function makeService(ports: FakePorts = {}) {
  const removed: string[] = []
  const proposed: Array<{ relPath: string; changeType: string; content: string }> = []
  let worktreeIndex = 0

  const service = new ArenaService({
    db,
    git: {
      createWorktree: async (_root, wtDir, projectId, name) => {
        worktreeIndex += 1
        const path = join(wtDir, `${projectId}-${name ?? 'wt'}-${worktreeIndex}`)
        mkdirSync(path, { recursive: true })
        return { path, branch: `grasberg/${name ?? 'wt'}-${worktreeIndex}`, projectId }
      },
      captureWorktreeDiff: async (worktreeRoot) => ({
        stat: '1 file changed',
        diff: 'diff --git a/x b/x',
        files:
          ports.files ??
          [
            { path: 'new-file.ts', status: 'A' },
            { path: 'existing.ts', status: 'M' },
          ],
      }),
      removeWorktree: async (_mainRoot, worktreePath) => {
        removed.push(worktreePath)
      },
    },
    code: {
      openProject: (path) => db.code.projectUpsertByPath(path, 'wt'),
      proposeChange: (_cid, relPath, changeType, content) => {
        proposed.push({ relPath, changeType, content })
        return { id: `chg-${proposed.length}` }
      },
      applyChange: (changeId) => changeId,
    },
    worktreesDir,
    broadcast: vi.fn(),
    generate:
      ports.generate ??
      (async (_prompt, _providerId, modelId) => `done by ${modelId}`),
  })
  return { service, removed, proposed }
}

const CANDIDATES = [
  { providerId: 'p1', modelId: 'model-a' },
  { providerId: 'p2', modelId: 'model-b' },
]

describe('ArenaService', () => {
  it('fans out one worktree + agent run per candidate and finishes with diffs', async () => {
    const { service } = makeService()
    const state = await service.start({ conversationId, task: 'Fix the bug', candidates: CANDIDATES })
    expect(state.candidates).toHaveLength(2)
    expect(state.status).toBe('running')

    const runs = db.agentPlatform.runsList(conversationId)
    expect(runs).toHaveLength(2)
    expect(runs.every((r) => r.agentName === 'arena')).toBe(true)

    await until(() => service.status(conversationId)?.status === 'finished')
    const finished = service.status(conversationId)!
    expect(finished.candidates.every((c) => c.status === 'done')).toBe(true)
    expect(finished.candidates[0].summary).toBe('done by model-a')
    expect(finished.candidates[0].diffStat).toBe('1 file changed')
    expect(finished.candidates[0].changedFiles).toHaveLength(2)
    expect(db.agentPlatform.runsList(conversationId).every((r) => r.status === 'done')).toBe(true)
  })

  it('refuses to start without a folder, with bad counts, or while running', async () => {
    const bare = db.conversations.create({ mode: 'work' }).id
    const { service } = makeService()
    await expect(
      service.start({ conversationId: bare, task: 'x', candidates: CANDIDATES })
    ).rejects.toThrow(/connect a folder/i)
    await expect(
      service.start({ conversationId, task: 'x', candidates: CANDIDATES.slice(0, 1) })
    ).rejects.toThrow(/2–4/)

    const slow = makeService({
      generate: (_p, _pid, _mid, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    })
    await slow.service.start({ conversationId, task: 'x', candidates: CANDIDATES })
    await expect(
      slow.service.start({ conversationId, task: 'y', candidates: CANDIDATES })
    ).rejects.toThrow(/already running/i)
    slow.service.stop(conversationId)
    await until(() => slow.service.status(conversationId)?.status === 'finished')
    expect(
      slow.service.status(conversationId)!.candidates.every((c) => c.status === 'stopped')
    ).toBe(true)
  })

  it('applies the winner through the change pipeline (create vs edit) and skips deletions', async () => {
    const { service, proposed } = makeService({
      files: [
        { path: 'new-file.ts', status: 'A' },
        { path: 'existing.ts', status: 'M' },
        { path: 'gone.ts', status: 'D' },
      ],
    })
    await service.start({ conversationId, task: 'Fix', candidates: CANDIDATES })
    await until(() => service.status(conversationId)?.status === 'finished')
    const state = service.status(conversationId)!
    const winner = state.candidates[0]
    // Seed the winner's worktree with the files its diff claims.
    writeFileSync(join(winner.worktreePath, 'new-file.ts'), 'brand new\n')
    writeFileSync(join(winner.worktreePath, 'existing.ts'), 'updated content\n')

    const applied = await service.apply(conversationId, winner.runId)
    expect(applied.status).toBe('applied')
    expect(applied.appliedRunId).toBe(winner.runId)
    expect(proposed).toEqual([
      { relPath: 'new-file.ts', changeType: 'create', content: 'brand new\n' },
      { relPath: 'existing.ts', changeType: 'edit', content: 'updated content\n' },
    ])
    // Second apply is refused.
    await expect(service.apply(conversationId, state.candidates[1].runId)).rejects.toThrow(
      /already been applied/i
    )
  })

  it('discard removes only worktrees under the app-owned directory', async () => {
    const { service, removed } = makeService()
    await service.start({ conversationId, task: 'Fix', candidates: CANDIDATES })
    await until(() => service.status(conversationId)?.status === 'finished')
    const state = service.status(conversationId)!
    // Sabotage one candidate's path to simulate a corrupted record: it must
    // NOT be handed to git worktree remove.
    state.candidates[1].worktreePath = projectDir
    await service.discard(conversationId)
    expect(removed).toHaveLength(1)
    expect(removed[0].startsWith(worktreesDir)).toBe(true)
    expect(service.status(conversationId)).toBeNull()
  })

  it('a failing candidate settles as error without sinking the others', async () => {
    const { service } = makeService({
      generate: async (_p, _pid, modelId) => {
        if (modelId === 'model-a') throw new Error('provider exploded')
        return 'ok'
      },
    })
    await service.start({ conversationId, task: 'Fix', candidates: CANDIDATES })
    await until(() => service.status(conversationId)?.status === 'finished')
    const state = service.status(conversationId)!
    expect(state.candidates[0].status).toBe('error')
    expect(state.candidates[0].summary).toMatch(/provider exploded/)
    expect(state.candidates[1].status).toBe('done')
  })

  it('arenaPrompt frames the race and embeds the task', () => {
    const prompt = arenaPrompt('Refactor the queue')
    expect(prompt).toContain('isolated copies')
    expect(prompt).toContain('Never ask questions')
    expect(prompt).toContain('Refactor the queue')
  })
})
