/**
 * Tool loop end-to-end over the real db + ChatService (no Electron): a
 * scripted fake adapter first asks for a tool call, the (stubbed, auto-
 * approving) executor runs it, the results round-trip back as an assistant
 * toolCalls message plus a role-'tool' message, and the second adapter
 * invocation streams the final text into the same assistant placeholder.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Conversation,
  Message,
  ModelInfo,
  StreamEventEnvelope,
  TestConnectionResult,
  ToolCallRecord,
  ToolDefinition,
} from '@shared/types'
import { CHANNELS } from '@shared/ipc'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import type {
  AdapterChatRequest,
  AdapterChatResult,
  AdapterStreamEvent,
  ProviderAdapter,
} from '../../src/main/providers/adapter'
import type { ToolExecuteContext } from '../../src/main/tools/executor'
import { ChatService, type ChatToolSystem } from '../../src/main/services/chat-service'

const TOOL_RESULT = 'alpha.txt:2: the needle is here'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-tool-loop-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Scripted fake adapter: round 1 = tool_call + finish 'tool_calls',
// round 2 = text + finish 'stop'.
// ---------------------------------------------------------------------------

class FakeAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  /** Snapshot of each chatStream request (messages copied at call time). */
  readonly invocations: AdapterChatRequest[] = []

  async *chatStream(req: AdapterChatRequest): AsyncGenerator<AdapterStreamEvent> {
    // The service mutates its message array between rounds — snapshot it.
    this.invocations.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
    if (this.invocations.length === 1) {
      yield { type: 'text', text: 'Let me check.' }
      yield {
        type: 'tool_call',
        toolCall: {
          id: 'call-1',
          name: 'file_search',
          arguments: '{"query":"needle"}',
          status: 'proposed',
        },
      }
      yield { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
      yield { type: 'finish', reason: 'tool_calls' }
      return
    }
    yield { type: 'text', text: 'Found it in alpha.txt.' }
    yield { type: 'usage', usage: { promptTokens: 20, completionTokens: 7, totalTokens: 27 } }
    yield { type: 'finish', reason: 'stop' }
  }

  async chat(): Promise<AdapterChatResult> {
    throw new Error('not used in this test')
  }

  async listModels(): Promise<ModelInfo[]> {
    return []
  }

  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'ok' }
  }
}

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

const fileSearchDefinition: ToolDefinition = {
  id: 'file_search',
  name: 'file_search',
  description: 'Search the granted project files.',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  risk: 'sensitive',
  builtin: true,
  enabled: true,
}

function seedProviderAndConversation(): Conversation {
  const provider = db.providers.create({
    id: randomUUID(),
    type: 'openai-compatible',
    label: 'Fake provider',
    baseUrl: 'https://fake.example/v1',
    defaultModelId: 'fake-model',
    enabled: true,
  })
  // 'insecure:'-prefixed keys decrypt without Electron safeStorage.
  db.providers.setKeyRow(
    provider.id,
    'insecure:' + Buffer.from('sk-test-tool-loop', 'utf8').toString('base64'),
    'sk-…loop'
  )
  return db.conversations.create({
    mode: 'chat',
    title: 'Tool loop',
    providerId: provider.id,
    modelId: 'fake-model',
  })
}

interface Harness {
  service: ChatService
  adapter: FakeAdapter
  envelopes: StreamEventEnvelope[]
  done: Promise<StreamEventEnvelope>
  execute: ReturnType<typeof vi.fn>
  brokerRequest: ReturnType<typeof vi.fn>
}

