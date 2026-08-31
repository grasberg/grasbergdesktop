/**
 * Minimal production crash log. A packaged Electron GUI app has no console, so
 * a main-process error that isn't caught elsewhere would otherwise vanish and
 * leave a user with nothing to report. This appends redacted, timestamped
 * entries to `<userData>/logs/main.log` and installs process-level handlers for
 * the two errors that escape the normal IPC try/catch: uncaught exceptions and
 * unhandled promise rejections.
 *
 * Deliberately tiny and dependency-free (no electron-log): the routing rules
 * — always redact, cap the file, never throw — stay obvious and testable.
 */

import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '../providers/redact'

/** Roll the log once it passes this; keep exactly one previous generation. */
const MAX_LOG_BYTES = 2 * 1024 * 1024

let logFile: string | null = null
let handlersInstalled = false

/** Where entries go. Called once installCrashLogging has a userData path. */
function ensureLogFile(userDataPath: string): string | null {
  if (logFile) return logFile
  try {
    const dir = join(userDataPath, 'logs')
    mkdirSync(dir, { recursive: true })
    logFile = join(dir, 'main.log')
    return logFile
  } catch {
    // A logger that can't create its own directory must not break the app.
    return null
  }
}

/** Appends one redacted line, rolling the file when it grows too large. */
export function logMainError(context: string, error: unknown): void {
  if (!logFile) return
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  const line = `[${new Date().toISOString()}] ${context}: ${redactSecrets(detail)}\n`
  try {
    if (existsSync(logFile) && statSync(logFile).size + line.length > MAX_LOG_BYTES) {
      // One generation of history is enough to diagnose the crash that rolled it.
      try {
        renameSync(logFile, `${logFile}.1`)
      } catch {
        // If the roll fails, fall through and keep appending — a large log
        // beats a lost one.
      }
    }
    appendFileSync(logFile, line)
  } catch {
    // Best-effort only; logging must never itself throw into a handler.
  }
}

/**
 * Wires the file location and the two escape-hatch handlers. `userDataPath`
 * comes from app.getPath('userData'); passed in rather than imported so this
 * module carries no electron dependency (and stays unit-testable).
 */
export function installCrashLogging(userDataPath: string): void {
  if (!ensureLogFile(userDataPath)) return
  if (handlersInstalled) return
  handlersInstalled = true
  process.on('uncaughtException', (error) => {
    handleUncaughtException(error)
  })
  process.on('unhandledRejection', (reason) => {
    logMainError('unhandledRejection', reason)
  })
  // A plain marker (no stack) so a log always shows when the session began.
  logMainError('session-start', 'Grasberg main process started.')
}

/** Log synchronously, then terminate: continuing after an unknown exception is unsafe. */
export function handleUncaughtException(
  error: unknown,
  exit: (code: number) => unknown = (code) => process.exit(code)
): void {
  logMainError('uncaughtException', error)
  exit(1)
}
