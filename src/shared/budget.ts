/**
 * Budget guardrails (v44): pure helpers shared by main (enforcement, ledger)
 * and the renderer (HUD copy). Caps count only priced spend — a model with no
 * pricing entry contributes nothing to any cap, and the UI must say so.
 */

import { findPricing, type ModelPricing } from './pricing'
import { presetPricing } from './presets'
import type { ProviderType } from './types'

/** What kind of headless run a headless_usage row belongs to. */
export type HeadlessRunKind =
  | 'workflow'
  | 'scheduled_task'
  | 'agent_run'
  | 'arena'
  | 'brief'
  | 'other'

/** Start of the local calendar month containing `now` (unix ms). */
export function monthStartMs(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

/**
 * Pricing for a provider's model: preset-backed providers (type
 * 'openai-compatible') price from the preset catalog, direct families from the
 * static table. Undefined = unpriced (excluded from caps).
 */
export function resolvePricing(
  type: ProviderType,
  presetId: string | null | undefined,
  modelId: string
): ModelPricing | undefined {
  return presetId ? presetPricing(presetId, modelId) : findPricing(type, modelId)
}

/**
 * Conservative preflight estimate for one upcoming call (2k input + 2k output
 * tokens — the autoRoutingMaxCostUsd precedent). 0 for unpriced models, so an
 * unpriced call is never blocked by a cap it cannot count toward.
 */
export function nextCallEstimateUsd(pricing?: ModelPricing): number {
  if (!pricing) return 0
  return ((pricing.inputPerMTok + pricing.outputPerMTok) * 2_000) / 1_000_000
}

/** Marker every budget-refusal message starts with (matched by tests/UI). */
export const BUDGET_CAP_REACHED = 'Monthly budget reached'

export const BUDGET_UNPRICED_NOTE =
  'Estimates only — unpriced models are excluded from caps and totals.'
