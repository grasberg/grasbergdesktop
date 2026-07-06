/**
 * Approximate model pricing, used only to show a rough per-message cost
 * estimate next to token usage. Prices change often and vary by region and
 * plan — treat every number here as a dated approximation, not a bill.
 *
 * Values are USD per 1,000,000 tokens. Edit this table to match your provider's
 * current pricing. A model with no entry simply shows no cost (graceful
 * unknown), and custom / OpenAI-compatible providers are intentionally absent.
 *
 * Last reviewed: 2026-07 (approximate list prices; verify with each provider).
 */

import type { ProviderType, TokenUsage } from './types'

export const PRICING_DISCLAIMER =
  'Approximate estimate — provider prices change by region and plan; verify before relying on it.'

export interface ModelPricing {
  /** USD per 1M input (prompt) tokens. */
  inputPerMTok: number
  /** USD per 1M output (completion) tokens. */
  outputPerMTok: number
  /**
   * USD per 1M input tokens that hit the provider's prompt cache. Applied in
   * the estimate when TokenUsage reports cachedInputTokens.
   */
  cachedInputPerMTok?: number
}

/** Keyed by provider type, then by model id. */
export const MODEL_PRICING: Record<ProviderType, Record<string, ModelPricing>> = {
  deepseek: {
    // DeepSeek publishes these directly; cache-hit input is much cheaper.
    'deepseek-chat': { inputPerMTok: 0.27, outputPerMTok: 1.1, cachedInputPerMTok: 0.07 },
    'deepseek-reasoner': { inputPerMTok: 0.55, outputPerMTok: 2.19, cachedInputPerMTok: 0.14 },
  },
  zhipu: {
    // GLM / Zhipu list prices vary (and are often quoted in RMB); approximate.
    'glm-4.6': { inputPerMTok: 0.6, outputPerMTok: 2.0 },
    'glm-4.5': { inputPerMTok: 0.6, outputPerMTok: 2.2 },
    'glm-4.5-air': { inputPerMTok: 0.2, outputPerMTok: 1.1 },
    'glm-4.5-flash': { inputPerMTok: 0, outputPerMTok: 0 }, // free tier
    'glm-4.5v': { inputPerMTok: 0.6, outputPerMTok: 1.8 },
    'glm-4-plus': { inputPerMTok: 0.7, outputPerMTok: 0.7 },
  },
  minimax: {
    'MiniMax-M2': { inputPerMTok: 0.3, outputPerMTok: 1.2 },
    'MiniMax-M1': { inputPerMTok: 0.4, outputPerMTok: 2.2 },
    'MiniMax-Text-01': { inputPerMTok: 0.2, outputPerMTok: 1.1 },
  },
  openai: {
    // OpenAI list prices (USD/1M); approximate and subject to change.
    'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10, cachedInputPerMTok: 1.25 },
    'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6, cachedInputPerMTok: 0.075 },
    'gpt-4.1': { inputPerMTok: 2.0, outputPerMTok: 8.0, cachedInputPerMTok: 0.5 },
    'gpt-4.1-mini': { inputPerMTok: 0.4, outputPerMTok: 1.6, cachedInputPerMTok: 0.1 },
    'o4-mini': { inputPerMTok: 1.1, outputPerMTok: 4.4, cachedInputPerMTok: 0.275 },
    'gpt-5': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  },
  // Z.ai Coding Plan is a flat subscription — per-token cost isn't meaningful.
  'zai-coding': {},
  anthropic: {
    'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
    'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
    'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
    'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
    'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
    'claude-opus-4-5': { inputPerMTok: 5, outputPerMTok: 25 },
  },
  google: {
    'gemini-3.5-flash': { inputPerMTok: 1.5, outputPerMTok: 9 },
    'gemini-3.1-pro-preview': { inputPerMTok: 2, outputPerMTok: 12 },
    'gemini-3.1-flash-lite': { inputPerMTok: 0.25, outputPerMTok: 1.5 },
  },
  bedrock: {
    'us.anthropic.claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
    'us.anthropic.claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
    'us.anthropic.claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  },
  // Custom endpoints have no knowable price — always "unknown".
  'openai-compatible': {},
}

export function findPricing(type: ProviderType, modelId: string): ModelPricing | undefined {
  return MODEL_PRICING[type]?.[modelId]
}

/**
 * Estimated USD cost of one message from its usage and a pricing entry.
 * Returns undefined when there is not enough information to estimate.
 */
export function estimateCost(usage: TokenUsage, pricing: ModelPricing): number | undefined {
  const prompt = usage.promptTokens
  const completion = usage.completionTokens
  if (prompt == null && completion == null) return undefined
  // Cache-hit input tokens bill at the (cheaper) cached rate when known.
  // Providers report promptTokens inclusive of cached tokens, so split them.
  const cached = Math.min(usage.cachedInputTokens ?? 0, prompt ?? 0)
  const cachedRate = pricing.cachedInputPerMTok ?? pricing.inputPerMTok
  const input =
    (((prompt ?? 0) - cached) / 1_000_000) * pricing.inputPerMTok +
    (cached / 1_000_000) * cachedRate
  const output = ((completion ?? 0) / 1_000_000) * pricing.outputPerMTok
  return input + output
}

/** Compact human-readable cost, e.g. "$0.0012" or "<$0.0001" or "free". */
export function formatCost(cost: number): string {
  if (cost <= 0) return 'free'
  if (cost < 0.0001) return '<$0.0001'
  if (cost < 1) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}
