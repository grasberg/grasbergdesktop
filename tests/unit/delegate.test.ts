import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Conversation,
  DelegateFinishedInfo,
  DelegateHandoffInfo,
  ModelInfo,
  TestConnectionResult,
  ToolCallRecord,
  ToolDefinition,
} from '@shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import type {
  AdapterChatRequest,
  AdapterChatResult,
  AdapterStreamEvent,
  ProviderAdapter,
} from '../../src/main/providers/adapter'
import type { ToolExecuteContext } from '../../src/main/tools/executor'
import { ChatService, type ChatToolSystem } from '../../src/main/services/chat-service'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-delegate-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Adapter whose non-streaming chat() replays scripted results. */
class DelegateAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  readonly chatRequests: AdapterChatRequest[] = []
  private i = 0
  constructor(private readonly results: AdapterChatResult[]) {}
  async *chatStream(): AsyncGenerator<AdapterStreamEvent> {
    // not used
  }
  async chat(req: AdapterChatRequest): Promise<AdapterChatResult> {
    this.chatRequests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
    return this.results[Math.min(this.i++, this.results.length - 1)]
  }
  async listModels(): Promise<ModelInfo[]> {
    return []
  }
  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'ok' }
  }
}

function seed(): Conversation {
  const provider = db.providers.create({
    id: randomUUID(),
    type: 'openai-compatible',
    label: 'Fake',
    baseUrl: 'https://fake.example/v1',
    defaultModelId: 'fake-model',
    enabled: true,
  })
  db.providers.setKeyRow(
    provider.id,
    'insecure:' + Buffer.from('sk-delegate', 'utf8').toString('base64'),
    'sk-…d'
  )
  return db.conversations.create({
    mode: 'chat',
    title: 'Parent',
    providerId: provider.id,
    modelId: 'fake-model',
  })
}

const fileSearch: ToolDefinition = {
  id: 'file_search',
  name: 'file_search',
  description: 'Search project files.',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  risk: 'sensitive',
  builtin: true,
  enabled: true,
}

function ctx(conversation: Conversation): ToolExecuteContext {
  return {
    conversation,
    streamId: 's1',
    approval: vi.fn(async () => ({ approved: true, scope: 'once' as const })),
  }
}

describe('ChatService.runDelegate', () => {
  it('runs a one-shot sub-agent and returns its text', async () => {
    const conversation = seed()
    const adapter = new DelegateAdapter([
      { text: 'The answer is 42.', toolCalls: [], finishReason: 'stop' },
    ])
    const service = new ChatService(db, () => undefined, { resolveAdapter: () => adapter })

    const result = await service.runDelegate('What is the answer?', ctx(conversation))
    expect(result).toContain('The answer is 42.')
    // A system persona + the task were sent.
    expect(adapter.chatRequests[0].messages[0].role).toBe('system')
    expect(adapter.chatRequests[0].messages[1]).toMatchObject({ role: 'user' })
  })

  it('lets the sub-agent use a read-only tool then answer', async () => {
    const conversation = seed()
    const toolCall: ToolCallRecord = {
      id: 'c1',
      name: 'file_search',
      arguments: '{"query":"x"}',
      status: 'proposed',
    }
    const adapter = new DelegateAdapter([
      { text: '', toolCalls: [toolCall], finishReason: 'tool_calls' },
      { text: 'Found it in a.ts.', toolCalls: [], finishReason: 'stop' },
    ])
    const execute = vi.fn(async () => 'a.ts:1: match')
    const tools: ChatToolSystem = {
      registry: { listEnabledDefinitions: () => [fileSearch] },
      executor: { execute },
      broker: { request: async () => ({ approved: true, scope: 'once' as const }) },
    }
    const service = new ChatService(db, () => undefined, {
      resolveAdapter: () => adapter,
      tools,
    })

    const result = await service.runDelegate('Find x', ctx(conversation))
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result).toContain('Found it in a.ts.')
    // The tool result round-tripped as a role-'tool' message on the 2nd call.
    const second = adapter.chatRequests[1].messages
    expect(second.some((m) => m.role === 'tool' && m.content === 'a.ts:1: match')).toBe(true)
  })

  it('returns a readable error when no provider/key is configured', async () => {
    const conversation = db.conversations.create({ mode: 'chat', title: 'No provider' })
    const service = new ChatService(db, () => undefined, {})
    const result = await service.runDelegate('task', ctx(conversation))
    expect(result).toMatch(/delegation failed/i)
  })
})

/** chat() that never resolves until the caller's signal aborts. */
class HangingAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  async *chatStream(): AsyncGenerator<AdapterStreamEvent> {
    // not used
  }
  chat(_req: AdapterChatRequest, ctx: { signal?: AbortSignal }): Promise<AdapterChatResult> {
    return new Promise((_resolve, reject) => {
      ctx.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }
  async listModels(): Promise<ModelInfo[]> {
    return []
  }
  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'ok' }
  }
}

