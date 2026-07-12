/**
 * runGitQuery against a REAL git repo: a diff bigger than the output cap is
 * truncated, not turned into a failure (execFile's maxBuffer kills the child
 * and reports an error — a big diff/log is exactly what the git tool exists for).
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGitQuery } from '../../../src/main/tools/git'

let dir: string
let hasGit = true

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-gitquery-'))
  try {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  } catch {
    hasGit = false
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('runGitQuery', () => {
  it('truncates output past the cap instead of failing', async () => {
    if (!hasGit) return
    // ~120 KB of staged additions: well past the 64 KB maxBuffer.
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n')
    writeFileSync(join(dir, 'big.txt'), big)
    execFileSync('git', ['add', 'big.txt'], { cwd: dir, stdio: 'ignore' })

    const result = await runGitQuery(['diff', '--staged'], dir)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('line 0')
    expect(result.output).toContain('…[truncated at 64KB]')
  })

  it('returns small output untruncated', async () => {
    if (!hasGit) return
    writeFileSync(join(dir, 'small.txt'), 'hello\n')
    execFileSync('git', ['add', 'small.txt'], { cwd: dir, stdio: 'ignore' })

    const result = await runGitQuery(['diff', '--staged'], dir)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('+hello')
    expect(result.output).not.toContain('truncated')
  })

  it('reports a git failure as ok:false', async () => {
    if (!hasGit) return
    const result = await runGitQuery(['log', '--oneline'], dir) // no commits yet
    expect(result.ok).toBe(false)
    expect(result.output.length).toBeGreaterThan(0)
  })
})
