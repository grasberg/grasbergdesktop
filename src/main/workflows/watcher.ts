/**
 * Folder-watch triggers (v42): one fs.watch per workflow whose WatchConfig is
 * enabled. Raw file events are debounced per path, settle-checked (re-stat
 * until the size stops moving — a file mid-copy must not fire), classified as
 * created/changed against a known-files set seeded at watch start (birthtime
 * is unreliable across filesystems), and dispatched through the shared
 * ScheduledRunQueue under the scheduler's exact per-workflow key, so a watch
 * fire can never stampede a workflow its schedule is already running.
 *
 * The watched folder always came from the OS folder picker — a user grant.
 * Watcher failures (folder missing, deleted mid-watch) surface via statusFor()
 * and onError; they never crash and never throw out of sync().
 */

import { watch as fsWatch, readdirSync, statSync, type FSWatcher } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import type { WorkflowRunResult, WorkflowRunTrigger, WorkflowWatchConfig, WorkflowWatchStatus } from '@shared/types'
import type { ScheduledRunQueue } from '../scheduling/run-queue'
import { isLikelyTextFile } from '../ipc/attachments'
import { looksBinary } from '../utils/binary'

/** Payload content is included only for text files up to this size. */
export const WATCH_CONTENT_MAX_BYTES = 256 * 1024

const DEFAULT_DEBOUNCE_MS = 1000
const DEFAULT_SETTLE_MS = 250
const DEFAULT_MAX_SETTLE_CHECKS = 20

export interface WorkflowWatcherDeps {
  listWatched: () => Array<{ id: string; watch: WorkflowWatchConfig }>
  run: (
    workflowId: string,
    trigger: WorkflowRunTrigger,
    payload: string
  ) => Promise<WorkflowRunResult>
  queue: ScheduledRunQueue
  onError?: (workflowId: string, message: string) => void
  /** Settle-loop knobs, injectable so tests never sleep real seconds. */
  settleMs?: number
  maxSettleChecks?: number
}

/**
 * Compiles a glob into an anchored RegExp over '/'-separated paths:
 * `**` matches across separators, `*` within a segment, `?` one character;
 * everything else is literal.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '^'
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          // Globstar: '**/' means zero or more directories, so '**/*.log'
          // also matches files directly in the watch root.
          out += '(?:[^/]*/)*'
          i += 2
        } else {
          out += '.*'
          i++
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(out + '$')
}

/**
 * Matches a watched-folder-relative path ('/'-separated; backslashes are
 * normalized first). An empty glob matches everything; a glob without '/'
 * matches the basename, one with '/' the whole relative path.
 */
export function matchesGlob(relPath: string, glob: string): boolean {
  const pattern = glob.trim()
  if (pattern.length === 0) return true
  const path = relPath.replace(/\\/g, '/')
  const subject = pattern.includes('/') ? path : (path.split('/').pop() ?? path)
  return globToRegExp(pattern).test(subject)
}

/** The Input-node payload for a fired watch event. */
export function buildWatchPayload(
  absPath: string,
  event: 'created' | 'changed',
  info: { size: number; mtimeMs: number },
  content?: string
): string {
  return JSON.stringify({
    path: absPath,
    name: basename(absPath),
    event,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ...(content !== undefined ? { content } : {}),
  })
}

interface WatchEntry {
  configJson: string
  config: WorkflowWatchConfig
  watcher: FSWatcher | null
  /** Relative '/'-paths of files present, for created-vs-changed. */
  known: Set<string>
  /** Per-path debounce timers. */
  pending: Map<string, NodeJS.Timeout>
  lastError: string | null
  closed: boolean
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Files under `folder`, as relative '/'-paths. Best-effort (races tolerated). */
function listFilesRecursive(folder: string): Set<string> {
  const files = new Set<string>()
  try {
    for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const parent = entry.parentPath ?? folder
      files.add(relative(folder, join(parent, entry.name)).replace(/\\/g, '/'))
    }
  } catch {
    // The watcher's own start-time stat already reported a missing folder.
  }
  return files
}

export class WorkflowWatcherService {
  private readonly entries = new Map<string, WatchEntry>()
  /**
   * Last error toasted per workflow. sync() restarts failed entries on EVERY
   * workflow save (the retry-on-sync behavior), so without this dedupe a
   * persistently missing folder re-toasts on each save of ANY workflow.
   */
  private readonly reportedErrors = new Map<string, string>()

  constructor(private readonly deps: WorkflowWatcherDeps) {}

  /** Reconciles running watchers with the stored enabled configs. */
  sync(): void {
    if (process.env.SMOKE_TEST === '1') {
      this.stop()
      return
    }
    const wanted = new Map(this.deps.listWatched().map((w) => [w.id, w.watch]))
    for (const [id, entry] of this.entries) {
      const watch = wanted.get(id)
      // Restart on config change, removal, or an earlier failed start (the
      // folder may exist now — a re-save is the natural retry).
      if (!watch || JSON.stringify(watch) !== entry.configJson || entry.watcher === null) {
        this.close(id)
      }
      // Removed/disabled: a future re-enable should report errors afresh.
      if (!watch) this.reportedErrors.delete(id)
    }
    for (const [id, watch] of wanted) {
      if (!this.entries.has(id)) this.start(id, watch)
    }
  }

  statusFor(workflowId: string): WorkflowWatchStatus {
    const entry = this.entries.get(workflowId)
    return {
      watching: entry !== undefined && entry.watcher !== null,
      lastError: entry?.lastError ?? null,
    }
  }

