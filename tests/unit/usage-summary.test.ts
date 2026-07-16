/**
 * buildUsageSummary: grouping per provider+model, token sums, cost estimation
 * against the static price list (null for unknown models), and sorting.
 */

import { describe, expect, it } from 'vitest'
import { buildUsageSummary, type UsageSourceRow } from '@shared/usage-summary'
import { MODEL_PRICING } from '@shared/pricing'

function row(overrides: Partial<UsageSourceRow>): UsageSourceRow {
  return {
    providerId: 'p1',
    providerLabel: 'DeepSeek',
    providerType: 'deepseek',
    modelId: 'deepseek-chat',
    usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
    ...overrides,
  }
}

describe('buildUsageSummary', () => {
  it('groups by provider+model and sums tokens and messages', () => {
    const entries = buildUsageSummary([
      row({}),
      row({ usage: { promptTokens: 2000, completionTokens: 1000, totalTokens: 3000 } }),
      row({ providerId: 'p2', providerLabel: 'Other', modelId: 'other-model' }),
    ])
    expect(entries).toHaveLength(2)
    const deepseek = entries.find((e) => e.providerId === 'p1')!
    expect(deepseek.messages).toBe(2)
    expect(deepseek.promptTokens).toBe(3000)
    expect(deepseek.completionTokens).toBe(1500)
    expect(deepseek.totalTokens).toBe(4500)
  })

  it('derives totalTokens when the provider did not report it', () => {
    const [entry] = buildUsageSummary([
      row({ usage: { promptTokens: 10, completionTokens: 5 } }),
    ])
    expect(entry.totalTokens).toBe(15)
  })

  it('estimates cost for known models and returns null for unknown ones', () => {
    // Sanity: the model used here must exist in the static price list.
    expect(MODEL_PRICING.deepseek['deepseek-chat']).toBeTruthy()
    const [known] = buildUsageSummary([row({})])
    expect(known.estimatedCostUsd).not.toBeNull()
    expect(known.estimatedCostUsd!).toBeGreaterThan(0)

    const [unknown] = buildUsageSummary([
      row({ providerType: 'openai-compatible', modelId: 'my-local-model' }),
    ])
    expect(unknown.estimatedCostUsd).toBeNull()
  })

  it('sorts by total tokens, largest first', () => {
    const entries = buildUsageSummary([
      row({ modelId: 'small', usage: { promptTokens: 1, completionTokens: 1 } }),
      row({ modelId: 'big', usage: { promptTokens: 9000, completionTokens: 100 } }),
    ])
    expect(entries.map((e) => e.modelId)).toEqual(['big', 'small'])
  })
})
