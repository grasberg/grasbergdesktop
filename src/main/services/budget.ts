/**
 * Budget guardrails (v44): month-to-date spend aggregation and cap checks over
 * the message table + the headless_usage ledger. Plain functions over
 * AppDatabase so everything is unit-testable without a ChatService. Caps count
 * only PRICED spend — unpriced rows are tallied separately for the UI.
 */

import type {
  Conversation,
  ConversationCostSummary,
  ProviderConfig,
  TokenUsage,
} from '@shared/types'
import {
  monthStartMs,
  nextCallEstimateUsd,
  resolvePricing,
  type HeadlessRunKind,
} from '@shared/budget'
import { estimateCost } from '@shared/pricing'
import type { AppDatabase } from '../db/database'

export interface HeadlessUsageRef {
  runKind: HeadlessRunKind
  refId: string | null
  /** The agent profile the run ran as (v49), for per-bot spend. */
  agentId?: string | null
}

/**
 * Records one headless generation in the ledger. Never throws — a bookkeeping
 * failure must not fail the run it describes.
 */
export function recordHeadlessUsage(
  db: AppDatabase,
  ref: HeadlessUsageRef,
  provider: ProviderConfig,
  modelId: string,
  usage: TokenUsage
): void {
  try {
    const pricing = resolvePricing(provider.type, provider.presetId, modelId)
    const cost = pricing ? estimateCost(usage, pricing) : undefined
    db.headlessUsage.insert({
      runKind: ref.runKind,
      refId: ref.refId,
      agentId: ref.agentId ?? null,
      providerId: provider.id,
      modelId,
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
      cachedTokens: usage.cachedInputTokens ?? 0,
      estCostUsd: cost ?? null,
    })
  } catch {
    // Ledger writes are best-effort.
  }
}

/** Prices a batch of per-message usage rows against the provider table. */
function priceMessageRows(
  db: AppDatabase,
  rows: Array<{ providerId: string; modelId: string; usage: TokenUsage }>
): { costUsd: number; unpricedCount: number } {
  const providers = new Map(db.providers.list().map((p) => [p.id, p]))
  let costUsd = 0
  let unpricedCount = 0
  for (const row of rows) {
    const provider = providers.get(row.providerId)
    const pricing = provider
      ? resolvePricing(provider.type, provider.presetId, row.modelId)
      : undefined
    const cost = pricing ? estimateCost(row.usage, pricing) : undefined
    if (cost === undefined) unpricedCount += 1
    else costUsd += cost
  }
  return { costUsd, unpricedCount }
}

/** One conversation's month-to-date spend: its messages + its headless rows. */
export function conversationMonthSpend(
  db: AppDatabase,
  conversationId: string,
  sinceMs: number
): { costUsd: number; unpricedCount: number } {
  const messages = priceMessageRows(
    db,
    db.messages.usageForConversationSince(conversationId, sinceMs)
  )
  const headless = db.headlessUsage.conversationCost(conversationId, sinceMs)
  return {
    costUsd: messages.costUsd + headless.costUsd,
    unpricedCount: messages.unpricedCount + headless.unpricedCount,
  }
}

/** App-wide month-to-date spend: every message + deduped headless rows. */
export function globalMonthSpend(
  db: AppDatabase,
  sinceMs: number
): { costUsd: number; unpricedCount: number } {
  const messages = priceMessageRows(db, db.messages.usageSince(sinceMs))
  const headless = db.headlessUsage.globalCost(sinceMs)
  return {
    costUsd: messages.costUsd + headless.costUsd,
    unpricedCount: messages.unpricedCount + headless.unpricedCount,
  }
}

export interface BudgetHit {
  /** Human label of the scope whose cap was hit ("workflow", "the app", …). */
  scopeLabel: string
  capUsd: number
  spentUsd: number
}

function exceeded(spent: number, cap: number, estimate: number): boolean {
  return spent >= cap || spent + estimate > cap
}

/**
 * Preflight for a headless generation: the scope's own cap (workflow /
 * scheduled task / arena's owning conversation) first, then the global cap.
 * Returns the first exceeded cap, or null when nothing blocks. Skips every
 * aggregate query when no cap is configured.
 */
