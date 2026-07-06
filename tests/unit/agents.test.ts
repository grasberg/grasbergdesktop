/**
 * Agent profiles (migration v21): repository round-trip and runDelegate with a
 * named profile — persona replaces the default sub-agent prompt, the profile's
 * dedicated model is used, and the restricted toolset gates tool execution.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelInfo, TestConnectionResult, ToolDefinition } from '@shared/types'
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
  dir = mkdtempSync(join(tmpdir(), 'uld-agents-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('agents repository', () => {
  it('round-trips a profile and looks names up case-insensitively', () => {
    const created = db.agents.create({
      name: 'Researcher',
      description: 'Investigates questions',
      systemPrompt: 'You are a researcher.',
      modelId: 'cheap-model',
      toolIds: ['web_search', 'fetch_url'],
      maxRounds: 6,
    })
    expect(db.agents.getByName('researcher')?.id).toBe(created.id)
    expect(db.agents.getById(created.id)?.toolIds).toEqual(['web_search', 'fetch_url'])

    db.agents.update(created.id, { enabled: false, toolIds: null })
    const updated = db.agents.getById(created.id)
    expect(updated?.enabled).toBe(false)
    expect(updated?.toolIds).toBeNull()
    expect(db.agents.listEnabled()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// runDelegate with a named profile
// ---------------------------------------------------------------------------

class ScriptedAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  readonly chatRequests: AdapterChatRequest[] = []

  async chat(req: AdapterChatRequest): Promise<AdapterChatResult> {
    this.chatRequests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
    if (this.chatRequests.length === 1) {
      return {
        text: '',
        toolCalls: [
          { id: 'c1', name: 'web_search', arguments: '{"query":"x"}', status: 'proposed' },
          { id: 'c2', name: 'read_file', arguments: '{"path":"a"}', status: 'proposed' },
        ],
        finishReason: 'tool_calls',
      }
    }
    return { text: 'Research done.', toolCalls: [], finishReason: 'stop' }
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

function toolDef(id: string): ToolDefinition {
  return {
    id,
    name: id,
    description: id,
    parameters: { type: 'object', properties: {} },
    risk: 'safe',
    builtin: true,
    enabled: true,
  }
}

it('runDelegate(agent=…) uses the profile persona, model and restricted toolset', async () => {
  const provider = db.providers.create({
    id: randomUUID(),
    type: 'openai-compatible',
    label: 'P',
    baseUrl: 'https://x.example/v1',
    defaultModelId: 'default-model',
    enabled: true,
  })
  db.providers.setKeyRow(
    provider.id,
    'insecure:' + Buffer.from('sk-agents', 'utf8').toString('base64'),
    'sk-…nts'
  )
  const conversation = db.conversations.create({
    mode: 'chat',
    title: 'T',
    providerId: provider.id,
    modelId: 'default-model',
  })
  db.agents.create({
    name: 'researcher',
    systemPrompt: 'PERSONA: careful researcher.',
    modelId: 'cheap-model',
    toolIds: ['web_search'],
    maxRounds: 5,
  })

  const adapter = new ScriptedAdapter()
  const execute = vi.fn(async () => 'SEARCH RESULT')
  const tools: ChatToolSystem = {
    registry: {
      listEnabledDefinitions: () => [toolDef('web_search'), toolDef('read_file')],
    },
    executor: { execute },
    broker: { request: vi.fn(async () => ({ approved: true, scope: 'once' as const })) },
  }
  const service = new ChatService(db, () => undefined, {
    tools,
    resolveAdapter: () => adapter,
  })

  const ctx: ToolExecuteContext = {
    conversation,
    approval: async () => ({ approved: true, scope: 'once' }),
  }
  const result = await service.runDelegate('find X', ctx, undefined, 'researcher')
  expect(result).toContain('Research done.')

  // Profile persona + dedicated model on the wire; toolset filtered to the
  // profile's list (read_file is offered nowhere and refused when called).
  const first = adapter.chatRequests[0]
  expect(first.modelId).toBe('cheap-model')
  expect(first.messages[0]).toMatchObject({ role: 'system', content: 'PERSONA: careful researcher.' })
  expect(first.tools?.map((t) => t.name)).toEqual(['web_search'])
  expect(execute).toHaveBeenCalledTimes(1)
  const second = adapter.chatRequests[1]
  const toolMsgs = second.messages.filter((m) => m.role === 'tool')
  expect(toolMsgs).toHaveLength(2)
  expect(toolMsgs[0].content).toBe('SEARCH RESULT')
  expect(toolMsgs[1].content).toContain('not available')
})

it('runDelegate with an unknown agent name lists the available agents', async () => {
  const provider = db.providers.create({
    id: randomUUID(),
    type: 'openai-compatible',
    label: 'P',
    baseUrl: 'https://x.example/v1',
    defaultModelId: 'm',
    enabled: true,
  })
  db.providers.setKeyRow(
    provider.id,
    'insecure:' + Buffer.from('sk-a', 'utf8').toString('base64'),
    'sk-…a'
  )
  const conversation = db.conversations.create({ mode: 'chat', title: 'T', providerId: provider.id, modelId: 'm' })
  db.agents.create({ name: 'writer', systemPrompt: 'w' })

  const service = new ChatService(db, () => undefined, {
    resolveAdapter: () => new ScriptedAdapter(),
  })
  const result = await service.runDelegate(
    'x',
    { conversation, approval: async () => ({ approved: true, scope: 'once' }) },
    undefined,
    'nope'
  )
  expect(result).toContain("no enabled agent named 'nope'")
  expect(result).toContain('writer')
})