function makeHarness(): Harness {
  const adapter = new FakeAdapter()
  const envelopes: StreamEventEnvelope[] = []
  let resolveDone: (env: StreamEventEnvelope) => void = () => undefined
  const done = new Promise<StreamEventEnvelope>((resolve) => {
    resolveDone = resolve
  })
  const broadcast = (channel: string, payload: unknown): void => {
    if (channel !== CHANNELS.streamEvent) return
    const envelope = payload as StreamEventEnvelope
    envelopes.push(envelope)
    if (envelope.event.type === 'done' || envelope.event.type === 'error') {
      resolveDone(envelope)
    }
  }

  // Auto-approving broker stub + executor stub that exercises the approval
  // seam exactly like the real ToolExecutor would for an 'ask' permission.
  const brokerRequest = vi.fn(async () => ({ approved: true, scope: 'once' as const }))
  const execute = vi.fn(async (toolCall: ToolCallRecord, ctx: ToolExecuteContext) => {
    const answer = await ctx.approval({
      streamId: ctx.streamId ?? '',
      conversationId: ctx.conversation.id,
      toolCall,
      risk: 'sensitive',
    })
    return answer.approved ? TOOL_RESULT : 'declined'
  })
  const tools: ChatToolSystem = {
    registry: { listEnabledDefinitions: () => [fileSearchDefinition] },
    executor: { execute },
    broker: { request: brokerRequest },
  }

  const service = new ChatService(db, broadcast, {
    tools,
    resolveAdapter: () => adapter,
  })
  return { service, adapter, envelopes, done, execute, brokerRequest }
}

// ---------------------------------------------------------------------------