export function checkHeadlessBudget(
  db: AppDatabase,
  ref: HeadlessUsageRef,
  provider: ProviderConfig,
  modelId: string
): BudgetHit | null {
  const since = monthStartMs(Date.now())
  const estimate = nextCallEstimateUsd(resolvePricing(provider.type, provider.presetId, modelId))

  if (ref.refId) {
    if (ref.runKind === 'workflow') {
      const cap = db.workflows.getById(ref.refId)?.budgetUsd ?? null
      if (cap !== null) {
        const spent = db.headlessUsage.costForRef('workflow', ref.refId, since)
        if (exceeded(spent, cap, estimate)) {
          return { scopeLabel: 'this workflow', capUsd: cap, spentUsd: spent }
        }
      }
    } else if (ref.runKind === 'scheduled_task') {
      const cap = db.scheduledTasks.getById(ref.refId)?.budgetUsd ?? null
      if (cap !== null) {
        const spent = db.headlessUsage.costForRef('scheduled_task', ref.refId, since)
        if (exceeded(spent, cap, estimate)) {
          return { scopeLabel: 'this scheduled task', capUsd: cap, spentUsd: spent }
        }
      }
    } else if (ref.runKind === 'arena' || ref.runKind === 'other') {
      // Arena candidates (and generateHeadless replies) spend against the
      // owning conversation's cap.
      const cap = db.conversations.getById(ref.refId)?.budgetUsd ?? null
      if (cap !== null) {
        const spent = conversationMonthSpend(db, ref.refId, since).costUsd
        if (exceeded(spent, cap, estimate)) {
          return { scopeLabel: 'this conversation', capUsd: cap, spentUsd: spent }
        }
      }
    }
  }

  const globalCap = db.settings.get().monthlyBudgetUsd
  if (globalCap !== null) {
    const spent = globalMonthSpend(db, since).costUsd
    if (exceeded(spent, globalCap, estimate)) {
      return { scopeLabel: 'the app', capUsd: globalCap, spentUsd: spent }
    }
  }
  return null
}

/**
 * Preflight for an interactive send: the conversation's cap first, then the
 * global one. Returns the first exceeded cap, or null. Skips every aggregate
 * query when no cap is configured, so cap-less users pay nothing.
 */
export function checkInteractiveBudget(
  db: AppDatabase,
  conversation: Conversation,
  monthlyBudgetUsd: number | null,
  provider: ProviderConfig,
  modelId: string
): BudgetHit | null {
  const convCap = conversation.budgetUsd ?? null
  if (convCap === null && monthlyBudgetUsd === null) return null
  const since = monthStartMs(Date.now())
  const estimate = nextCallEstimateUsd(resolvePricing(provider.type, provider.presetId, modelId))
  if (convCap !== null) {
    const spent = conversationMonthSpend(db, conversation.id, since).costUsd
    if (exceeded(spent, convCap, estimate)) {
      return { scopeLabel: 'this conversation', capUsd: convCap, spentUsd: spent }
    }
  }
  if (monthlyBudgetUsd !== null) {
    const spent = globalMonthSpend(db, since).costUsd
    if (exceeded(spent, monthlyBudgetUsd, estimate)) {
      return { scopeLabel: 'the app', capUsd: monthlyBudgetUsd, spentUsd: spent }
    }
  }
  return null
}

/** Shared body of every cap-hit message (question dialog, refusal, run skip). */
export function budgetHitText(hit: BudgetHit): string {
  return `≈$${hit.spentUsd.toFixed(2)} of the $${hit.capUsd} cap for ${hit.scopeLabel} spent this month (estimate — unpriced models excluded)`
}

/** Month-to-date cost of one conversation, for the header HUD / IPC. */
export function conversationCostSummary(
  db: AppDatabase,
  conversation: Conversation
): ConversationCostSummary {
  const since = monthStartMs(Date.now())
  const spend = conversationMonthSpend(db, conversation.id, since)
  return {
    estimatedCostUsd: spend.costUsd,
    unpricedCount: spend.unpricedCount,
    budgetUsd: conversation.budgetUsd ?? null,
    globalBudgetUsd: db.settings.get().monthlyBudgetUsd,
    monthStartMs: since,
  }
}
