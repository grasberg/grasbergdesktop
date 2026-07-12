import { describe, expect, it } from 'vitest'
import { PROVIDER_TYPES } from '../../src/shared/catalog'
import { estimateCost, findPricing, formatCost, MODEL_PRICING } from '../../src/shared/pricing'

describe('findPricing', () => {
  it('returns pricing for a known model and undefined for unknown', () => {
    expect(findPricing('deepseek', 'deepseek-chat')).toBeDefined()
    expect(findPricing('deepseek', 'no-such-model')).toBeUndefined()
    // Custom providers never have a price.
    expect(findPricing('openai-compatible', 'anything')).toBeUndefined()
  })

  // A new provider starts on its family default, and an unpriced model is
  // silently excluded from auto-routing — so a catalog default bump must never
  // outrun this table. Families with an empty table (flat-rate, custom) exempt.
  it('prices every family default model', () => {
    for (const meta of Object.values(PROVIDER_TYPES)) {
      if (Object.keys(MODEL_PRICING[meta.type]).length === 0) continue
      expect(
        findPricing(meta.type, meta.defaultModelId),
        `${meta.type} default '${meta.defaultModelId}' has no pricing entry`
      ).toBeDefined()
    }
  })

  it('covers every model with sane, non-negative numbers', () => {
    for (const byModel of Object.values(MODEL_PRICING)) {
      for (const p of Object.values(byModel)) {
        expect(p.inputPerMTok).toBeGreaterThanOrEqual(0)
        expect(p.outputPerMTok).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('estimateCost', () => {
  it('sums input and output at the per-1M rates', () => {
    const pricing = { inputPerMTok: 1, outputPerMTok: 2 }
    // 1,000,000 prompt * $1 + 500,000 completion * $2 = 1 + 1 = 2
    const cost = estimateCost({ promptTokens: 1_000_000, completionTokens: 500_000 }, pricing)
    expect(cost).toBeCloseTo(2, 6)
  })

  it('handles a missing token field and returns undefined when both are absent', () => {
    const pricing = { inputPerMTok: 1, outputPerMTok: 2 }
    expect(estimateCost({ completionTokens: 1_000_000 }, pricing)).toBeCloseTo(2, 6)
    expect(estimateCost({ totalTokens: 5 }, pricing)).toBeUndefined()
  })

  it('bills cache-hit input tokens at the cached rate when known', () => {
    const pricing = { inputPerMTok: 1, outputPerMTok: 2, cachedInputPerMTok: 0.1 }
    // 1M prompt of which 500k cached: 0.5 * $1 + 0.5 * $0.1 = 0.55
    const cost = estimateCost({ promptTokens: 1_000_000, cachedInputTokens: 500_000 }, pricing)
    expect(cost).toBeCloseTo(0.55, 6)
    // Without a cached rate, cached tokens bill at the normal rate.
    const flat = estimateCost(
      { promptTokens: 1_000_000, cachedInputTokens: 500_000 },
      { inputPerMTok: 1, outputPerMTok: 2 }
    )
    expect(flat).toBeCloseTo(1, 6)
    // A cached count larger than the prompt is clamped, never negative.
    const clamped = estimateCost({ promptTokens: 100, cachedInputTokens: 200 }, pricing)
    expect(clamped).toBeGreaterThanOrEqual(0)
  })
})

describe('formatCost', () => {
  it('formats small, tiny, and free costs readably', () => {
    expect(formatCost(0)).toBe('free')
    expect(formatCost(0.00005)).toBe('<$0.0001')
    expect(formatCost(0.0012)).toBe('$0.0012')
    expect(formatCost(1.5)).toBe('$1.50')
  })
})
