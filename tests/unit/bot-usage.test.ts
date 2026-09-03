/**
 * Per-bot estimated spend (v49): the bot's canonical-chat messages plus the
 * headless_usage rows stamped with its agent_id, over today / 7 d / 30 d.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { botUsageSummary } from '../../src/main/services/budget'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-bot-usage-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const DAY = 24 * 60 * 60_000

function ledgerRow(input: {
  agentId: string | null
  runKind: string
  refId: string | null
  costUsd: number | null
  createdAt: number
}): void {
  db.driver.run(
    `INSERT INTO headless_usage
       (id, run_kind, ref_id, agent_id, provider_id, model_id, prompt_tokens,
        completion_tokens, cached_tokens, est_cost_usd, created_at)
     VALUES (?, ?, ?, ?, 'p', 'm', 1, 1, 0, ?, ?)`,
    [randomUUID(), input.runKind, input.refId, input.agentId, input.costUsd, input.createdAt]
  )
}

describe('botUsageSummary', () => {
  it('sums the bot chat and its stamped headless runs per window, deduped and excluding other bots', () => {
    const bot = db.agents.create({ name: 'Editor', systemPrompt: 'p' })
    const other = db.agents.create({ name: 'Scout', systemPrompt: 'p' })
    const chat = db.conversations.create({ mode: 'chat', title: 'Editor', agentId: bot.id })
    db.agents.setChatConversation(bot.id, chat.id)
    const now = new Date(2026, 8, 3, 12, 0, 0).getTime() // noon local, so "today" starts 12 h ago

    ledgerRow({ agentId: bot.id, runKind: 'scheduled_task', refId: 't1', costUsd: 0.5, createdAt: now - 60_000 })
    ledgerRow({ agentId: bot.id, runKind: 'other', refId: 'group-1', costUsd: 0.25, createdAt: now - 3 * DAY })
    // A generateHeadless reply into a LIVE conversation is already counted as a message.
    ledgerRow({ agentId: bot.id, runKind: 'other', refId: chat.id, costUsd: 9, createdAt: now - 60_000 })
    ledgerRow({ agentId: other.id, runKind: 'scheduled_task', refId: 't2', costUsd: 100, createdAt: now - 60_000 })
    ledgerRow({ agentId: bot.id, runKind: 'agent_run', refId: null, costUsd: null, createdAt: now - 10 * DAY })
    ledgerRow({ agentId: bot.id, runKind: 'agent_run', refId: null, costUsd: 1, createdAt: now - 40 * DAY })
    // An interactive turn in the bot's chat on an unknown provider: counted, unpriced.
    db.messages.insert({
      id: randomUUID(),
      conversationId: chat.id,
      role: 'assistant',
      content: 'hi',
      status: 'complete',
      providerId: 'ghost-provider',
      modelId: 'm',
      usage: { promptTokens: 5, completionTokens: 5 },
      seq: 1,
      createdAt: now - 2 * DAY,
    })

    const summary = botUsageSummary(db, db.agents.getById(bot.id)!, now)
    expect(summary.agentId).toBe(bot.id)
    expect(summary.today).toMatchObject({ costUsd: 0.5, unpricedCount: 0 })
    expect(summary.week).toMatchObject({ costUsd: 0.75, unpricedCount: 1 })
    expect(summary.month).toMatchObject({ costUsd: 0.75, unpricedCount: 2 })
    expect(summary.today.sinceMs).toBe(new Date(2026, 8, 3, 0, 0, 0).getTime())
  })

  it('a bot without a chat yet reports only its headless spend', () => {
    const bot = db.agents.create({ name: 'Editor', systemPrompt: 'p' })
    ledgerRow({ agentId: bot.id, runKind: 'agent_run', refId: null, costUsd: 2, createdAt: Date.now() })
    const summary = botUsageSummary(db, db.agents.getById(bot.id)!)
    expect(summary.today.costUsd).toBe(2)
    expect(summary.month.unpricedCount).toBe(0)
  })
})
