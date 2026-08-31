/**
 * Morning brief: a once-daily digest of unreviewed background results, recent
 * failures and today's schedule, generated main-side via generateForWorkflow
 * and stored as the last 7 entries in settings (morningBriefHistory — written
 * only here, deliberately outside the renderer patch surface).
 *
 * Day consumption is tracked by the newest history entry's local dateKey: a
 * failed generation still writes a status 'error' entry, so a misbehaving
 * model is retried tomorrow, not every 30 seconds. A slot missed while the
 * app was closed runs ONCE at the next launch, flagged catchUp (mirroring the
 * scheduled-task catch-up semantics).
 */

import { randomUUID } from 'node:crypto'
import type { MorningBrief, MorningBriefSettings } from '@shared/types'
import { nextRunAt, scheduleLabel } from '@shared/workflow-status'
import type { AppDatabase } from '../db/database'
import { toNormalizedError } from '../providers/errors'
import { redactSecrets } from '../providers/redact'
import { collectInboxItems } from './inbox'
import type { DesktopNotification } from './notify'

const TICK_MS = 30_000
/** Lateness below this is the tick granularity, not a missed slot. */
const CATCH_UP_SLACK_MS = 60_000
const HISTORY_MAX = 7
const CONTENT_MAX = 20_000
const CONTEXT_ITEM_MAX = 15
const ERROR_SNIPPET_MAX = 240
const DAY_MS = 86_400_000

export const ALL_CLEAR_TEXT =
  'All clear this morning — nothing to review, no failures in the last 24 hours, and nothing on today’s schedule.'

