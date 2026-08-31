/**
 * Budget guardrails (v44), enforcement layer, over the real db + ChatService:
 *
 * - both headless funnels record ONE ledger row per invocation (summed across
 *   tool rounds, NULL cost for unpriced models, no row without usage),
 * - generateHeadless's row never double-counts against its persisted message,
 * - workflow / scheduled-task / global caps skip a headless run BEFORE the
 *   first adapter call (last month's and unpriced rows never block),
 * - an interactive send against an exceeded cap asks once through the real
 *   QuestionBroker: only the exact continue answer proceeds.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ModelInfo,
  StreamEventEnvelope,
  TestConnectionResult,
  TokenUsage,
  ToolDefinition,
  UserQuestionRequest,
} from '@shared/types'
import { CHANNELS } from '@shared/ipc'
import { estimateCost, findPricing } from '@shared/pricing'
import { monthStartMs } from '@shared/budget'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import type {
  AdapterChatRequest,
  AdapterChatResult,
  AdapterContext,
  AdapterStreamEvent,
  ProviderAdapter,
} from '../../src/main/providers/adapter'
import type { ToolExecuteContext } from '../../src/main/tools/executor'
import { QuestionBroker } from '../../src/main/services/question-broker'
import {
  checkHeadlessBudget,
  conversationMonthSpend,
} from '../../src/main/services/budget'
import {
  BUDGET_CONTINUE_OPTION,
  ChatService,
  type ChatToolSystem,
} from '../../src/main/services/chat-service'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-budget-enf-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function seedProvider(type: 'deepseek' | 'openai-compatible', suffix: string): string {
  const provider = db.providers.create({
    id: randomUUID(),
    type,
    label: 'P',
    baseUrl: type === 'deepseek' ? 'https://api.deepseek.com' : 'https://x.example/v1',
    defaultModelId: type === 'deepseek' ? 'deepseek-chat' : 'm',
    enabled: true,
  })
  db.providers.setKeyRow(
    provider.id,
    'insecure:' + Buffer.from(`sk-${suffix}`, 'utf8').toString('base64'),
    `sk-…${suffix}`
  )
  return provider.id
}

const ROUND_USAGE: TokenUsage = { promptTokens: 1000, completionTokens: 500 }

/** Non-streaming adapter: fixed reply + fixed usage (undefined = none). */
class EchoAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  readonly chatRequests: AdapterChatRequest[] = []
  constructor(private readonly usage: TokenUsage | undefined) {}
  async chat(req: AdapterChatRequest): Promise<AdapterChatResult> {
    this.chatRequests.push(req)
    return { text: 'Done.', toolCalls: [], finishReason: 'stop', usage: this.usage }
  }
  // eslint-disable-next-line require-yield
  async *chatStream(): AsyncGenerator<AdapterStreamEvent> {
    throw new Error('not used')
  }
  async listModels(): Promise<ModelInfo[]> {
    return []
  }
  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'ok' }
  }
}

/** Calls one tool on the first round then finishes; usage on BOTH rounds. */
class ToolThenDoneAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  readonly chatRequests: AdapterChatRequest[] = []
  async chat(req: AdapterChatRequest): Promise<AdapterChatResult> {
    this.chatRequests.push(req)
    if (this.chatRequests.length === 1) {
      return {
        text: '',
        toolCalls: [{ id: 't1', name: 'deploy', arguments: '{}', status: 'proposed' }],
        finishReason: 'tool_calls',
        usage: ROUND_USAGE,
      }
    }
    return { text: 'Done.', toolCalls: [], finishReason: 'stop', usage: ROUND_USAGE }
  }
  // eslint-disable-next-line require-yield
  async *chatStream(): AsyncGenerator<AdapterStreamEvent> {
    throw new Error('not used')
  }
  async listModels(): Promise<ModelInfo[]> {
    return []
  }
  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'ok' }
  }
}

/** Streaming adapter for the interactive path. */
class StreamAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  readonly streamRequests: AdapterChatRequest[] = []
  async chat(): Promise<AdapterChatResult> {
    throw new Error('not used')
  }
  async *chatStream(
    req: AdapterChatRequest,
    _ctx: AdapterContext
  ): AsyncGenerator<AdapterStreamEvent> {
    this.streamRequests.push(req)
    yield { type: 'text', text: 'Streamed reply.' }
    yield { type: 'finish', reason: 'stop' }
  }
  async listModels(): Promise<ModelInfo[]> {
    return []
  }
  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'ok' }
  }
}

