/**
 * Read-only git queries for the 'git' tool.
 *
 * SAFETY: commands are spawned WITHOUT a shell from a fixed argv allowlist
 * built by the executor's runGit — the model chooses an action ('status' |
 * 'diff' | 'log') and at most a validated relative path; it can never inject
 * flags or subcommands. Nothing here can mutate a repository.
 */

import { execFile } from 'node:child_process'

const GIT_TIMEOUT_MS = 15_000
const GIT_MAX_OUTPUT = 64 * 1024

export interface GitQueryResult {
  ok: boolean
  output: string
}

/** Runs `git <argv>` in `cwd` (no shell). Returns combined, capped output. */
export function runGitQuery(argv: string[], cwd: string): Promise<GitQueryResult> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      argv,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolvePromise({ ok: false, output: 'git is not installed or not on PATH.' })
          return
        }
        if (error && error.killed) {
          resolvePromise({ ok: false, output: 'git timed out.' })
          return
        }
        if (error) {
          const message = (stderr || error.message || 'git failed').trim()
          resolvePromise({ ok: false, output: message })
          return
        }
        resolvePromise({ ok: true, output: stdout })
      }
    )
  })
}
