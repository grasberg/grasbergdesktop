/**
 * Local usage summary: aggregates per-message TokenUsage into per
 * provider+model rows with an estimated cost from the static price list.
 * Pure — main feeds it rows joined with provider label/type; the renderer
 * only displays. Estimates only (the price list is a local snapshot).
 */

import { estimateCost, findPricing } from './pricing'
import type { ProviderType, TokenUsage, UsageSummaryEntry } from './types'

export interface UsageSourceRow {
  providerId: string
  providerLabel: string
  providerType: ProviderType
  modelId: string
  usage: TokenUsage
}

export function buildUsageSummary(rows: UsageSourceRow[]): UsageSummaryEntry[] {
  const byKey = new Map<string, UsageSummaryEntry>()
  for (const row of rows) {
    const key = `${row.providerId} ${row.modelId}`
    let entry = byKey.get(key)
    if (!entry) {
      entry = {
        providerId: row.providerId,
        providerLabel: row.providerLabel,
        providerType: row.providerType,
        modelId: row.modelId,
        messages: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: null,
      }
      byKey.set(key, entry)
    }
    entry.messages += 1
    const prompt = row.usage.promptTokens ?? 0
    const completion = row.usage.completionTokens ?? 0
    entry.promptTokens += prompt
    entry.completionTokens += completion
    entry.totalTokens += row.usage.totalTokens ?? prompt + completion
    const pricing = findPricing(row.providerType, row.modelId)
    if (pricing) {
      const cost = estimateCost(row.usage, pricing)
      if (cost !== undefined) entry.estimatedCostUsd = (entry.estimatedCostUsd ?? 0) + cost
    }
  }
  return [...byKey.values()].sort((a, b) => b.totalTokens - a.totalTokens)
}
