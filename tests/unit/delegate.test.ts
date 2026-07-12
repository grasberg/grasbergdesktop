import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Conversation,
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
