/**
 * Anomaly monitor (v53, dots "a monitoring system can pause or stop a dot if
 * safety concerns are detected"). Watches every tool decision a BOT makes —
 * fed from the activity log's single choke point — and pauses the bot (and
 * stops its running turn) when its behaviour looks like a loop or a runaway:
 *
 * - refusals:  N calls in a row were blocked, declined or stopped by review;
 * - repeats:   the same tool with the same arguments again and again;
 * - burst:     far more tool calls in a short window than real work needs.
 *
 * Pure (clock injected, no Electron, no DB) so the thresholds are tested.
 * A pause is the user's to lift; the reason is shown on the bot and in a
 * notification.
 */

import type { ActivityDecision } from '@shared/types'

export interface AnomalyThresholds {
  /** Consecutive refused calls (blocked / declined / reviewed / handoff). */
  refusalsInARow: number
  /** Identical calls (tool + arguments) within the window. */
  repeats: number
  /** Any tool calls within the window. */
  burst: number
  windowMs: number
}

export const DEFAULT_ANOMALY_THRESHOLDS: AnomalyThresholds = {
  refusalsInARow: 8,
  repeats: 6,
  burst: 80,
  windowMs: 10 * 60_000,
}

export interface ObservedCall {
  agentId: string
  conversationId: string | null
  toolId: string
  decision: ActivityDecision
  /** Raw (already redacted) argument JSON — compared, never stored long. */
  arguments: string
  at: number
}

interface BotWindow {
  refusalsInARow: number
  calls: Array<{ at: number; key: string }>
}

const REFUSED: ReadonlySet<ActivityDecision> = new Set(['blocked', 'declined', 'reviewed', 'handoff'])

/**
 * Looking is not looping: re-reading a page or re-taking a screenshot while
 * waiting for something to change is ordinary browsing, so these actions
 * never count toward the identical-call rule (they still count toward the
 * burst limit).
 */
const OBSERVE_ACTIONS: ReadonlySet<string> = new Set([
  'read',
  'screenshot',
  'cursor_position',
  'wait',
  'logins',
  'list',
  'status',
])

function isObservation(argumentsJson: string): boolean {
  try {
    const parsed = JSON.parse(argumentsJson) as { action?: unknown }
    return typeof parsed.action === 'string' && OBSERVE_ACTIONS.has(parsed.action)
  } catch {
    return false
  }
}

export class AnomalyMonitor {
  private readonly windows = new Map<string, BotWindow>()

  constructor(
    private readonly onAnomaly: (agentId: string, conversationId: string | null, reason: string) => void,
    private readonly thresholds: AnomalyThresholds = DEFAULT_ANOMALY_THRESHOLDS,
    private readonly enabled: () => boolean = () => true
  ) {}

  /** Records one decision; returns the reason when it tripped a threshold. */
  observe(call: ObservedCall): string | null {
    if (!this.enabled()) return null
    const window = this.windows.get(call.agentId) ?? { refusalsInARow: 0, calls: [] }
    this.windows.set(call.agentId, window)
    window.refusalsInARow = REFUSED.has(call.decision) ? window.refusalsInARow + 1 : 0
    const key = `${call.toolId}\u0000${call.arguments.trim()}`
    window.calls = window.calls.filter((entry) => call.at - entry.at <= this.thresholds.windowMs)
    window.calls.push({ at: call.at, key })
    let reason: string | null = null
    if (window.refusalsInARow >= this.thresholds.refusalsInARow) {
      reason = `${window.refusalsInARow} tool calls in a row were refused — it may be stuck trying to get around a rule.`
    } else if (
      !isObservation(call.arguments) &&
      window.calls.filter((entry) => entry.key === key).length >= this.thresholds.repeats
    ) {
      reason = `it repeated the same ${call.toolId} call ${this.thresholds.repeats} times — it looks stuck in a loop.`
    } else if (window.calls.length >= this.thresholds.burst) {
      reason = `it made ${window.calls.length} tool calls in ${Math.round(this.thresholds.windowMs / 60_000)} minutes — far more than normal work needs.`
    }
    if (reason) {
      this.windows.delete(call.agentId) // start fresh after the pause is lifted
      this.onAnomaly(call.agentId, call.conversationId, reason)
    }
    return reason
  }

  /** Forget a bot's history (resumed, reset or deleted). */
  clear(agentId: string): void {
    this.windows.delete(agentId)
  }
}
