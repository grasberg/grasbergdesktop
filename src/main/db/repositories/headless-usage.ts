/**
 * Per-run token/cost ledger for headless generation (v44). No FKs by design —
 * a row outlives the workflow/task/conversation it describes (the
 * inbox_state/activity_log precedent). est_cost_usd NULL = unpriced model;
 * SUM() skips NULLs, so unpriced rows never count toward a cap.
 */

import { randomUUID } from 'node:crypto'
import type { HeadlessUsageSummaryEntry } from '@shared/types'
import type { SqliteDriver } from '../driver'

export interface HeadlessUsageInsert {
  runKind: string
  refId: string | null
  providerId: string
  modelId: string
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  estCostUsd: number | null
}

export interface HeadlessUsageRepository {
  insert(row: HeadlessUsageInsert): void
  /** Priced spend for one scope (runKind + refId) since `sinceMs`. */
  costForRef(runKind: string, refId: string, sinceMs: number): number
  /**
   * A conversation's headless spend: its arena (and future agent-run) rows.
   * run_kind 'other' rows ref'ing the conversation are EXCLUDED — those are
   * generateHeadless replies already persisted as messages with usage_json,
   * and counting both would double the spend.
   */
  conversationCost(conversationId: string, sinceMs: number): { costUsd: number; unpricedCount: number }
  /**
   * All headless spend since `sinceMs`, deduped against message-spend: a
   * run_kind 'other' row whose ref is a LIVE conversation is excluded (its
   * generateHeadless reply is already counted as a message); once the
   * conversation is deleted the messages cascade away and the row stands in.
   * Producers of spend NOT persisted on messages must use their own run_kind,
   * never 'other' with a conversation ref.
   */
  globalCost(sinceMs: number): { costUsd: number; unpricedCount: number }
  /** Per-run-kind totals for the Settings → Usage background-spend section. */
  summarySince(sinceMs: number): HeadlessUsageSummaryEntry[]
}

interface CostRow {
  cost_usd: number | null
  unpriced: number
}

interface SummaryRow {
  run_kind: string
  runs: number
  prompt_tokens: number | null
  completion_tokens: number | null
  est_cost_usd: number | null
  unpriced_runs: number
}

export function createHeadlessUsageRepository(driver: SqliteDriver): HeadlessUsageRepository {
  return {
    insert(row) {
      driver.run(
        `INSERT INTO headless_usage
           (id, run_kind, ref_id, provider_id, model_id, prompt_tokens,
            completion_tokens, cached_tokens, est_cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          row.runKind,
          row.refId,
          row.providerId,
          row.modelId,
          row.promptTokens,
          row.completionTokens,
          row.cachedTokens,
          row.estCostUsd,
          Date.now(),
        ]
      )
    },

    costForRef(runKind, refId, sinceMs) {
      const row = driver.get<{ cost_usd: number | null }>(
        `SELECT SUM(est_cost_usd) AS cost_usd FROM headless_usage
         WHERE run_kind = ? AND ref_id = ? AND created_at >= ?`,
        [runKind, refId, sinceMs]
      )
      return row?.cost_usd ?? 0
    },

    conversationCost(conversationId, sinceMs) {
      const row = driver.get<CostRow>(
        `SELECT SUM(est_cost_usd) AS cost_usd,
                SUM(CASE WHEN est_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
         FROM headless_usage
         WHERE ref_id = ? AND run_kind <> 'other' AND created_at >= ?`,
        [conversationId, sinceMs]
      )
      return { costUsd: row?.cost_usd ?? 0, unpricedCount: row?.unpriced ?? 0 }
    },

    globalCost(sinceMs) {
      const row = driver.get<CostRow>(
        `SELECT SUM(est_cost_usd) AS cost_usd,
                SUM(CASE WHEN est_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
         FROM headless_usage
         WHERE created_at >= ?
           AND NOT (run_kind = 'other'
                    AND ref_id IS NOT NULL
                    AND ref_id IN (SELECT id FROM conversations))`,
        [sinceMs]
      )
      return { costUsd: row?.cost_usd ?? 0, unpricedCount: row?.unpriced ?? 0 }
    },

    summarySince(sinceMs) {
      const rows = driver.all<SummaryRow>(
        `SELECT run_kind,
                COUNT(*) AS runs,
                SUM(prompt_tokens) AS prompt_tokens,
                SUM(completion_tokens) AS completion_tokens,
                SUM(est_cost_usd) AS est_cost_usd,
                SUM(CASE WHEN est_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced_runs
         FROM headless_usage
         WHERE created_at >= ?
         GROUP BY run_kind
         ORDER BY est_cost_usd DESC`,
        [sinceMs]
      )
      return rows.map((row) => ({
        runKind: row.run_kind,
        runs: row.runs,
        promptTokens: row.prompt_tokens ?? 0,
        completionTokens: row.completion_tokens ?? 0,
        estimatedCostUsd: row.est_cost_usd,
        unpricedRuns: row.unpriced_runs,
      }))
    },
  }
}