/** Local calendar day, 'YYYY-MM-DD'. */
export function localDateKey(at: number): string {
  const d = new Date(at)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** Local wall-clock 'HH:mm' of an epoch, for schedule listings. */
function localTimeLabel(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Today's HH:mm slot as local epoch ms (local Date arithmetic, like
 * nextCalendarSlot, so the slot survives a DST change). Null on malformed time.
 */
export function briefSlotAt(time: string, now: number): number | null {
  const [rawHours, rawMinutes] = time.split(':')
  const hours = Number.parseInt(rawHours ?? '', 10)
  const minutes = Number.parseInt(rawMinutes ?? '', 10)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  const slot = new Date(now)
  slot.setHours(hours, minutes, 0, 0)
  return slot.getTime()
}

/** Whether a brief should run now, and whether it counts as a catch-up. */
export function briefDue(
  cfg: MorningBriefSettings | null,
  newestDateKey: string | null,
  now: number
): { due: boolean; catchUp: boolean } {
  if (!cfg?.enabled) return { due: false, catchUp: false }
  const slot = briefSlotAt(cfg.time, now)
  if (slot === null || now < slot) return { due: false, catchUp: false }
  if (newestDateKey === localDateKey(now)) return { due: false, catchUp: false }
  return { due: true, catchUp: now - slot > CATCH_UP_SLACK_MS }
}

interface BriefResultItem {
  source: string
  title: string
  status: string
  snippet: string
}

export interface BriefContext {
  unreviewed: BriefResultItem[]
  failed24h: BriefResultItem[]
  dueToday: Array<{ name: string; at: string; schedule: string; kind: 'workflow' | 'task' }>
  failingTasks: Array<{ title: string; error: string }>
}

/** Assembles everything the brief may talk about (already-capped snippets only). */
export function collectBriefContext(db: AppDatabase, now: number): BriefContext {
  const today = localDateKey(now)
  const items = collectInboxItems(db).map((i) => ({
    source: i.sourceLabel,
    title: i.title,
    status: i.status,
    snippet: i.snippet,
    finishedAt: i.finishedAt,
    reviewedAt: i.reviewedAt,
  }))
  const strip = ({ source, title, status, snippet }: (typeof items)[number]): BriefResultItem => ({
    source,
    title,
    status,
    snippet,
  })

  const dueToday: BriefContext['dueToday'] = []
  // Anything due now-or-earlier counts as today's schedule: a slot missed
  // while the app was closed runs as a catch-up TODAY, and its stale nextRunAt
  // (yesterday's date) must not hide exactly the runs about to happen.
  for (const workflow of db.workflows.listScheduled()) {
    if (!workflow.schedule) continue
    const at = nextRunAt(workflow, now)
    if (at === null) continue
    if (at > now && localDateKey(at) !== today) continue
    dueToday.push({
      name: workflow.name,
      at: at <= now ? 'due now' : localTimeLabel(at),
      schedule: scheduleLabel(workflow.schedule),
      kind: 'workflow',
    })
  }
  const tasks = db.scheduledTasks.list()
  for (const task of tasks) {
    if (!task.enabled || task.nextRunAt === null) continue
    if (task.nextRunAt > now && localDateKey(task.nextRunAt) !== today) continue
    dueToday.push({
      name: task.title,
      at: task.nextRunAt <= now ? 'due now' : localTimeLabel(task.nextRunAt),
      schedule: task.recurrence,
      kind: 'task',
    })
  }

  return {
    unreviewed: items
      .filter((i) => i.reviewedAt === null)
      .slice(0, CONTEXT_ITEM_MAX)
      .map(strip),
    failed24h: items
      .filter((i) => i.status === 'error' && now - i.finishedAt <= DAY_MS)
      .slice(0, CONTEXT_ITEM_MAX)
      .map(strip),
    dueToday,
    failingTasks: tasks
      .filter((t) => t.lastStatus === 'error')
      .slice(0, CONTEXT_ITEM_MAX)
      .map((t) => ({ title: t.title, error: (t.lastError ?? '').slice(0, ERROR_SNIPPET_MAX) })),
  }
}

export function isEmptyContext(ctx: BriefContext): boolean {
  return (
    ctx.unreviewed.length === 0 &&
    ctx.failed24h.length === 0 &&
    ctx.dueToday.length === 0 &&
    ctx.failingTasks.length === 0
  )
}

export function buildBriefPrompt(ctx: BriefContext, dateLabel: string): string {
  return `You are writing the user's morning brief for ${dateLabel} inside their local AI desktop app. Summarize ONLY the data below as short Markdown: one-line greeting, then sections (skip empty ones): Needs review / Failures in the last 24h / Today's schedule / Tasks stuck failing. Be concrete (names, times, one-line causes), under 200 words, no preamble, no invented items, no code fences.

${JSON.stringify(ctx, null, 2)}`
}

/** Notification copy (DesktopNotifier redacts and trims the body itself). */
export function briefNotification(brief: MorningBrief): DesktopNotification {
  return {
    kind: 'result',
    title: brief.status === 'ok' ? 'Morning brief' : 'Morning brief failed',
    body: brief.status === 'ok' ? brief.content : (brief.error ?? ''),
  }
}

export interface BriefServiceDeps {
  db: AppDatabase
  /** One-shot headless generation (generateForWorkflow, economy-routed). */
  generate: (prompt: string, opts: { agentId?: string }) => Promise<string>
  /** Push to the renderer (generation and dismissal). */
  onBrief?: (brief: MorningBrief) => void
  /** Desktop notification (already gated on cfg.deliverNotification here). */
  notify?: (brief: MorningBrief) => void
  /** Best-effort Telegram send to the paired owner chat. */
  sendTelegram?: (text: string) => Promise<boolean>
  /** Test seam; defaults to Date.now. */
  now?: () => number
}

export class BriefService {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(private readonly deps: BriefServiceDeps) {}

  /** 30s clock with an immediate first tick (no-op when called twice). */
  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Stored briefs, newest first (max 7). */
  list(): MorningBrief[] {
    return this.deps.db.settings.get().morningBriefHistory
  }

  /** Persists a card dismissal. Unknown id is a tolerant no-op. */
  dismiss(id: string): void {
    const history = this.deps.db.settings.get().morningBriefHistory
    const entry = history.find((b) => b.id === id)
    if (!entry || entry.dismissedAt !== null) return
    const updated: MorningBrief = { ...entry, dismissedAt: this.deps.now?.() ?? Date.now() }
    this.deps.db.settings.update({
      morningBriefHistory: history.map((b) => (b.id === id ? updated : b)),
    })
    this.deps.onBrief?.(updated)
  }

  /** One clock tick: generates, stores and delivers when due. Never throws. */
  async tick(now = this.deps.now?.() ?? Date.now()): Promise<void> {
    if (this.running) return
    const { db } = this.deps
    try {
      const settings = db.settings.get()
      const cfg = settings.morningBrief
      const newestDateKey = settings.morningBriefHistory[0]?.dateKey ?? null
      const { due, catchUp } = briefDue(cfg, newestDateKey, now)
      if (!due || !cfg) return
      this.running = true

      const ctx = collectBriefContext(db, now)
      const base = {
        id: randomUUID(),
        dateKey: localDateKey(now),
        generatedAt: Date.now(),
        catchUp,
        dismissedAt: null,
      }
      let entry: MorningBrief
      if (isEmptyContext(ctx)) {
        // Nothing to say: skip the LLM call entirely — deterministic, zero cost.
        entry = { ...base, status: 'ok', content: ALL_CLEAR_TEXT, error: null }
      } else {
        try {
          const text = (
            await this.deps.generate(
              buildBriefPrompt(ctx, new Date(now).toDateString()),
              cfg.agentId ? { agentId: cfg.agentId } : {}
            )
          ).trim()
          // An empty reply must not consume the day as a blank 'ok' card (and
          // an empty-bodied notification) — surface it via the error path.
          entry = text
            ? { ...base, status: 'ok', content: text.slice(0, CONTENT_MAX), error: null }
            : { ...base, status: 'error', content: '', error: 'The model returned an empty brief.' }
        } catch (e) {
          entry = {
            ...base,
            status: 'error',
            content: '',
            error: toNormalizedError(e).message.slice(0, 4000),
          }
        }
      }

      // Patch ONLY the history key (settings writes are per-key rows).
      db.settings.update({
        morningBriefHistory: [entry, ...db.settings.get().morningBriefHistory].slice(
          0,
          HISTORY_MAX
        ),
      })
      this.deps.onBrief?.(entry)
      // The failure notification still fires — a silently failing daily brief
      // would otherwise be invisible; the Telegram send is content-only.
      if (cfg.deliverNotification) this.deps.notify?.(entry)
      if (cfg.deliverTelegram && entry.status === 'ok') {
        await this.deps.sendTelegram?.(entry.content)
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error('[brief]', redactSecrets(message))
    } finally {
      this.running = false
    }
  }
}
