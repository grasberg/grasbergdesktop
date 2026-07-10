/**
 * Deep Research end-to-end over the real db + ChatService (no Electron):
 * /research plans with a JSON call, workers gather via web_search/fetch_url
 * through the (stubbed) tool system, activities stream as research-activity
 * events, and the acting model synthesizes through the ordinary runStream —
 * with the numbered sources injected into its last user turn, the Sources
 * section appended to the content, and the run info persisted (research_json).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  ModelInfo,
  StreamEventEnvelope,
  TestConnectionResult,
  ToolDefinition,
} from '@shared/types'
import { CHANNELS } from '@shared/ipc'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import type {
  AdapterChatRequest,
  AdapterChatResult,
  AdapterContext,
  AdapterStreamEvent,
  ProviderAdapter,
} from '../../src/main/providers/adapter'
import { ChatService, type ChatToolSystem } from '../../src/main/services/chat-service'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-research-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const SEARCH_RESULT = '1. Example Site — https://example.com/a\n   Heat pump efficiency data.'
const PAGE_RESULT =
  'HTTP 200 OK\n\n<html><head><title>Example Page</title></head><body>COP of 4.</body></html>'

function toolDef(name: string): ToolDefinition {
  return {
    id: name,
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    risk: 'sensitive',
    builtin: true,
    enabled: true,
  }
}

/** Stub tool system: canned search/page results, no approvals involved. */
function makeToolSystem(): ChatToolSystem & { executedNames: string[] } {
  const executedNames: string[] = []
  return {
    executedNames,
    registry: { listEnabledDefinitions: () => [toolDef('web_search'), toolDef('fetch_url')] },
    executor: {
      execute: async (toolCall) => {
        executedNames.push(toolCall.name)
        return toolCall.name === 'web_search' ? SEARCH_RESULT : PAGE_RESULT
      },
    },
    broker: {
      request: async () => ({ approved: true, scope: 'once' as const }),
    },
  }
}

/**
 * Scripted adapter: the planner (responseFormat json) returns two queries;
 * worker rounds are keyed by how many tool results the transcript carries
 * (0 → web_search call, 1 → fetch_url call, then findings). The synthesis
 * runs through chatStream.
 */
class ResearchAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  readonly chatRequests: AdapterChatRequest[] = []
  readonly streamRequests: AdapterChatRequest[] = []
  streamText = 'Heat pumps beat gas [1].'
  private seq = 0
  /** When set, worker chat() calls wait on it (for abort tests). */
  gate: Deferred<void> | null = null
  /** When true, planner/worker chat() calls all fail. */
  failChat = false

  async chat(req: AdapterChatRequest): Promise<AdapterChatResult> {
    this.chatRequests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
    if (this.gate) await this.gate.promise
    if (this.failChat) throw new Error('provider down')
    if (req.params.responseFormat === 'json') {
      return {
        text: JSON.stringify({ queries: ['heat pump efficiency', 'gas boiler costs'] }),
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      }
    }
    const toolRounds = req.messages.filter((m) => m.role === 'tool').length
    if (toolRounds === 0) {
      return {
        text: '',
        toolCalls: [
          {
            id: `s-${++this.seq}`,
            name: 'web_search',
            arguments: JSON.stringify({ query: 'heat pumps' }),
            status: 'proposed',
          },
        ],
        finishReason: 'tool_calls',
      }
    }
    if (toolRounds === 1) {
      return {
        text: '',
        toolCalls: [
          {
            id: `f-${++this.seq}`,
            name: 'fetch_url',
            arguments: JSON.stringify({ url: 'https://example.com/a' }),
            status: 'proposed',
          },
        ],
        finishReason: 'tool_calls',
      }
    }
    return {
      text: 'Finding: COP of 4 per https://example.com/a.',
      toolCalls: [],
      finishReason: 'stop',
    }
  }

  async *chatStream(
    req: AdapterChatRequest,
    ctx: AdapterContext
  ): AsyncGenerator<AdapterStreamEvent> {
    this.streamRequests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
    if (ctx.signal?.aborted) {
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    }
    yield { type: 'text', text: this.streamText }
    yield { type: 'finish', reason: 'stop' }
  }

  async listModels(): Promise<ModelInfo[]> {
    return []
  }
  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'ok' }
  }
}

