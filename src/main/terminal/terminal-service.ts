/**
 * User-driven terminal sessions for the Work view's Terminal tab.
 *
 * Pipes-based BY DESIGN — no node-pty: this repo deliberately avoids native
 * modules (the same reason SQLite runs as WASM). Each session is one
 * persistent OS shell spawned with stdio pipes; stdout/stderr are interleaved,
 * pushed live to the renderer, and mirrored into a capped main-side scrollback
 * so a re-opened panel replays history. Line-oriented flows (npm test, git,
 * builds, REPL-ish tools) work; full-screen TUI apps (vim, htop) do not — the
 * renderer's tab says so.
 *
 * SAFETY: sessions are created ONLY from an explicit user action in the
 * renderer (opening the Terminal tab, typing a command). The model has NO
 * tool that reaches this service — model-driven execution stays in the
 * approval-gated run_shell_command pipeline. Output passes redactSecrets
 * before leaving main, like every other surface that could echo a key.
 */

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import type { TerminalDataEvent, TerminalExitEvent, TerminalSessionInfo } from '@shared/types'
import { CHANNELS } from '@shared/ipc'
import { redactSecrets } from '../providers/redact'

/** Scrollback kept per session for replay on re-attach. */
const BACKLOG_MAX_CHARS = 256 * 1024
/** A single pushed chunk is capped so one giant write cannot flood IPC. */
const CHUNK_MAX_CHARS = 64 * 1024
/** Stdin writes are line-oriented and capped (matches a sane command line). */
const INPUT_MAX_CHARS = 8 * 1024

export interface TerminalShellSpec {
  file: string
  args: string[]
}

/**
 * The platform's line-oriented shell. cmd.exe reads piped stdin line by line
 * and even echoes its prompt, which reads naturally in the panel; POSIX bash
 * executes piped lines silently, so the renderer echoes the command locally.
 */
export function defaultShell(platform: NodeJS.Platform = process.platform): TerminalShellSpec {
  if (platform === 'win32') {
    return { file: process.env.ComSpec || 'cmd.exe', args: [] }
  }
  return { file: process.env.SHELL || '/bin/bash', args: [] }
}

interface TerminalSession {
  sessionId: string
  conversationId: string
  cwd: string
  shellLabel: string
  child: ChildProcess
  backlog: string
  alive: boolean
}

export interface TerminalServiceOptions {
  broadcast: (channel: string, payload: unknown) => void
  /** Test seam: what to spawn instead of the platform shell. */
  shellSpec?: () => TerminalShellSpec
}

export class TerminalService {
  private readonly sessions = new Map<string, TerminalSession>()

  constructor(private readonly options: TerminalServiceOptions) {}

  /**
   * Returns the conversation's live session, or spawns one in `cwd`. One
   * session per conversation: the terminal is the task's, not the tab's, so
   * closing and re-opening the panel re-attaches instead of respawning.
   */
  createOrAttach(conversationId: string, cwd: string): TerminalSessionInfo {
    const existing = [...this.sessions.values()].find(
      (s) => s.conversationId === conversationId && s.alive
    )
    if (existing) return this.info(existing)

    const spec = this.options.shellSpec?.() ?? defaultShell()
    const child = spawn(spec.file, spec.args, {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb' }, // discourage ANSI-heavy output
    })

    const session: TerminalSession = {
      sessionId: randomUUID(),
      conversationId,
      cwd,
      shellLabel: spec.file,
      child,
      backlog: '',
      alive: true,
    }
    this.sessions.set(session.sessionId, session)

    const onData = (chunk: Buffer): void => this.pushData(session, chunk.toString('utf8'))
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (err) => {
      this.pushData(session, `\n[terminal] failed to start ${spec.file}: ${err.message}\n`)
      this.settle(session, null)
    })
    child.on('close', (code) => this.settle(session, code))

    return this.info(session)
  }

  /** Writes one line of user input to the session's stdin. */
  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || !session.alive) throw new Error('Terminal session is not running.')
    if (data.length > INPUT_MAX_CHARS) throw new Error('Terminal input is too long.')
    session.child.stdin?.write(data)
  }

  /** Kills the session's shell (explicit user click). */
  dispose(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.kill(session)
    this.sessions.delete(sessionId)
  }

  /** App shutdown: kill every shell we spawned. */
  disposeAll(): void {
    for (const session of this.sessions.values()) this.kill(session)
    this.sessions.clear()
  }

  private info(session: TerminalSession): TerminalSessionInfo {
    return {
      sessionId: session.sessionId,
      conversationId: session.conversationId,
      shell: session.shellLabel,
      cwd: session.cwd,
      backlog: session.backlog,
      alive: session.alive,
    }
  }

  private pushData(session: TerminalSession, raw: string): void {
    const text = redactSecrets(raw).slice(0, CHUNK_MAX_CHARS)
    session.backlog = (session.backlog + text).slice(-BACKLOG_MAX_CHARS)
    const event: TerminalDataEvent = { sessionId: session.sessionId, chunk: text }
    this.options.broadcast(CHANNELS.terminalData, event)
  }

  private settle(session: TerminalSession, code: number | null): void {
    if (!session.alive) return
    session.alive = false
    const event: TerminalExitEvent = { sessionId: session.sessionId, code }
    this.options.broadcast(CHANNELS.terminalExit, event)
  }

  private kill(session: TerminalSession): void {
    if (!session.alive) return
    try {
      if (process.platform === 'win32' && session.child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(session.child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        session.child.kill('SIGKILL')
      }
    } catch {
      // best-effort
    }
    this.settle(session, null)
  }
}
