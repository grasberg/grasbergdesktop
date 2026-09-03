/**
 * Dreaming: automatic memory consolidation. Once a day (while both
 * settings.memoryEnabled and settings.dreamingEnabled are on and the memory
 * list has actually changed), the saved memories are sent to the default
 * model, which returns merge/rewrite/delete operations that keep the list
 * small, current and duplicate-free. The manual "Consolidate now" action in
 * Settings → Memory calls dreamNow(true), which skips the auto gates.
 *
 * Memories have OWNERS (v32): the shared pool (agent_id NULL) and one private
 * recollection per agent profile / bot. Consolidation runs per NAMESPACE —
 * one model call for the shared pool, one per bot that holds memories — and
 * never mixes them, so a bot's fact can never be rewritten into another bot's
 * recollection or into the user's shared pool. Creations inherit the
 * namespace's owner; each namespace keeps its own last-run watermark in
 * `meta` (`dreaming_last_run_at` for the shared pool, unchanged since v14;
 * `dreaming_last_run_at:<agentId>` per bot).
 *
 * The run is deliberately conservative: the response is zod-validated,
 * operations referencing unknown ids are dropped, everything is applied in a
 * single transaction, and a response that would wipe the list (delete
 * everything, create nothing) is rejected wholesale.
 */

import { z } from 'zod'
import type { DreamResult, Memory } from '@shared/types'
import type { AppDatabase } from '../db/database'
import { ProviderError } from '../providers/errors'
import { redactSecrets } from '../providers/redact'

export interface DreamingDeps {
  db: AppDatabase
  /**
   * One-shot, conversation-less generation on the global default
   * provider/model (chatService.generateForWorkflow in production).
   */
  generate: (prompt: string, opts: { json: boolean }) => Promise<string>
  /** Test seam; defaults to Date.now. */
  now?: () => number
}

/** One namespace to consolidate: the shared pool (null) or one bot's memories. */
export interface DreamScope {
  agentId: string | null
}

/** Auto-dream at most once per day (per namespace). */
const DREAM_INTERVAL_MS = 24 * 60 * 60_000
/** Below this many memories an automatic run is not worth an LLM call. */
const DREAM_MIN_MEMORIES = 5
/** First auto check shortly after boot (lets providers/keys settle). */
const BOOT_DELAY_MS = 2 * 60_000
/** Recurring gate check; the actual run is still bound by DREAM_INTERVAL_MS. */
const CHECK_INTERVAL_MS = 60 * 60_000
/** meta-table key recording the last completed model run (shared pool). */
const LAST_RUN_META_KEY = 'dreaming_last_run_at'

const metaKey = (agentId: string | null): string =>
  agentId === null ? LAST_RUN_META_KEY : `${LAST_RUN_META_KEY}:${agentId}`

// Same caps as memoryInputSchema (shared/schemas.ts); content additionally
// requires non-whitespace so a consolidation can never blank a memory.
const titleSchema = z.string().trim().min(1).max(200)
const contentSchema = z
  .string()
  .max(10_000)
  .refine((s) => s.trim().length > 0, 'content must not be empty')

const dreamOperationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('update'), id: z.string(), title: titleSchema, content: contentSchema }),
  z.object({ action: z.literal('delete'), id: z.string() }),
  z.object({ action: z.literal('create'), title: titleSchema, content: contentSchema }),
])

const dreamResponseSchema = z.object({
  operations: z.array(dreamOperationSchema).max(200),
})

type DreamOperation = z.infer<typeof dreamOperationSchema>

function skipped(count: number): DreamResult {
  return { ran: false, before: count, after: count, updated: 0, removed: 0, created: 0 }
}

function buildPrompt(memories: Memory[], owner: { name: string } | null): string {
  const list = memories.map((m) => ({
    id: m.id,
    title: m.title,
    content: m.content,
    updatedAt: new Date(m.updatedAt).toISOString(),
  }))
  const subject = owner
    ? `the persistent memory of the AI bot "${owner.name}" — its private recollection, kept separate from the user's shared memory`
    : 'the persistent memory of an AI assistant'
  const source = owner ? 'this bot saved over many of its conversations and runs' : 'the assistant saved over many conversations'
  return `You are consolidating ${subject} ("dreaming"). The memories below are durable facts ${source}. Tidy them: merge entries about the same topic, rewrite entries whose details are outdated by newer ones, and delete entries that are obsolete or fully covered elsewhere.

Respond with ONLY a JSON object of this shape (no prose, no code fence):
{"operations": [
  {"action": "update", "id": "<existing id>", "title": "...", "content": "..."},
  {"action": "delete", "id": "<existing id>"},
  {"action": "create", "title": "...", "content": "..."}
]}

Rules:
- "update" replaces a memory's title and content in full; "create" adds a merged memory (delete the sources it absorbed); "delete" removes a memory.
- Preserve every durable fact — consolidation must never lose information, only restate it more compactly. When entries conflict, trust the most recently updated one.
- Keep titles short descriptive slugs; keep each memory focused on one topic.
- Do NOT invent facts, and do not rewrite entries that are already fine.
- If the list is already well consolidated, respond {"operations": []}.

Saved memories (JSON):
${JSON.stringify(list, null, 2)}`
}

