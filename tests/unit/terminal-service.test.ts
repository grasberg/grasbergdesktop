/**
 * TerminalService: user-driven Work-view terminal sessions. Pipes-based (no
 * pty) — these tests inject a Node one-liner as the "shell" so they run on
 * every platform without depending on cmd.exe/bash behavior.
 */

import { describe, expect, it, vi } from 'vitest'
import { TerminalService, defaultShell } from '../../src/main/terminal/terminal-service'
import { CHANNELS } from '@shared/ipc'
import type { TerminalDataEvent, TerminalExitEvent } from '@shared/types'

/** A fake line-oriented shell: echoes every stdin line back, prefixed. */
const ECHO_SHELL = {
  file: process.execPath,
  args: [
    '-e',
    'process.stdin.setEncoding("utf8");' +
      'process.stdin.on("data",(d)=>{if(d.includes("quitnow"))process.exit(7);' +
      'process.stdout.write("echo:"+d)})',
  ],
}

function collectingBroadcast() {
  const data: TerminalDataEvent[] = []
  const exits: TerminalExitEvent[] = []
  const broadcast = vi.fn((channel: string, payload: unknown) => {
    if (channel === CHANNELS.terminalData) data.push(payload as TerminalDataEvent)
    if (channel === CHANNELS.terminalExit) exits.push(payload as TerminalExitEvent)
  })
  return { broadcast, data, exits }
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('TerminalService', () => {
  it('decodes multibyte output split between pipe writes', async () => {
    const { broadcast, exits } = collectingBroadcast()
    const service = new TerminalService({ broadcast, shellSpec: () => ({ file: process.execPath, args: ['-e', 'process.stdout.write(Buffer.from([0xf0,0x9f]));setTimeout(()=>{process.stdout.write(Buffer.from([0xa6,0x89]));},80)'] }) })
    try {
      service.createOrAttach('unicode', process.cwd())
      await until(() => exits.length > 0)
      const output = broadcast.mock.calls.filter(([channel]) => channel === CHANNELS.terminalData).map(([, event]) => (event as TerminalDataEvent).chunk).join('')
      expect(output).toBe('🦉')
    } finally { service.disposeAll() }
  })
  it('spawns one session per conversation, streams output and keeps a backlog', async () => {
    const { broadcast, data } = collectingBroadcast()
    const service = new TerminalService({ broadcast, shellSpec: () => ECHO_SHELL })
    try {
      const info = service.createOrAttach('conv-1', process.cwd())
      expect(info.alive).toBe(true)
      expect(info.conversationId).toBe('conv-1')

      service.write(info.sessionId, 'hello terminal\n')
      await until(() => data.some((e) => e.chunk.includes('echo:hello terminal')))

      // Re-attach returns the SAME session, now carrying the backlog.
      const again = service.createOrAttach('conv-1', process.cwd())
      expect(again.sessionId).toBe(info.sessionId)
      expect(again.backlog).toContain('echo:hello terminal')

      // A different conversation gets its own session.
      const other = service.createOrAttach('conv-2', process.cwd())
      expect(other.sessionId).not.toBe(info.sessionId)
    } finally {
      service.disposeAll()
    }
  })

  it('broadcasts exit when the shell terminates and refuses writes afterwards', async () => {
    const { broadcast, exits } = collectingBroadcast()
    const service = new TerminalService({ broadcast, shellSpec: () => ECHO_SHELL })
    try {
      const info = service.createOrAttach('conv-1', process.cwd())
      service.write(info.sessionId, 'quitnow\n')
      await until(() => exits.length > 0)
      expect(exits[0]).toMatchObject({ sessionId: info.sessionId, code: 7 })
      expect(() => service.write(info.sessionId, 'more\n')).toThrow(/not running/i)

      // With the old session dead, createOrAttach spawns a fresh one.
      const fresh = service.createOrAttach('conv-1', process.cwd())
      expect(fresh.sessionId).not.toBe(info.sessionId)
    } finally {
      service.disposeAll()
    }
  })

  it('dispose kills the session and disposeAll clears every session', async () => {
    const { broadcast, exits } = collectingBroadcast()
    const service = new TerminalService({ broadcast, shellSpec: () => ECHO_SHELL })
    const a = service.createOrAttach('conv-a', process.cwd())
    service.dispose(a.sessionId)
    await until(() => exits.some((e) => e.sessionId === a.sessionId))
    expect(() => service.write(a.sessionId, 'x\n')).toThrow()

    const b = service.createOrAttach('conv-b', process.cwd())
    service.disposeAll()
    await until(() => exits.some((e) => e.sessionId === b.sessionId))
  })

  it('caps a single input write', () => {
    const { broadcast } = collectingBroadcast()
    const service = new TerminalService({ broadcast, shellSpec: () => ECHO_SHELL })
    try {
      const info = service.createOrAttach('conv-1', process.cwd())
      expect(() => service.write(info.sessionId, 'x'.repeat(10_000))).toThrow(/too long/i)
    } finally {
      service.disposeAll()
    }
  })

  it('defaultShell picks a line-oriented shell per platform', () => {
    expect(defaultShell('win32').file.toLowerCase()).toContain('cmd')
    expect(defaultShell('linux').file.length).toBeGreaterThan(0)
  })
})
