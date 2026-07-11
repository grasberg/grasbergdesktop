/**
 * GitService against REAL temp git repositories (skipped when git is not on
 * PATH): status parsing, stage/commit round-trips, argv-injection proofing
 * (messages and paths are data, never flags), branch validation, and the
 * commit-message suggestion flow.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitService, parsePorcelainStatus } from '../../../src/main/code/git-service'

let gitAvailable = true
try {
  execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true })
} catch {
  gitAvailable = false
}

function git(cwd: string, ...argv: string[]): string {
  return execFileSync('git', argv, { cwd, windowsHide: true }).toString('utf8')
}

function initRepo(dir: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore', windowsHide: true })
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Grasberg Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
}

describe('parsePorcelainStatus (pure)', () => {
  it('separates staged, unstaged and untracked records', () => {
    const raw = ['M  staged.ts', ' M unstaged.ts', 'MM both.ts', '?? new.txt'].join('\0') + '\0'
    const parsed = parsePorcelainStatus(raw)
    expect(parsed.staged.map((f) => f.path).sort()).toEqual(['both.ts', 'staged.ts'])
    expect(parsed.unstaged.map((f) => f.path).sort()).toEqual(['both.ts', 'unstaged.ts'])
    expect(parsed.untracked).toEqual(['new.txt'])
  })

  it('consumes the rename source record', () => {
    const raw = 'R  new-name.ts\0old-name.ts\0?? other.txt\0'
    const parsed = parsePorcelainStatus(raw)
    expect(parsed.staged).toEqual([{ path: 'new-name.ts', status: 'R' }])
    expect(parsed.untracked).toEqual(['other.txt'])
  })
})

describe.skipIf(!gitAvailable)('GitService (real temp repos)', () => {
  let dir: string
  const service = new GitService()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uld-git-'))
    initRepo(dir)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports a non-repo folder as isRepo: false', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'uld-nogit-'))
    try {
      const status = await service.status(plain)
      expect(status.isRepo).toBe(false)
      expect(status.branch).toBeNull()
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('stage → status → commit round-trip; default branch detected locally', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello\n')
    writeFileSync(join(dir, 'b.txt'), 'world\n')

    let status = await service.status(dir)
    expect(status.isRepo).toBe(true)
    expect(status.untracked.sort()).toEqual(['a.txt', 'b.txt'])
    expect(status.staged).toHaveLength(0)

    await service.stage(dir, ['a.txt', 'b.txt'])
    status = await service.status(dir)
    expect(status.staged.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt'])

    const result = await service.commit(dir, 'feat: first commit')
    expect(result.sha).toMatch(/^[0-9a-f]{4,}$/)
    expect(result.branch).toBe('main')
    expect(git(dir, 'log', '--format=%s', '-1').trim()).toBe('feat: first commit')

    // Default-branch detection without a remote: local main.
    status = await service.status(dir)
    expect(status.branch).toBe('main')
    expect(status.defaultBranch).toBe('main')
  })

  it('a commit message full of shell metacharacters lands verbatim (no shell, single argv)', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x\n')
    await service.stage(dir, ['a.txt'])
    const hostile = 'evil"; rm -rf / && echo $(whoami) `id` | tee pwned #'
    await service.commit(dir, hostile)
    expect(git(dir, 'log', '--format=%s', '-1').trim()).toBe(hostile)
  })

  it('refuses empty commits, empty messages and option-smuggling paths', async () => {
    await expect(service.commit(dir, 'msg')).rejects.toThrow(/nothing is staged/i)
    writeFileSync(join(dir, 'a.txt'), 'x\n')
    await service.stage(dir, ['a.txt'])
    await expect(service.commit(dir, '   ')).rejects.toThrow(/must not be empty/i)

    await expect(service.stage(dir, ['-rf'])).rejects.toThrow(/must not start with "-"/i)
    await expect(service.stage(dir, ['../outside.txt'])).rejects.toThrow(/must not contain/i)
    await expect(service.stage(dir, ['C:/abs.txt'])).rejects.toThrow(/relative/i)
    await expect(service.stage(dir, [])).rejects.toThrow(/at least one/i)
  })

  it('unstage restores files to the working set', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x\n')
    await service.stage(dir, ['a.txt'])
    await service.unstage(dir, ['a.txt'])
    const status = await service.status(dir)
    expect(status.staged).toHaveLength(0)
    expect(status.untracked).toEqual(['a.txt'])
  })

  it('creates and switches to a valid branch; rejects invalid names', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x\n')
    await service.stage(dir, ['a.txt'])
    await service.commit(dir, 'init') // branches need a born HEAD

    const note = await service.createBranch(dir, 'grasberg/feature-1')
    expect(note).toContain("'grasberg/feature-1'")
    expect((await service.status(dir)).branch).toBe('grasberg/feature-1')

    await expect(service.createBranch(dir, '-evil')).rejects.toThrow(/branch names/i)
    await expect(service.createBranch(dir, 'has space')).rejects.toThrow(/branch names/i)
  })

  it('creates an isolated app-owned worktree on a grasberg branch', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x\n')
    await service.stage(dir, ['a.txt'])
    await service.commit(dir, 'init')
    const worktrees = mkdtempSync(join(tmpdir(), 'uld-worktrees-'))
    try {
      const created = await service.createWorktree(dir, worktrees, 'project-1', 'Review task')
      expect(created.branch).toMatch(/^grasberg\/review-task-/)
      expect(git(created.path, 'branch', '--show-current').trim()).toBe(created.branch)
      expect(git(dir, 'branch', '--show-current').trim()).toBe('main')
    } finally {
      // Remove through git first so the source repo does not retain metadata.
      const listed = git(dir, 'worktree', 'list', '--porcelain')
      const match = /worktree (.*uld-worktrees-[^\r\n]*)/.exec(listed)
      if (match) execFileSync('git', ['worktree', 'remove', '--force', match[1]], { cwd: dir, windowsHide: true })
      rmSync(worktrees, { recursive: true, force: true })
    }
  })

  it('generateCommitMessage feeds the staged diff to the model and cleans the reply', async () => {
    const generateText = vi.fn(async (_prompt: string) => '```\nfix: adjust greeting\n```')
    const withModel = new GitService({ generateText })
    writeFileSync(join(dir, 'a.txt'), 'hello there\n')
    await withModel.stage(dir, ['a.txt'])

    const result = await withModel.generateCommitMessage(dir)
    expect(result.message).toBe('fix: adjust greeting')
    expect(generateText.mock.calls[0][0]).toContain('hello there')

    // Nothing staged → clear refusal before any model call.
    await withModel.commit(dir, 'setup')
    await expect(withModel.generateCommitMessage(dir)).rejects.toThrow(/nothing is staged/i)
  })

  it('runs the required before-commit quality gate', async () => {
    const beforeCommit = vi.fn(async () => {})
    const guarded = new GitService({ beforeCommit })
    writeFileSync(join(dir, 'a.txt'), 'x\n')
    await guarded.stage(dir, ['a.txt'])
    await guarded.commit(dir, 'guarded')
    expect(beforeCommit).toHaveBeenCalledWith(dir)

    writeFileSync(join(dir, 'a.txt'), 'y\n')
    await guarded.stage(dir, ['a.txt'])
    const blocked = new GitService({ beforeCommit: async () => { throw new Error('quality gate failed') } })
    await expect(blocked.commit(dir, 'blocked')).rejects.toThrow(/quality gate failed/i)
    expect(git(dir, 'log', '--format=%s', '-1').trim()).toBe('guarded')
  })
})
