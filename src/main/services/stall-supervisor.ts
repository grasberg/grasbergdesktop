/**
 * Stall supervisor for agentic tool loops (AVO-style self-supervision).
 *
 * A long agent run can stall: the model keeps issuing calls that all fail
 * (unknown tool, bad arguments, denied approvals) without changing strategy.
 * Left alone it burns rounds until the hard cap. The supervisor counts
 * CONSECUTIVE unproductive rounds and intervenes at two thresholds:
 *
 * - NUDGE: inject a short redirection note into the conversation so the model
 *   reconsider its approach before the next round.
 * - STOP: end the generation with an explanatory note, like the round cap.
 *
 * Pure functions only — unit-tested without any stream machinery.
 */

/** Consecutive unproductive rounds before a redirect note is injected. */
export const STALL_NUDGE_ROUNDS = 4
/** Consecutive unproductive rounds before the generation is stopped. */
export const STALL_STOP_ROUNDS = 12

/**
 * True when a tool result tells us the call could not do its job. Mirrors the
 * executor's error prefixes plus the declined-approval sentinel; anything else
 * (including output that merely mentions "Error") counts as progress — the
 * model got real information back.
 */
export function isUnproductiveToolResult(result: string): boolean {
  return (
    result === 'User declined this tool call.' ||
    result.startsWith('Error:') ||
    result.startsWith('The user has denied') ||
    result.startsWith('Plan mode is active')
  )
}

/** A round was productive if ANY of its results did real work. */
export function roundWasProductive(results: string[]): boolean {
  return results.some((result) => !isUnproductiveToolResult(result))
}

/**
 * The nudge to inject after `count` consecutive unproductive rounds, or null
 * when no nudge is due yet (only every NUDGE-th round triggers one).
 */
export function stallNudge(count: number): string | null {
  if (count < STALL_NUDGE_ROUNDS || count % STALL_NUDGE_ROUNDS !== 0) return null
  if (count >= STALL_STOP_ROUNDS) return null
  return (
    `SUPERVISOR NOTE: The last ${count} tool rounds produced no successful work ` +
    '(every call errored or was declined). Stop retrying the same approach. ' +
    'Re-read the task, pick a materially different strategy (different tool, ' +
    'smaller step, different file), and continue.'
  )
}

/** Appended to the message when the stall limit stops the loop. */
export const STALL_LIMIT_NOTE =
  '[Supervisor: the last rounds produced no successful tool work — stopping here ' +
  'to avoid burning further rounds on a stuck approach.]'
