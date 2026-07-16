/**
 * The Work panel's Terminal tab: a lightweight, pipes-based console bound to
 * the task's folder. One persistent shell per conversation lives in main;
 * this component attaches to it (replaying scrollback), streams its output,
 * and sends the lines the user types. Line-oriented by design — command →
 * output flows work; full-screen TUI apps do not.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { TerminalSessionInfo } from '@shared/types'
import { toNormalized, unwrap } from '@/api/uld'
import { useChatStore } from '@/stores/chat'

const SCROLLBACK_MAX_CHARS = 256 * 1024

/** Strips ANSI escape/control sequences the dumb renderer cannot draw. */
export function stripAnsi(text: string): string {
  return (
    text
      // CSI sequences: ESC [ params intermediates final (colors, cursor moves).
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // OSC sequences: ESC ] ... terminated by BEL or ESC backslash (titles).
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
      // Any remaining lone ESC + one char (SS2/SS3 and friends).
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b./g, '')
      // Bare carriage returns (progress bars) become line breaks.
      .replace(/\r(?!\n)/g, '\n')
  )
}

export default function TerminalTab(): ReactElement {
  const conversation = useChatStore((s) => s.conversation)
  const [session, setSession] = useState<TerminalSessionInfo | null>(null)
  const [output, setOutput] = useState('')
  const [command, setCommand] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [exited, setExited] = useState<number | null | 'running'>('running')
  const scrollRef = useRef<HTMLPreElement | null>(null)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)

  const conversationId = conversation?.id ?? null

  useEffect(() => {
    if (!conversationId) return
    let disposed = false
    let offData: (() => void) | undefined
    let offExit: (() => void) | undefined

    const attach = async (): Promise<void> => {
      try {
        const info = await unwrap(window.uld.terminal.create(conversationId))
        if (disposed) return
        setSession(info)
        setExited(info.alive ? 'running' : null)
        setOutput(stripAnsi(info.backlog))
        offData = window.uld.terminal.onData((event) => {
          if (event.sessionId !== info.sessionId) return
          setOutput((prev) => (prev + stripAnsi(event.chunk)).slice(-SCROLLBACK_MAX_CHARS))
        })
        offExit = window.uld.terminal.onExit((event) => {
          if (event.sessionId !== info.sessionId) return
          setExited(event.code)
        })
      } catch (e) {
        if (!disposed) setError(toNormalized(e).message)
      }
    }
    void attach()

    return () => {
      disposed = true
      offData?.()
      offExit?.()
      // The session itself stays alive in main — it belongs to the task, not
      // the tab; re-opening the tab re-attaches with scrollback.
    }
  }, [conversationId])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [output])

  const send = async (): Promise<void> => {
    if (!session || !command.trim() || exited !== 'running') return
    const line = command
    setCommand('')
    historyRef.current = [line, ...historyRef.current.filter((h) => h !== line)].slice(0, 100)
    historyIndexRef.current = -1
    // POSIX shells execute piped lines silently, so echo the command locally
    // for a natural transcript (cmd.exe echoes its own prompt as well).
    setOutput((prev) => (prev + `$ ${line}\n`).slice(-SCROLLBACK_MAX_CHARS))
    try {
      await unwrap(window.uld.terminal.input(session.sessionId, `${line}\n`))
    } catch (e) {
      setError(toNormalized(e).message)
    }
  }

  const restart = async (): Promise<void> => {
    if (!conversationId) return
    setError(null)
    try {
      if (session) await unwrap(window.uld.terminal.dispose(session.sessionId))
      const info = await unwrap(window.uld.terminal.create(conversationId))
      setSession(info)
      setOutput(stripAnsi(info.backlog))
      setExited('running')
    } catch (e) {
      setError(toNormalized(e).message)
    }
  }

  const historyStep = (direction: 1 | -1): void => {
    const history = historyRef.current
    if (history.length === 0) return
    const next = Math.min(history.length - 1, Math.max(-1, historyIndexRef.current + direction))
    historyIndexRef.current = next
    setCommand(next === -1 ? '' : history[next])
  }

  if (!conversationId) return <div className="terminal-empty">Open a task to use the terminal.</div>
  if (error) {
    return (
      <div className="terminal-empty" role="alert">
        <p>{error}</p>
        <button type="button" className="btn" onClick={() => void restart()}>
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="terminal-tab">
      <header className="terminal-header">
        <span className="terminal-title mono" title={session?.cwd ?? ''}>
          {session ? session.shell : 'Starting…'}
        </span>
        <span className="terminal-hint">
          {exited === 'running'
            ? 'Line-based console — TUI apps (vim, htop) are not supported'
            : `Shell exited${typeof exited === 'number' ? ` (code ${exited})` : ''}`}
        </span>
        <button
          type="button"
          className="btn btn-ghost terminal-restart"
          title="Kill the shell and start a fresh one"
          onClick={() => void restart()}
        >
          Restart
        </button>
      </header>
      <pre className="terminal-scrollback mono" ref={scrollRef} aria-live="polite">
        {output || '(no output yet)'}
      </pre>
      <div className="terminal-input-row">
        <span className="terminal-prompt mono" aria-hidden>
          $
        </span>
        <input
          className="input terminal-input mono"
          type="text"
          value={command}
          placeholder={exited === 'running' ? 'Type a command and press Enter…' : 'Shell exited'}
          disabled={!session || exited !== 'running'}
          aria-label="Terminal command"
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              historyStep(1)
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              historyStep(-1)
            }
          }}
        />
      </div>
    </div>
  )
}
