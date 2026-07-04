/**
 * Shell command execution for the opt-in run_shell_command tool.
 *
 * SAFETY: this is the ONLY module in the app that spawns a shell, and it runs
 * only when the user has enabled shell execution AND approved the specific
 * call. The command runs in the granted project folder, with a timeout and
 * output caps, and its process tree is killed on timeout/abort.
 */

import { spawn } from 'node:child_process'

export interface ShellResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  aborted: boolean
}

const MAX_OUTPUT_BYTES = 64 * 1024

/** Kills a process and (best-effort) its whole tree. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } catch {
      // best-effort
    }
  } else {
    try {
      // Negative pid targets the process group (see detached below).
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }
}

export async function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32', // own process group for tree-kill
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false

    const append = (buf: string, chunk: Buffer): string => {
      if (buf.length >= MAX_OUTPUT_BYTES) return buf
      return (buf + chunk.toString('utf8')).slice(0, MAX_OUTPUT_BYTES)
    }
    child.stdout?.on('data', (c: Buffer) => {
      stdout = append(stdout, c)
    })
    child.stderr?.on('data', (c: Buffer) => {
      stderr = append(stderr, c)
    })

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, timeoutMs)

    const onAbort = (): void => {
      aborted = true
      killTree(child.pid)
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ stdout, stderr, code, timedOut, aborted })
    }

    child.on('error', (err) => {
      stderr = append(stderr, Buffer.from(String(err.message)))
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}