describe('ChatService background delegate runs', () => {
  it('stopAll finishes the persistent agent_runs row (no phantom running agent)', async () => {
    const conversation = seed()
    const service = new ChatService(db, () => undefined, {
      resolveAdapter: () => new HangingAdapter(),
    })

    const note = service.startDelegateBackground('long task', ctx(conversation))
    expect(note).toContain('Started background task')
    const started = db.agentPlatform.runsList(conversation.id)
    expect(started).toHaveLength(1)
    expect(started[0].status).toBe('running')

    await service.stopAll()

    const stopped = db.agentPlatform.runsList(conversation.id)[0]
    expect(stopped.status).toBe('stopped')
    expect(stopped.finishedAt).not.toBeNull()
  })
})

describe('delegate → bot handoffs (v49)', () => {
  it('fires started/finished for a named agent, runs with its memories, and records spend under it', async () => {
    const conversation = seed()
    const bot = db.agents.create({ name: 'Editor', systemPrompt: 'You edit.' })
    db.memories.create({ title: 'style', content: 'Oxford comma', agentId: bot.id })
    db.memories.create({ title: 'user-language', content: 'Swedish' })
    const adapter = new DelegateAdapter([
      {
        text: 'Edited.',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 5 },
      },
    ])
    const started: DelegateHandoffInfo[] = []
    const finished: DelegateFinishedInfo[] = []
    const service = new ChatService(db, () => undefined, {
      resolveAdapter: () => adapter,
      onDelegateStarted: (info) => started.push(info),
      onDelegateFinished: (info) => finished.push(info),
    })

    const result = await service.runDelegate('polish this', ctx(conversation), undefined, 'Editor')
    expect(result).toContain('Edited.')
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({
      agentId: bot.id,
      agentName: 'Editor',
      callerConversationId: conversation.id,
      callerAgentId: null,
      task: 'polish this',
      background: false,
      runId: null,
    })
    expect(finished).toHaveLength(1)
    expect(finished[0]).toMatchObject({ delegateKey: started[0].delegateKey, status: 'done' })
    expect(finished[0].result).toContain('Edited.')
    // Runs AS the bot: its own memories plus the shared pool.
    const systemContent = adapter.chatRequests[0].messages[0].content
    const system = typeof systemContent === 'string' ? systemContent : ''
    expect(system).toContain('You edit.')
    expect(system).toContain('Oxford comma')
    expect(system).toContain('Swedish')
    // Spend is attributed to the bot in the ledger.
    const rows = db.driver.all<{ agent_id: string | null; run_kind: string }>(
      'SELECT agent_id, run_kind FROM headless_usage'
    )
    expect(rows).toEqual([{ agent_id: bot.id, run_kind: 'agent_run' }])
  })

  it('reports stopped on an aborted signal and error when the provider fails; no hooks without a profile', async () => {
    const conversation = seed()
    db.agents.create({ name: 'Editor', systemPrompt: 'You edit.' })
    const finished: DelegateFinishedInfo[] = []
    const adapter = new DelegateAdapter([{ text: 'never', toolCalls: [], finishReason: 'stop' }])
    const service = new ChatService(db, () => undefined, {
      resolveAdapter: () => adapter,
      onDelegateFinished: (info) => finished.push(info),
    })

    const aborted = new AbortController()
    aborted.abort()
    expect(await service.runDelegate('x', ctx(conversation), aborted.signal, 'Editor')).toContain(
      'stopped'
    )
    expect(finished.at(-1)?.status).toBe('stopped')

    const failing = new DelegateAdapter([])
    failing.chat = async () => {
      throw new Error('boom')
    }
    const failingService = new ChatService(db, () => undefined, {
      resolveAdapter: () => failing,
      onDelegateFinished: (info) => finished.push(info),
    })
    expect(await failingService.runDelegate('x', ctx(conversation), undefined, 'Editor')).toContain(
      'Delegation failed'
    )
    expect(finished.at(-1)?.status).toBe('error')

    // The anonymous sub-agent (no agent name) is not a handoff.
    await service.runDelegate('plain', ctx(conversation))
    expect(finished).toHaveLength(2)
  })

  it('a background delegation carries the agent_runs id and the background flag', async () => {
    const conversation = seed()
    const bot = db.agents.create({ name: 'Editor', systemPrompt: 'You edit.' })
    const adapter = new DelegateAdapter([{ text: 'Done.', toolCalls: [], finishReason: 'stop' }])
    const started: DelegateHandoffInfo[] = []
    const finished: DelegateFinishedInfo[] = []
    const service = new ChatService(db, () => undefined, {
      resolveAdapter: () => adapter,
      onDelegateStarted: (info) => started.push(info),
      onDelegateFinished: (info) => finished.push(info),
    })
    service.startDelegateBackground('proofread', ctx(conversation), 'Editor')
    await vi.waitFor(() => expect(finished).toHaveLength(1))
    const run = db.agentPlatform.runsList()[0]
    expect(run.agentId).toBe(bot.id)
    expect(started[0]).toMatchObject({ background: true, runId: run.id })
    expect(finished[0].status).toBe('done')
  })
})
