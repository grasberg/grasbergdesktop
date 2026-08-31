/**
 * Budget guardrails (v44), data layer:
 *
 * - the shared month/pricing helpers,
 * - the headless_usage ledger (grouping, scope filters, and the load-bearing
 *   dedupe rule: an 'other' row ref'ing a LIVE conversation is excluded from
 *   combined totals because its reply is already counted as a message),
 * - budget_usd plumbing on conversations / workflows / scheduled tasks.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { monthStartMs, nextCallEstimateUsd, resolvePricing } from '@shared/budget'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-budget-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function insertUsage(overrides: Partial<Parameters<AppDatabase['headlessUsage']['insert']>[0]>): void {
  db.headlessUsage.insert({
    runKind: 'workflow',
    refId: null,
    providerId: 'p1',
    modelId: 'm1',
    promptTokens: 100,
    completionTokens: 50,
    cachedTokens: 0,
    estCostUsd: 1,
    ...overrides,
  })
}

describe('shared budget helpers', () => {
  it('monthStartMs returns the local first-of-month midnight, stable mid-month', () => {
    const mid = new Date(2026, 7, 28, 13, 45, 12).getTime()
    const later = new Date(2026, 7, 31, 23, 59, 59).getTime()
    const expected = new Date(2026, 7, 1, 0, 0, 0, 0).getTime()
    expect(monthStartMs(mid)).toBe(expected)
    expect(monthStartMs(later)).toBe(expected)
    expect(monthStartMs(expected)).toBe(expected)
  })

  it('resolvePricing prices direct families and treats unknowns as unpriced', () => {
    expect(resolvePricing('deepseek', null, 'deepseek-chat')).toMatchObject({
      inputPerMTok: 0.27,
    })
    expect(resolvePricing('openai-compatible', null, 'whatever')).toBeUndefined()
  })

  it('nextCallEstimateUsd is conservative for priced and zero for unpriced', () => {
    const pricing = resolvePricing('deepseek', null, 'deepseek-chat')
    expect(nextCallEstimateUsd(pricing)).toBeCloseTo(((0.27 + 1.1) * 2000) / 1_000_000, 10)
    expect(nextCallEstimateUsd(undefined)).toBe(0)
  })
})

describe('headless_usage repository', () => {
  it('groups summarySince by run kind and counts unpriced rows separately', () => {
    insertUsage({ runKind: 'workflow', estCostUsd: 0.5, promptTokens: 100, completionTokens: 10 })
    insertUsage({ runKind: 'workflow', estCostUsd: null, promptTokens: 200, completionTokens: 20 })
    insertUsage({ runKind: 'arena', estCostUsd: 2, promptTokens: 300, completionTokens: 30 })
    insertUsage({ runKind: 'scheduled_task', estCostUsd: null })

    const summary = db.headlessUsage.summarySince(0)
    const byKind = new Map(summary.map((e) => [e.runKind, e]))
    expect(byKind.get('workflow')).toMatchObject({
      runs: 2,
      promptTokens: 300,
      completionTokens: 30,
      estimatedCostUsd: 0.5,
      unpricedRuns: 1,
    })
    expect(byKind.get('arena')).toMatchObject({ runs: 1, estimatedCostUsd: 2, unpricedRuns: 0 })
    // A group where EVERY row is unpriced reports null, not 0.
    expect(byKind.get('scheduled_task')).toMatchObject({ estimatedCostUsd: null, unpricedRuns: 1 })
  })

  it('costForRef filters by kind + ref + window and ignores unpriced rows', () => {
    insertUsage({ runKind: 'workflow', refId: 'wf1', estCostUsd: 1 })
    insertUsage({ runKind: 'workflow', refId: 'wf1', estCostUsd: null })
    insertUsage({ runKind: 'workflow', refId: 'wf2', estCostUsd: 5 })
    insertUsage({ runKind: 'scheduled_task', refId: 'wf1', estCostUsd: 7 })

    expect(db.headlessUsage.costForRef('workflow', 'wf1', 0)).toBe(1)
    // Rows dated before the window do not count.
    db.driver.run('UPDATE headless_usage SET created_at = 1000')
    expect(db.headlessUsage.costForRef('workflow', 'wf1', 2000)).toBe(0)
  })

  it("globalCost excludes 'other' rows ref'ing a LIVE conversation only", () => {
    const conversation = db.conversations.create({ mode: 'chat', title: 'C' })
    insertUsage({ runKind: 'other', refId: conversation.id, estCostUsd: 3 })
    insertUsage({ runKind: 'workflow', refId: 'wf1', estCostUsd: 1 })
    insertUsage({ runKind: 'arena', refId: conversation.id, estCostUsd: 2 })

    // The 'other' row's reply is counted as a message — excluded here.
    expect(db.headlessUsage.globalCost(0).costUsd).toBe(3)

    // Once the conversation (and its messages) are gone, the row stands in.
    db.conversations.remove(conversation.id)
    expect(db.headlessUsage.globalCost(0).costUsd).toBe(6)
  })

  it("counts 'other' rows with a NULL ref even when conversations exist (SQL NULL-IN regression)", () => {
    // Commit messages / dreaming / compaction / unsaved builder runs all write
    // run_kind 'other' with ref_id NULL. `NULL IN (subquery)` is NULL, so the
    // dedupe predicate silently dropped them once any conversation existed.
    db.conversations.create({ mode: 'chat', title: 'Live' })
    insertUsage({ runKind: 'other', refId: null, estCostUsd: 4 })
    insertUsage({ runKind: 'workflow', refId: 'wf1', estCostUsd: 1 })

    expect(db.headlessUsage.globalCost(0).costUsd).toBe(5)
  })

  it("conversationCost counts the conversation's arena rows but not its 'other' rows", () => {
    const conversation = db.conversations.create({ mode: 'chat', title: 'C' })
    insertUsage({ runKind: 'arena', refId: conversation.id, estCostUsd: 2 })
    insertUsage({ runKind: 'arena', refId: conversation.id, estCostUsd: null })
    insertUsage({ runKind: 'other', refId: conversation.id, estCostUsd: 9 })
    insertUsage({ runKind: 'arena', refId: 'someone-else', estCostUsd: 5 })

    const cost = db.headlessUsage.conversationCost(conversation.id, 0)
    expect(cost.costUsd).toBe(2)
    expect(cost.unpricedCount).toBe(1)
  })
})

describe('budget_usd plumbing', () => {
  it('round-trips on conversations and null clears', () => {
    const conversation = db.conversations.create({ mode: 'chat', title: 'C' })
    expect(conversation.budgetUsd).toBeNull()

    expect(db.conversations.update(conversation.id, { budgetUsd: 5 })?.budgetUsd).toBe(5)
    // An unrelated patch keeps the stored cap.
    expect(db.conversations.update(conversation.id, { title: 'D' })?.budgetUsd).toBe(5)
    expect(db.conversations.update(conversation.id, { budgetUsd: null })?.budgetUsd).toBeNull()
  })

  it('workflows: create stores it, omitting keeps it, explicit null clears', () => {
    const workflow = db.workflows.create({
      name: 'W',
      graph: { nodes: [], edges: [] },
      budgetUsd: 3,
    })
    expect(db.workflows.getById(workflow.id)?.budgetUsd).toBe(3)

    // Undefined-keeps-value discipline (the webhookEnabled contract).
    db.workflows.update(workflow.id, { name: 'W2' })
    expect(db.workflows.getById(workflow.id)?.budgetUsd).toBe(3)

    db.workflows.update(workflow.id, { budgetUsd: null })
    expect(db.workflows.getById(workflow.id)?.budgetUsd).toBeNull()
  })

  it('scheduledTasks.setBudget sets/clears and bumps updated_at', async () => {
    const task = db.scheduledTasks.create({
      title: 'T',
      prompt: 'do it',
      recurrence: 'once',
      runAt: Date.now() + 60_000,
    })
    expect(task.budgetUsd).toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 5))
    const capped = db.scheduledTasks.setBudget(task.id, 2.5)
    expect(capped?.budgetUsd).toBe(2.5)
    expect(capped!.updatedAt).toBeGreaterThan(task.updatedAt)

    expect(db.scheduledTasks.setBudget(task.id, null)?.budgetUsd).toBeNull()
  })
})