/**
 * Tolerant JSON extraction: models wrap JSON in prose or \`\`\`json fences
 * despite instructions. Falls back to the outermost {...} span.
 */
function extractJson(text: string): unknown | null {
  const candidates = [text.trim()]
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // try the next candidate
    }
  }
  return null
}

interface OwnerRun {
  agentId: string | null
  agentName: string | null
  result: DreamResult
}

/**
 * Sums the per-namespace results. `perOwner` is attached only when at least
 * one bot namespace was part of the run — a shared-only run reports exactly
 * what it always did.
 */
function aggregate(runs: OwnerRun[]): DreamResult {
  const sum = (key: 'before' | 'after' | 'updated' | 'removed' | 'created'): number =>
    runs.reduce((n, run) => n + run.result[key], 0)
  const base: DreamResult = {
    ran: runs.some((run) => run.result.ran),
    before: sum('before'),
    after: sum('after'),
    updated: sum('updated'),
    removed: sum('removed'),
    created: sum('created'),
  }
  return runs.some((run) => run.agentId !== null)
    ? { ...base, perOwner: runs.map((run) => ({ ...run })) }
    : base
}

export class DreamingService {
  private bootTimer: NodeJS.Timeout | null = null
  private checkTimer: NodeJS.Timeout | null = null
  private running = false

  constructor(private readonly deps: DreamingDeps) {}

  /** Schedules the automatic checks (no-op when called twice). */
  start(): void {
    if (this.bootTimer || this.checkTimer) return
    this.bootTimer = setTimeout(() => void this.maybeDream(), BOOT_DELAY_MS)
    this.checkTimer = setInterval(() => void this.maybeDream(), CHECK_INTERVAL_MS)
    // Never keep the process alive just for dreaming.
    this.bootTimer.unref?.()
    this.checkTimer.unref?.()
  }