function ledgerRows(): Array<{
  run_kind: string
  ref_id: string | null
  prompt_tokens: number
  completion_tokens: number
  est_cost_usd: number | null
}> {
  return db.driver.all(
    'SELECT run_kind, ref_id, prompt_tokens, completion_tokens, est_cost_usd FROM headless_usage'
  )
}

function toolSystem(executeResult = 'Shipped.'): ChatToolSystem {
  const tool: ToolDefinition = {
    id: 'deploy',
    name: 'deploy',
    description: 'ships it',
    parameters: { type: 'object', properties: {} },
    risk: 'dangerous',
    builtin: false,
    enabled: true,
  }
  return {
    registry: { listEnabledDefinitions: () => [tool] },
    executor: {
      execute: vi.fn(async (_call, _ctx: ToolExecuteContext) => executeResult),
    },
    broker: { request: vi.fn(async () => ({ approved: false, scope: 'once' as const })) },
  }
}

describe('headless usage recording', () => {
  it('generateForWorkflow writes one attributed row with priced cost', async () => {
    const providerId = seedProvider('deepseek', 'a1')
    const adapter = new EchoAdapter(ROUND_USAGE)
    const service = new ChatService(db, () => undefined, { resolveAdapter: () => adapter })

    await service.generateForWorkflow('hello', providerId, 'deepseek-chat', {
      usage: { runKind: 'workflow', refId: 'wf-1' },
    })

    const rows = ledgerRows()
    expect(rows).toHaveLength(1)
    const pricing = findPricing('deepseek', 'deepseek-chat')!
    expect(rows[0]).toMatchObject({
      run_kind: 'workflow',
      ref_id: 'wf-1',
      prompt_tokens: 1000,
      completion_tokens: 500,
    })
    expect(rows[0].est_cost_usd).toBeCloseTo(estimateCost(ROUND_USAGE, pricing)!, 10)
  })

  it("generateForWorkflow without attribution records run_kind 'other', NULL ref", async () => {
    const providerId = seedProvider('deepseek', 'a2')
    const adapter = new EchoAdapter(ROUND_USAGE)
    const service = new ChatService(db, () => undefined, { resolveAdapter: () => adapter })

    await service.generateForWorkflow('hello', providerId, 'deepseek-chat')

    expect(ledgerRows()).toEqual([
      expect.objectContaining({ run_kind: 'other', ref_id: null }),
    ])
  })

  it('a two-round tool loop records a SINGLE row with summed tokens', async () => {
    const providerId = seedProvider('deepseek', 'a3')
    const adapter = new ToolThenDoneAdapter()
    const service = new ChatService(db, () => undefined, {
      resolveAdapter: () => adapter,
      tools: toolSystem(),
    })

    await service.generateForWorkflow('ship it', providerId, 'deepseek-chat', {
      useTools: true,
      approvedToolIds: ['deploy'],
      usage: { runKind: 'scheduled_task', refId: 'task-1' },
    })

    const rows = ledgerRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      run_kind: 'scheduled_task',
      ref_id: 'task-1',
      prompt_tokens: 2000,
      completion_tokens: 1000,
    })
  })

  it('an unpriced provider records est_cost_usd NULL', async () => {
    const providerId = seedProvider('openai-compatible', 'a4')
    const adapter = new EchoAdapter(ROUND_USAGE)
    const service = new ChatService(db, () => undefined, { resolveAdapter: () => adapter })

    await service.generateForWorkflow('hello', providerId, 'm')

    expect(ledgerRows()[0].est_cost_usd).toBeNull()
  })

  it('an adapter that reports no usage records no row', async () => {
    const providerId = seedProvider('deepseek', 'a5')
    const adapter = new EchoAdapter(undefined)
    const service = new ChatService(db, () => undefined, { resolveAdapter: () => adapter })

    await service.generateForWorkflow('hello', providerId, 'deepseek-chat')

    expect(ledgerRows()).toHaveLength(0)
  })

  it('generateHeadless records but never double-counts against its message', async () => {
    const providerId = seedProvider('deepseek', 'a6')
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'C',
      providerId,
      modelId: 'deepseek-chat',
    })
    const adapter = new EchoAdapter(ROUND_USAGE)
    const service = new ChatService(db, () => undefined, { resolveAdapter: () => adapter })

    await service.generateHeadless(conversation.id, 'hi there')

    expect(ledgerRows()).toEqual([
      expect.objectContaining({ run_kind: 'other', ref_id: conversation.id }),
    ])
    // Conversation-scope spend counts the persisted assistant message ONCE:
    // the 'other' ledger row is excluded by the dedupe rule.
    const pricing = findPricing('deepseek', 'deepseek-chat')!
    const spend = conversationMonthSpend(db, conversation.id, monthStartMs(Date.now()))
    expect(spend.costUsd).toBeCloseTo(estimateCost(ROUND_USAGE, pricing)!, 10)
  })
})

