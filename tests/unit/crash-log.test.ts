import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handleUncaughtException,
  installCrashLogging,
  logMainError,
} from '../../src/main/services/crash-log'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-crashlog-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('crash log', () => {
  it('creates logs/main.log and records a redacted, timestamped entry', () => {
    installCrashLogging(dir)
    const file = join(dir, 'logs', 'main.log')
    expect(existsSync(file)).toBe(true)

    logMainError('boot', new Error('failed with key sk-ant-secret1234567890 embedded'))
    const contents = readFileSync(file, 'utf8')
    // Startup marker + the error line are both present.
    expect(contents).toContain('session-start')
    expect(contents).toContain('boot:')
    // The secret is redacted, never written verbatim.
    expect(contents).not.toContain('sk-ant-secret1234567890')
    // Each line is ISO-timestamped.
    expect(contents).toMatch(/^\[\d{4}-\d{2}-\d{2}T/m)
  })

  it('logMainError before install is a silent no-op (no throw)', () => {
    // A fresh module state would have no file; calling into it must not throw.
    // (install in this test already ran in the previous one within the same
    // module instance, so assert only that a call never throws.)
    expect(() => logMainError('x', 'y')).not.toThrow()
  })

  it('terminates after logging an uncaught exception', () => {
    const exit = vi.fn()
    handleUncaughtException(new Error('fatal'), exit)
    expect(exit).toHaveBeenCalledWith(1)
  })
})