  /** Quit path: clears every timer and closes every watcher. */
  stop(): void {
    for (const id of [...this.entries.keys()]) this.close(id)
  }

  private close(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.closed = true
    for (const timer of entry.pending.values()) clearTimeout(timer)
    entry.pending.clear()
    try {
      entry.watcher?.close()
    } catch {
      // Teardown only.
    }
    this.entries.delete(id)
  }

  private fail(id: string, entry: WatchEntry, message: string): void {
    entry.lastError = message
    // Mirror close(): a pending debounce timer must not dispatch a run from a
    // dead watcher (and then wipe lastError on success). The entry stays in
    // the map so statusFor still reports the error.
    entry.closed = true
    for (const timer of entry.pending.values()) clearTimeout(timer)
    entry.pending.clear()
    try {
      entry.watcher?.close()
    } catch {
      // Teardown only.
    }
    entry.watcher = null
    // Toast each distinct failure once — not again on every sync() retry.
    if (this.reportedErrors.get(id) !== message) {
      this.reportedErrors.set(id, message)
      this.deps.onError?.(id, message)
    }
  }

  private start(id: string, config: WorkflowWatchConfig): void {
    const entry: WatchEntry = {
      configJson: JSON.stringify(config),
      config,
      watcher: null,
      known: new Set(),
      pending: new Map(),
      lastError: null,
      closed: false,
    }
    this.entries.set(id, entry)
    try {
      if (!statSync(config.folderPath).isDirectory()) {
        throw new Error('not a directory')
      }
    } catch {
      this.fail(id, entry, `The watched folder no longer exists: ${config.folderPath}`)
      return
    }
    entry.known = listFilesRecursive(config.folderPath)
    try {
      const watcher = fsWatch(config.folderPath, { recursive: true }, (_type, filename) => {
        this.onRawEvent(id, entry, filename)
      })
      // Folder deleted mid-watch is an 'error' (EPERM on win32), not an event.
      watcher.on('error', (e: NodeJS.ErrnoException) => {
        if (this.entries.get(id) !== entry) return
        this.fail(id, entry, `Watching ${config.folderPath} failed: ${e.message}`)
      })
      entry.watcher = watcher
      this.reportedErrors.delete(id)
    } catch (e) {
      this.fail(
        id,
        entry,
        `Watching ${config.folderPath} failed: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  private onRawEvent(id: string, entry: WatchEntry, filename: string | Buffer | null): void {
    if (entry.closed || typeof filename !== 'string' || filename.length === 0) return
    const relPath = filename.replace(/\\/g, '/')
    if (!matchesGlob(relPath, entry.config.glob)) return
    const existing = entry.pending.get(relPath)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      entry.pending.delete(relPath)
      void this.settleAndDispatch(id, entry, relPath)
    }, entry.config.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    timer.unref()
    entry.pending.set(relPath, timer)
  }

  private async settleAndDispatch(id: string, entry: WatchEntry, relPath: string): Promise<void> {
    const absPath = join(entry.config.folderPath, relPath)
    const settleMs = this.deps.settleMs ?? DEFAULT_SETTLE_MS
    const maxChecks = this.deps.maxSettleChecks ?? DEFAULT_MAX_SETTLE_CHECKS
    // Re-stat until two consecutive identical size+mtimeMs reads, so a file
    // still being copied fires once, complete — not mid-write. After the cap
    // it fires anyway (a file appended forever would otherwise never trigger).
    let info: { size: number; mtimeMs: number; isFile: boolean } | null = null
    for (let i = 0; i < maxChecks; i++) {
      let st
      try {
        st = await stat(absPath)
      } catch {
        // Deleted (or an atomic-rename save's temp name): never fires.
        entry.known.delete(relPath)
        return
      }
      const current = { size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile() }
      if (info && info.size === current.size && info.mtimeMs === current.mtimeMs) {
        info = current
        break
      }
      info = current
      if (i < maxChecks - 1) await delay(settleMs)
    }
    if (entry.closed || !info || !info.isFile) return

    const kind: 'created' | 'changed' = entry.known.has(relPath) ? 'changed' : 'created'
    entry.known.add(relPath)
    if (kind !== entry.config.event) return

    let content: string | undefined
    if (isLikelyTextFile(basename(relPath)) && info.size <= WATCH_CONTENT_MAX_BYTES) {
      try {
        // A symlink dropped into the watched folder must not smuggle
        // out-of-grant file content into the payload: read only when the
        // REAL path still lives under the granted folder.
        const [realFile, realRoot] = await Promise.all([
          realpath(absPath),
          realpath(entry.config.folderPath),
        ])
        if (realFile.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) {
          const buffer = await readFile(absPath)
          if (!looksBinary(buffer)) content = buffer.toString('utf8')
        }
      } catch {
        // File vanished between stat and read; fire without content.
      }
    }
    if (entry.closed) return

    const payload = buildWatchPayload(absPath, kind, info, content)
    try {
      // The scheduler's exact key: a watch fire while the same workflow's
      // scheduled run is queued coalesces instead of stampeding. A failed run
      // RESOLVES ok:false and is already persisted by the runner; only the
      // pre-start refusals (already running / not found) reject here.
      await this.deps.queue.enqueue(`workflow:${id}`, () => this.deps.run(id, 'watch', payload))
      entry.lastError = null
    } catch (e) {
      const message = e instanceof Error ? e.message : 'The workflow failed to start.'
      entry.lastError = message
      this.deps.onError?.(id, message)
    }
  }
}