interface Harness {
  service: ChatService
  adapter: ResearchAdapter
  tools: ReturnType<typeof makeToolSystem>
  envelopes: StreamEventEnvelope[]
  done: Promise<StreamEventEnvelope>
}

function makeHarness(): Harness {
  const adapter = new ResearchAdapter()
  const tools = makeToolSystem()
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
      if (envelope.event.type === 'done' || envelope.event.type === 'error') resolveDone(envelope)
    },
    { resolveAdapter: () => adapter, tools }
  )
  return { service, adapter, tools, envelopes, done }
}

function seedConversation(): string {
  const provider = db.providers.create({
    id: randomUUID(),
    type: 'openai-compatible',
    label: 'Fake',
    baseUrl: 'https://fake.example/v1',
    defaultModelId: 'main-model',
    enabled: true,
  })
  db.providers.setKeyRow(
    provider.id,
    'insecure:' + Buffer.from('sk-research', 'utf8').toString('base64'),
    'sk-…rch'
  )
  const conversation = db.conversations.create({
    mode: 'chat',
    title: 'Research',
    providerId: provider.id,
    modelId: 'main-model',
  })
  return conversation.id
}

function activityEvents(
  envelopes: StreamEventEnvelope[]
): Extract<StreamEventEnvelope['event'], { type: 'research-activity' }>[] {
  return envelopes
    .map((e) => e.event)
    .filter(
      (e): e is Extract<typeof e, { type: 'research-activity' }> => e.type === 'research-activity'
    )
}