  stop(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer)
    if (this.checkTimer) clearInterval(this.checkTimer)
    this.bootTimer = null
    this.checkTimer = null
  }

  /** Auto path: gate errors are swallowed — dreaming is strictly best-effort. */
  async maybeDream(): Promise<void> {
    try {
      await this.dreamNow(false)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error('[dreaming]', redactSecrets(message))
    }
  }

  /**
   * Runs one consolidation over every namespace (or just `scope`). `force`
   * (the manual "Consolidate now" action) skips the enabled/interval/min-count
   * gates — mirroring how /compact works regardless of compactionEnabled —
   * and lets errors propagate to the caller. A failing namespace never starves
   * the others: it is logged, and only when NO namespace ran is the first
   * error rethrown.
   */
  async dreamNow(force: boolean, scope?: DreamScope): Promise<DreamResult> {
    const { db } = this.deps
    // Cheap gates first: the hourly auto check must not read the whole
    // memories table when dreaming/memory are switched off anyway.
    if (!force) {
      const settings = db.settings.get()
      if (!settings.memoryEnabled || !settings.dreamingEnabled) return skipped(0)
    }
    if (this.running) return skipped(0)
    this.running = true
    try {
      const owners = scope ? [scope.agentId] : this.eligibleOwners()
      const runs: OwnerRun[] = []
      let firstError: unknown = null
      for (const agentId of owners) {
        const agentName = agentId ? (db.agents.getById(agentId)?.name ?? null) : null
        try {
          runs.push({ agentId, agentName, result: await this.dreamOwner(agentId, agentName, force) })
        } catch (e) {
          firstError ??= e
          const message = e instanceof Error ? e.message : String(e)
          console.error(`[dreaming] ${agentName ?? 'shared'} namespace failed:`, redactSecrets(message))
        }
      }
      if (firstError !== null && !runs.some((run) => run.result.ran)) throw firstError
      return aggregate(runs)
    } finally {
      this.running = false
    }
  }

  /**
   * The shared pool plus every LIVE agent that holds memories. Memories of a
   * deleted profile are inert (nothing injects them) — consolidating them
   * would cost a model call for nothing.
   */
  private eligibleOwners(): Array<string | null> {
    const live = new Set(this.deps.db.agents.list().map((agent) => agent.id))
    return this.deps.db.memories.listOwners().filter((id) => id === null || live.has(id))
  }

  private async dreamOwner(
    agentId: string | null,
    agentName: string | null,
    force: boolean
  ): Promise<DreamResult> {
    const { db } = this.deps
    const now = this.deps.now?.() ?? Date.now()
    // Exactly this owner's memories — never shared+agent — so a rewrite can
    // only ever restate facts that already belonged to this namespace.
    const memories = db.memories.listForAgent(agentId)
    // Nothing to consolidate against — even a forced run needs two entries.
    if (memories.length < 2) return skipped(memories.length)

    if (!force) {
      if (memories.length < DREAM_MIN_MEMORIES) return skipped(memories.length)
      const lastRun = this.readLastRunAt(agentId)
      if (now - lastRun < DREAM_INTERVAL_MS) return skipped(memories.length)
      // No memory touched since the last dream: nothing new to consolidate.
      if (!memories.some((m) => m.updatedAt > lastRun)) return skipped(memories.length)
    }

    const owner = agentId ? { name: agentName ?? 'bot' } : null
    const text = await this.deps.generate(buildPrompt(memories, owner), { json: true })
    // The model did complete a pass — record it even if the response turns
    // out unusable, so a misbehaving model is retried daily, not hourly.
    this.writeLastRunAt(agentId, now)

    const parsed = dreamResponseSchema.safeParse(extractJson(text))
    if (!parsed.success) {
      throw new ProviderError(
        'invalid_request',
        'The model returned an unusable consolidation response — no memories were changed.'
      )
    }
    const result = this.apply(memories, parsed.data.operations, agentId)
    // Re-stamp after applying: the ops themselves touch updatedAt, which
    // must not count as "new activity" for the next auto gate.
    this.writeLastRunAt(agentId, this.deps.now?.() ?? Date.now())
    return result
  }

  /** Validates ids against the snapshot and applies all ops in one transaction. */
  private apply(
    memories: Memory[],
    operations: DreamOperation[],
    agentId: string | null
  ): DreamResult {
    const { db } = this.deps
    const snapshot = new Map(memories.map((m) => [m.id, m]))
    const valid = operations.filter((op) => op.action === 'create' || snapshot.has(op.id))

    const created = valid.filter((op) => op.action === 'create').length
    // A response that empties the list wholesale is a model failure, not a
    // consolidation — refuse it entirely.
    if (valid.filter((op) => op.action === 'delete').length >= memories.length && created === 0) {
      throw new ProviderError(
        'invalid_request',
        'The model tried to delete every memory — no memories were changed.'
      )
    }

    let removed = 0
    let updated = 0
    db.driver.transaction(() => {
      // Rows this run already wrote are newer than the snapshot by construction.
      const touched = new Set<string>()
      for (const op of valid) {
        if (op.action === 'create') {
          // A merged memory stays in the namespace it was merged from.
          db.memories.create({ title: op.title, content: op.content, agentId })
          continue
        }
        // The ops were derived from a snapshot taken before the (slow) model
        // call; a memory the user or another conversation touched since is
        // newer than the text the model judged, so that edit wins.
        const current = db.memories.getById(op.id)
        if (!current) continue
        if (!touched.has(op.id) && current.updatedAt > (snapshot.get(op.id)?.updatedAt ?? 0)) {
          continue
        }
        if (op.action === 'update') {
          db.memories.update(op.id, { title: op.title, content: op.content })
          touched.add(op.id)
          updated += 1
        } else {
          db.memories.remove(op.id)
          removed += 1
        }
      }
    })

    return {
      ran: true,
      before: memories.length,
      after: memories.length - removed + created,
      updated,
      removed,
      created,
    }
  }

  private readLastRunAt(agentId: string | null): number {
    const row = this.deps.db.driver.get<{ value: string }>(
      'SELECT value FROM meta WHERE key = ?',
      [metaKey(agentId)]
    )
    const at = row ? Number.parseInt(row.value, 10) : 0
    return Number.isFinite(at) && at > 0 ? at : 0
  }

  private writeLastRunAt(agentId: string | null, at: number): void {
    this.deps.db.driver.run(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [metaKey(agentId), String(at)]
    )
  }
}