describe('headless budget caps', () => {
  it('a workflow past its cap is skipped before any adapter call', async () => {
    const providerId = seedProvider('deepseek', 'b1')
    const workflow = db.workflows.create({
      name: 'W',
      graph: { nodes: [], edges: [] },
      budgetUsd: 1,
    })
    db.headlessUsage.insert({
      runKind: 'workflow',
      refId: workflow.id,
      providerId: 'p',
      modelId: 'm',
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      estCostUsd: 5,
    })
    const adapter = new EchoAdapter(ROUND_USAGE)
    const service = new ChatService(db, () => undefined, { resolveAdapter: () => adapter })

    await expect(
      service.generateForWorkflow('hello', providerId, 'deepseek-chat', {
        usage: { runKind: 'workflow', refId: workflow.id },
      })
    ).rejects.toThrow(/Monthly budget reached/)
    expect(adapter.chatRequests).toHaveLength(0)

    // Spend dated LAST month does not block this month's runs.
    db.driver.run('UPDATE headless_usage SET created_at = ?', [monthStartMs(Date.now()) - 1000])
    await service.generateForWorkflow('hello', providerId, 'deepseek-chat', {
      usage: { runKind: 'workflow', refId: workflow.id },
    })
    expect(adapter.chatRequests).toHaveLength(1)
  })

  it('unpriced spend never blocks a cap', async () => {
    const providerId = seedProvider('deepseek', 'b2')
    const workflow = db.workflows.create({
      name: 'W',
      graph: { nodes: [], edges: [] },
      budgetUsd: 1,
    })
    db.headlessUsage.insert({
      runKind: 'workflow',
      refId: workflow.id,
      providerId: 'p',
      modelId: 'm',
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      estCostUsd: null,
    })
    const adapter = new EchoAdapter(ROUND_USAGE)
    const service = new ChatService(db, () => undefined, { resolveAdapter: () => adapter })

    await service.generateForWorkflow('hello', providerId, 'deepseek-chat', {
      usage: { runKind: 'workflow', refId: workflow.id },
    })
    expect(adapter.chatRequests).toHaveLength(1)
  })

  it('the global cap blocks a refId-less run', async () => {
    const providerId = seedProvider('deepseek', 'b3')
    db.settings.update({ monthlyBudgetUsd: 0.01 })
    db.headlessUsage.insert({
      runKind: 'workflow',
      refId: 'any',
      providerId: 'p',
      modelId: 'm',
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      estCostUsd: 5,
    })
    const adapter = new EchoAdapter(ROUND_USAGE)
    const service = new ChatService(db, () => undefined, { resolveAdapter: () => adapter })

    await expect(
      service.generateForWorkflow('hello', providerId, 'deepseek-chat')
    ).rejects.toThrow(/Monthly budget reached/)
    expect(adapter.chatRequests).toHaveLength(0)
  })

  it("the global cap sees 'other'/NULL-ref spend even when a conversation exists", async () => {
    // The production shape of internal-plumbing spend (commit messages,
    // dreaming, compaction): run_kind 'other', ref_id NULL. Regression for the
    // NULL-IN dedupe bug that hid it from the cap while conversations existed.
    const providerId = seedProvider('deepseek', 'b3n')
    db.settings.update({ monthlyBudgetUsd: 0.01 })
    db.conversations.create({ mode: 'chat', title: 'Live' })
    db.headlessUsage.insert({
      runKind: 'other',
      refId: null,
      providerId: 'p',
      modelId: 'm',
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      estCostUsd: 5,
    })
    const adapter = new EchoAdapter(ROUND_USAGE)
    const service = new ChatService(db, () => undefined, { resolveAdapter: () => adapter })

    await expect(
      service.generateForWorkflow('hello', providerId, 'deepseek-chat')
    ).rejects.toThrow(/Monthly budget reached/)
    expect(adapter.chatRequests).toHaveLength(0)
  })

  it('checkHeadlessBudget honors scheduled_tasks.budget_usd', () => {
    const providerId = seedProvider('deepseek', 'b4')
    const provider = db.providers.getById(providerId)!
    const task = db.scheduledTasks.create({
      title: 'T',
      prompt: 'p',
      recurrence: 'daily',
      runAt: Date.now() + 60_000,
    })
    db.scheduledTasks.setBudget(task.id, 1)
    db.headlessUsage.insert({
      runKind: 'scheduled_task',
      refId: task.id,
      providerId: 'p',
      modelId: 'm',
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      estCostUsd: 2,
    })

    const hit = checkHeadlessBudget(
      db,
      { runKind: 'scheduled_task', refId: task.id },
      provider,
      'deepseek-chat'
    )
    expect(hit).toMatchObject({ capUsd: 1, spentUsd: 2 })

    // Last month's spend clears it.
    db.driver.run('UPDATE headless_usage SET created_at = ?', [monthStartMs(Date.now()) - 1000])
    expect(
      checkHeadlessBudget(
        db,
        { runKind: 'scheduled_task', refId: task.id },
        provider,
        'deepseek-chat'
      )
    ).toBeNull()
  })
})