describe('ChatService tool loop (real db, scripted adapter)', () => {
  it('runs the full round-trip: tool_call -> execute -> tool message -> final text', async () => {
    const conversation = seedProviderAndConversation()
    const { service, adapter, envelopes, done, execute, brokerRequest } = makeHarness()

    const start = await service.send({ conversationId: conversation.id, content: 'find the needle' })
    expect(start.userMessage).toMatchObject({ role: 'user', content: 'find the needle' })
    expect(start.assistantMessage.status).toBe('streaming')

    const doneEnvelope = await done
    expect(doneEnvelope.event.type).toBe('done')

    // --- two adapter invocations, tools offered on the wire ------------------
    expect(adapter.invocations).toHaveLength(2)
    expect(adapter.invocations[0].tools).toEqual([
      {
        name: 'file_search',
        description: fileSearchDefinition.description,
        parameters: fileSearchDefinition.parameters,
      },
    ])

    // --- round-trip: assistant toolCalls message + role-'tool' result --------
    const secondMessages = adapter.invocations[1].messages
    const firstCount = adapter.invocations[0].messages.length
    expect(secondMessages.slice(0, firstCount)).toEqual(adapter.invocations[0].messages)
    const appended = secondMessages.slice(firstCount)
    expect(appended).toHaveLength(2)
    expect(appended[0]).toMatchObject({
      role: 'assistant',
      content: 'Let me check.',
      toolCalls: [
        expect.objectContaining({
          id: 'call-1',
          name: 'file_search',
          arguments: '{"query":"needle"}',
          result: TOOL_RESULT,
          status: 'done',
        }),
      ],
    })
    expect(appended[1]).toEqual({ role: 'tool', content: TOOL_RESULT, toolCallId: 'call-1' })

    // --- executor + broker seams were exercised ------------------------------
    expect(execute).toHaveBeenCalledTimes(1)
    const [, ctx] = execute.mock.calls[0] as [ToolCallRecord, ToolExecuteContext]
    expect(ctx.conversation.id).toBe(conversation.id)
    expect(ctx.streamId).toBe(start.streamId)
    expect(brokerRequest).toHaveBeenCalledTimes(1)

    // --- streamed envelopes include the tool-call events ----------------------
    const toolCallEvents = envelopes
      .map((env) => env.event)
      .filter((event) => event.type === 'tool-call')
    expect(toolCallEvents.length).toBeGreaterThanOrEqual(2)
    expect(toolCallEvents[0]).toMatchObject({
      toolCall: { id: 'call-1', name: 'file_search', status: 'proposed' },
    })
    expect(toolCallEvents[toolCallEvents.length - 1]).toMatchObject({
      toolCall: { id: 'call-1', status: 'done', result: TOOL_RESULT },
    })
    for (const envelope of envelopes) {
      expect(envelope.streamId).toBe(start.streamId)
      expect(envelope.conversationId).toBe(conversation.id)
    }

    // --- final persisted assistant message ------------------------------------
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done event')
    const finalMessage = doneEnvelope.event.message
    expect(finalMessage.id).toBe(start.assistantMessage.id)
    expect(finalMessage.status).toBe('complete')
    expect(finalMessage.content).toBe('Let me check.\n\nFound it in alpha.txt.')
    expect(finalMessage.toolCalls).toEqual([
      expect.objectContaining({
        id: 'call-1',
        name: 'file_search',
        result: TOOL_RESULT,
        status: 'done',
      }),
    ])
    // Usage is summed across both rounds.
    expect(finalMessage.usage).toEqual({
      promptTokens: 30,
      completionTokens: 12,
      totalTokens: 42,
    })

    // History renders from the db exactly the same way.
    const persisted = db.messages.listByConversation(conversation.id)
    expect(persisted).toHaveLength(2)
    const storedAssistant = persisted[1] as Message
    expect(storedAssistant).toMatchObject({
      id: start.assistantMessage.id,
      role: 'assistant',
      status: 'complete',
      content: 'Let me check.\n\nFound it in alpha.txt.',
    })
    expect(storedAssistant.toolCalls).toHaveLength(1)
    expect(storedAssistant.toolCalls![0]).toMatchObject({
      id: 'call-1',
      result: TOOL_RESULT,
      status: 'done',
    })

    // Streamed text deltas reconstruct the persisted content (incl. separator).
    const streamedText = envelopes
      .map((env) => env.event)
      .filter((event): event is Extract<typeof event, { type: 'text-delta' }> =>
        event.type === 'text-delta'
      )
      .map((event) => event.text)
      .join('')
    expect(streamedText).toBe(finalMessage.content)
  })

  it('records a denied tool call and still finishes the generation', async () => {
    const conversation = seedProviderAndConversation()
    const adapter = new FakeAdapter()
    const envelopes: StreamEventEnvelope[] = []
    let resolveDone: (env: StreamEventEnvelope) => void = () => undefined
    const done = new Promise<StreamEventEnvelope>((resolve) => {
      resolveDone = resolve
    })
    const service = new ChatService(
      db,
      (channel, payload) => {
        if (channel !== CHANNELS.streamEvent) return
        const envelope = payload as StreamEventEnvelope
        envelopes.push(envelope)
        if (envelope.event.type === 'done' || envelope.event.type === 'error') {
          resolveDone(envelope)
        }
      },
      {
        tools: {
          registry: { listEnabledDefinitions: () => [fileSearchDefinition] },
          // Mirrors the real executor's decline sentinel exactly.
          executor: { execute: async () => 'User declined this tool call.' },
          broker: { request: async () => ({ approved: false, scope: 'once' as const }) },
        },
        resolveAdapter: () => adapter,
      }
    )

    await service.send({ conversationId: conversation.id, content: 'find the needle' })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done event')

    expect(adapter.invocations).toHaveLength(2)
    const finalMessage = doneEnvelope.event.message
    expect(finalMessage.status).toBe('complete')
    expect(finalMessage.toolCalls).toEqual([
      expect.objectContaining({
        id: 'call-1',
        status: 'denied',
        result: 'User declined this tool call.',
      }),
    ])
    // The declined result still round-trips as the role-'tool' message.
    const toolMessage = adapter.invocations[1].messages.find((m) => m.role === 'tool')
    expect(toolMessage).toEqual({
      role: 'tool',
      content: 'User declined this tool call.',
      toolCallId: 'call-1',
    })
  })

  it('replays earlier turns’ tool rounds in the next turn (tool memory)', async () => {
    const conversation = seedProviderAndConversation()
    const first = makeHarness()
    await first.service.send({ conversationId: conversation.id, content: 'find the needle' })
    await first.done

    // Turn 2 (fresh service over the same db): the history handed to the
    // adapter must replay turn 1's tool round — tool_use turn, its result,
    // then the final answer as its own assistant turn.
    const second = makeHarness()
    await second.service.send({ conversationId: conversation.id, content: 'where exactly?' })
    await second.done

    const messages = second.adapter.invocations[0].messages
    const i = messages.findIndex((m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0)
    expect(i).toBeGreaterThan(0)
    expect(messages[i].content).toBe('')
    expect(messages[i].toolCalls?.[0]).toMatchObject({ id: 'call-1', name: 'file_search' })
    expect(messages[i + 1]).toEqual({ role: 'tool', content: TOOL_RESULT, toolCallId: 'call-1' })
    expect(messages[i + 2]).toMatchObject({
      role: 'assistant',
      content: 'Let me check.\n\nFound it in alpha.txt.',
    })
    // The new user turn follows the replayed round.
    expect(messages[messages.length - 1]).toMatchObject({
      role: 'user',
      content: 'where exactly?',
    })
  })
})
