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
/** child_process's error code when a stream exceeded maxBuffer. */
const MAXBUFFER_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

export interface GitQueryResult {
  ok: boolean
  output: string
}

/** Runs `git <argv>` in `cwd` (no shell). Output past the cap is truncated. */
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
        // Exceeding maxBuffer kills the child and reports an error, but the
        // output captured up to the cap is still handed back: a big diff/log is
        // a truncation, not a failure.
        if (error && (error as NodeJS.ErrnoException).code === MAXBUFFER_CODE) {
          resolvePromise({
            ok: true,
            output: `${stdout}\n…[truncated at ${GIT_MAX_OUTPUT / 1024}KB]`,
          })
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