describe('interactive budget gate', () => {
  interface Harness {
    service: ChatService
    adapter: StreamAdapter
    questionCount: () => number
    done: Promise<StreamEventEnvelope>
  }

  /** ChatService with the REAL QuestionBroker; `answer` is clicked for it. */
  function makeHarness(answer: string | null): Harness {
    const adapter = new StreamAdapter()
    const questions = new QuestionBroker()
    let asked = 0
    let resolveDone: (env: StreamEventEnvelope) => void = () => undefined
    const done = new Promise<StreamEventEnvelope>((resolve) => {
      resolveDone = resolve
    })
    const service = new ChatService(
      db,
      (channel, payload) => {
        if (channel === CHANNELS.userQuestionRequest) {
          asked += 1
          const request = payload as UserQuestionRequest
          if (answer !== null) questions.respond(request.requestId, answer)
          return
        }
        if (channel !== CHANNELS.streamEvent) return
        const envelope = payload as StreamEventEnvelope
        if (envelope.event.type === 'done' || envelope.event.type === 'error') {
          resolveDone(envelope)
        }
      },
      {
        resolveAdapter: () => adapter,
        tools: {
          registry: { listEnabledDefinitions: () => [] },
          executor: { execute: async () => '' },
          broker: { request: async () => ({ approved: false, scope: 'once' as const }) },
          questions,
        },
      }
    )
    return { service, adapter, questionCount: () => asked, done }
  }

  /** A conversation whose month-to-date spend already exceeds `budgetUsd`. */
  function exceededConversation(providerId: string, budgetUsd: number | null): string {
    const conversation = db.conversations.create({
      mode: 'chat',
      title: 'C',
      providerId,
      modelId: 'deepseek-chat',
    })
    if (budgetUsd !== null) db.conversations.update(conversation.id, { budgetUsd })
    db.messages.insert({
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'assistant',
      content: 'earlier reply',
      status: 'complete',
      providerId,
      modelId: 'deepseek-chat',
      // 10M in + 1M out on deepseek-chat ≈ $3.80 this month.
      usage: { promptTokens: 10_000_000, completionTokens: 1_000_000 },
      seq: db.messages.nextSeq(conversation.id),
      createdAt: Date.now(),
    })
    return conversation.id
  }

  it("'Stop' finalizes the assistant message as a budget error, no adapter call", async () => {
    const providerId = seedProvider('deepseek', 'c1')
    const conversationId = exceededConversation(providerId, 1)
    const { service, adapter, questionCount, done } = makeHarness('Stop')

    await service.send({ conversationId, content: 'one more' })
    const envelope = await done

    expect(questionCount()).toBe(1)
    expect(envelope.event.type).toBe('error')
    if (envelope.event.type === 'error') {
      expect(envelope.event.message.status).toBe('error')
      expect(envelope.event.error.message).toContain('Monthly budget reached')
    }
    expect(adapter.streamRequests).toHaveLength(0)
  })

  it('the exact continue answer lets the generation complete', async () => {
    const providerId = seedProvider('deepseek', 'c2')
    const conversationId = exceededConversation(providerId, 1)
    const { service, adapter, questionCount, done } = makeHarness(BUDGET_CONTINUE_OPTION)

    await service.send({ conversationId, content: 'one more' })
    const envelope = await done

    expect(questionCount()).toBe(1)
    expect(envelope.event.type).toBe('done')
    if (envelope.event.type === 'done') {
      expect(envelope.event.message.content).toBe('Streamed reply.')
      expect(envelope.event.message.status).toBe('complete')
    }
    expect(adapter.streamRequests).toHaveLength(1)
  })

  it('a conversation with no cap (and no global cap) never asks', async () => {
    const providerId = seedProvider('deepseek', 'c3')
    const conversationId = exceededConversation(providerId, null)
    const { service, adapter, questionCount, done } = makeHarness(null)

    await service.send({ conversationId, content: 'one more' })
    const envelope = await done

    expect(questionCount()).toBe(0)
    expect(envelope.event.type).toBe('done')
    expect(adapter.streamRequests).toHaveLength(1)
  })
})
