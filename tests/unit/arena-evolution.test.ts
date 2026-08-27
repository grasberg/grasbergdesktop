import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  arenaJudgePrompt,
  arenaRoundPrompt,
  parseJudgeWinner,
  resolveInsideRoot,
  seedWorktreeFromParent,
} from '../../src/main/services/arena'

describe('parseJudgeWinner', () => {
  const count = 3

  it('accepts a clean 1-based verdict', () => {
    expect(parseJudgeWinner('{"winnerIndex": 2, "reason": "cleaner diff"}', count)).toEqual({
      index: 2,
      reason: 'cleaner diff',
    })
  })

  it('extracts JSON embedded in chatty model output', () => {
    expect(
      parseJudgeWinner('My verdict:\n```json\n{"winnerIndex": 1}\n```\nDone.', count)
    ).toEqual({ index: 1, reason: '' })
  })

  it('rejects out-of-range and garbage answers', () => {
    expect(parseJudgeWinner('{"winnerIndex": 4}', count)).toBeNull()
    expect(parseJudgeWinner('{"winnerIndex": 0}', count)).toBeNull()
    expect(parseJudgeWinner('candidate two wins', count)).toBeNull()
    expect(parseJudgeWinner('', count)).toBeNull()
  })
})

describe('seedWorktreeFromParent', () => {
  let parentDir = ''
  let targetDir = ''

  beforeEach(() => {
    parentDir = mkdtempSync(join(tmpdir(), 'uld-seed-parent-'))
    targetDir = mkdtempSync(join(tmpdir(), 'uld-seed-target-'))
  })

  afterEach(() => {
    rmSync(parentDir, { recursive: true, force: true })
    rmSync(targetDir, { recursive: true, force: true })
  })

  it('copies the winner\'s changed files onto the fresh worktree', () => {
    writeFileSync(join(parentDir, 'changed.ts'), 'export const v2 = true')
    mkdirSync(join(parentDir, 'nested'))
    writeFileSync(join(parentDir, 'nested', 'new.ts'), 'hi')
    const result = seedWorktreeFromParent(parentDir, targetDir, [
      { path: 'changed.ts', status: 'M' },
      { path: 'nested/new.ts', status: 'A' },
      { path: 'deleted.ts', status: 'D' },
      { path: '../escape.ts', status: 'A' },
    ])
    expect(result.seeded).toBe(2)
    expect(readFileSync(join(targetDir, 'changed.ts'), 'utf8')).toBe('export const v2 = true')
    expect(readFileSync(join(targetDir, 'nested', 'new.ts'), 'utf8')).toBe('hi')
  })

  it('skips missing files instead of failing the whole seeding', () => {
    const result = seedWorktreeFromParent(parentDir, targetDir, [
      { path: 'ghost.ts', status: 'M' },
    ])
    expect(result.seeded).toBe(0)
  })
})

describe('resolveInsideRoot', () => {
  const root = join(tmpdir(), 'resolve-root')

  it('resolves plain relative paths and rejects escapes', () => {
    expect(resolveInsideRoot(root, 'a/b.ts')).toBe(join(root, 'a', 'b.ts'))
    expect(resolveInsideRoot(root, '..')).toBeNull()
    expect(resolveInsideRoot(root, '/abs')).toBeNull()
    if (process.platform === 'win32') {
      expect(resolveInsideRoot(root, 'C:\\abs')).toBeNull()
    }
  })
})

describe('evolution prompts', () => {
  it('the judge prompt lists every candidate with its material', () => {
    const prompt = arenaJudgePrompt('Fix the bug', [
      { label: 'a / m1', summary: 'did X', diffStat: '1 file', diff: 'diff-a' },
      { label: 'b / m2', summary: 'did Y', diffStat: '', diff: '' },
    ])
    expect(prompt).toContain('Fix the bug')
    expect(prompt).toContain('CANDIDATE 1')
    expect(prompt).toContain('CANDIDATE 2')
    expect(prompt).toContain('winnerIndex')
  })

  it('the round prompt frames improving on the winner', () => {
    const prompt = arenaRoundPrompt('Task A', 2, 'winner summary', '2 files changed')
    expect(prompt).toContain('round 1')
    expect(prompt).toContain('winner summary')
    expect(prompt).toContain('2 files changed')
  })
})