describe('ChatService — Deep Research', () => {
  it('plans, gathers, streams activities and synthesizes a cited report', async () => {
    const conversationId = seedConversation()
    const { service, adapter, tools, envelopes, done } = makeHarness()

    const start = await service.send({
      conversationId,
      content: 'Are heat pumps worth it?',
      overrides: { research: {} }, // depth from settings default (standard)
    })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    // Planner ran in JSON mode; each worker searched then fetched.
    const plannerCalls = adapter.chatRequests.filter((r) => r.params.responseFormat === 'json')
    expect(plannerCalls).toHaveLength(1)
    expect(tools.executedNames.filter((n) => n === 'web_search')).toHaveLength(2)
    expect(tools.executedNames.filter((n) => n === 'fetch_url')).toHaveLength(2)

    // Live activities covered every phase.
    const phases = new Set(activityEvents(envelopes).map((e) => e.activity.phase))
    expect(phases).toEqual(new Set(['planning', 'searching', 'reading', 'synthesizing']))

    // Synthesis: one tool-free stream whose last user turn carries the
    // question, the findings and the numbered source list.
    expect(adapter.streamRequests).toHaveLength(1)
    expect(adapter.streamRequests[0].tools).toBeUndefined()
    const lastUser = [...adapter.streamRequests[0].messages]
      .reverse()
      .find((m) => m.role === 'user')
    const lastUserText = typeof lastUser?.content === 'string' ? lastUser.content : ''
    expect(lastUserText).toContain('Are heat pumps worth it?')
    expect(lastUserText).toContain('### Topic: heat pump efficiency')
    expect(lastUserText).toContain('[1] Example Site — https://example.com/a')

    // Final message: report + appended Sources section + persisted run info.
    const finalMessage = doneEnvelope.event.message
    expect(finalMessage.id).toBe(start.assistantMessage.id)
    expect(finalMessage.status).toBe('complete')
    expect(finalMessage.content).toContain('Heat pumps beat gas [1].')
    expect(finalMessage.content).toContain('## Sources')
    expect(finalMessage.content).toContain('1. [Example Site](https://example.com/a)')
    expect(finalMessage.research?.depth).toBe('standard')
    expect(finalMessage.research?.plan).toEqual(['heat pump efficiency', 'gas boiler costs'])
    expect(finalMessage.research?.sources).toHaveLength(1)
    expect(finalMessage.research?.searches).toBe(2)
    expect(finalMessage.research?.pagesRead).toBe(2)
    expect(finalMessage.research?.workerUsage?.totalTokens).toBeGreaterThan(0)
    // Activities are renderer-transient — never persisted.
    expect(finalMessage.research?.activities).toBeUndefined()

    // research_json round-trips through the repository (v23).
    const stored = db.messages.listByConversation(conversationId)
    const storedFinal = stored[stored.length - 1]
    expect(storedFinal.research?.sources[0]?.url).toBe('https://example.com/a')
  })

  it('honors the depth override from the request', async () => {
    const conversationId = seedConversation()
    const { service, done } = makeHarness()
    await service.send({
      conversationId,
      content: 'q',
      overrides: { research: { depth: 'quick' } },
    })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')
    expect(doneEnvelope.event.message.research?.depth).toBe('quick')
  })

  it('aborting mid-gather finalizes stopped and still persists the run info', async () => {
    const conversationId = seedConversation()
    const { service, adapter, done } = makeHarness()
    adapter.gate = deferred<void>()

    const start = await service.send({
      conversationId,
      content: 'slow question',
      overrides: { research: {} },
    })
    // The planner call is gated in-flight: stop before it resolves.
    service.stop(start.streamId)
    adapter.gate.resolve()

    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')
    expect(doneEnvelope.event.finishReason).toBe('aborted')
    expect(doneEnvelope.event.message.status).toBe('stopped')
    expect(doneEnvelope.event.message.research).toBeTruthy()
    expect(doneEnvelope.event.message.content).toBe('')
  })

  it('degrades to answer-from-knowledge when every worker call fails', async () => {
    const conversationId = seedConversation()
    const { service, adapter, done } = makeHarness()
    adapter.failChat = true

    await service.send({ conversationId, content: 'q', overrides: { research: {} } })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    const message = doneEnvelope.event.message
    expect(message.status).toBe('complete')
    expect(message.research?.sources).toHaveLength(0)
    // No Sources section is appended when there are no sources.
    expect(message.content).not.toContain('## Sources')
    // The synthesizer was told research failed.
    const lastUser = [...adapter.streamRequests[0].messages].reverse().find((m) => m.role === 'user')
    const lastUserText = typeof lastUser?.content === 'string' ? lastUser.content : ''
    expect(lastUserText).toMatch(/research .* failed|unavailable/i)
  })

  it('a research send wins over the conversation MoA preset', async () => {
    const conversationId = seedConversation()
    const conversation = db.conversations.getById(conversationId)!
    const preset = {
      id: 'p1',
      name: 'Panel',
      referenceModels: [{ providerId: conversation.providerId!, modelId: 'adv' }],
      aggregator: { providerId: conversation.providerId!, modelId: 'agg' },
      enabled: true,
    }
    db.settings.update({ moaPresets: [preset] })
    db.conversations.update(conversationId, { moaPresetId: preset.id })

    const { service, envelopes, done } = makeHarness()
    await service.send({ conversationId, content: 'q', overrides: { research: {} } })
    const doneEnvelope = await done
    if (doneEnvelope.event.type !== 'done') throw new Error('expected done')

    // No moa-reference events: research bypassed the MoA preset for this send.
    expect(envelopes.some((e) => e.event.type === 'moa-reference')).toBe(false)
    expect(doneEnvelope.event.message.moaReferences).toBeUndefined()
    expect(doneEnvelope.event.message.research).toBeTruthy()
  })
})
