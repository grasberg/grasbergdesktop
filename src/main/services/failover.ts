/**
 * Reliability Autopilot: pure chain-walk helpers plus the synthetic
 * activity-log entry for a provider failover. No stream machinery here
 * (pattern: stall-supervisor.ts) — unit-tested standalone; the chat service
 * owns the actual walk.
 */

import type { FailoverChainEntry, FailoverReason, ProviderErrorCode } from '@shared/types'
import type { ActivityRepository } from '../db/repositories/activity'

/**
 * Transient-unavailability codes eligible for failover. Overload/unavailable
 * responses normalize into 'rate_limit' (429) and 'server' (5xx incl. 529).
 * auth/aborted/invalid_request/context_length/not_supported/unknown never
 * fail over — a different model cannot fix those, or the user asked to stop.
 */
export const FAILOVER_ERROR_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  'rate_limit',
  'server',
  'network',
  'timeout',
])

export function isFailoverEligible(code: ProviderErrorCode): boolean {
  return FAILOVER_ERROR_CODES.has(code)
}

/**
 * First chain entry whose provider+model pair has not been attempted this
 * turn (the primary counts as attempted), or null when the chain is exhausted.
 */
export function nextChainEntry(
  chain: FailoverChainEntry[] | undefined,
  attempted: ReadonlyArray<{ providerId: string; modelId: string }>
): FailoverChainEntry | null {
  for (const entry of chain ?? []) {
    const tried = attempted.some(
      (a) => a.providerId === entry.providerId && a.modelId === entry.modelId
    )
    if (!tried) return entry
  }
  return null
}

export interface FailoverActivityInput {
  /** Null for conversation-less headless runs (generateForWorkflow). */
  conversationId: string | null
  from: { providerId: string; providerLabel: string; modelId: string }
  to: { providerId: string; providerLabel: string; modelId: string }
  code: FailoverReason
  context: 'interactive' | 'headless'
}

/**
 * Records one failover hop as a synthetic 'provider_failover' activity entry
 * (decision 'auto') — written directly, never through the tool executor.
 * Best-effort: the log must never fail the generation it describes. Only
 * app-side ids/labels/codes are written, so no redact pass is needed.
 */
export function recordFailoverActivity(
  activity: ActivityRepository,
  input: FailoverActivityInput
): void {
  try {
    activity.record({
      at: Date.now(),
      conversationId: input.conversationId,
      agentName: null,
      toolId: 'provider_failover',
      toolName: 'provider_failover',
      risk: 'safe',
      decision: 'auto',
      detail: `${input.code} → ${input.to.providerLabel} · ${input.to.modelId}`,
      arguments: JSON.stringify({
        from: input.from,
        to: input.to,
        code: input.code,
        context: input.context,
      }),
      result: '',
      changeId: null,
    })
  } catch {
    // Best-effort.
  }
}
