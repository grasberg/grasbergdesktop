/**
 * What a headless run (scheduled task, workflow node) can now do that it could
 * not before:
 *
 * 1. ASK. With a remote channel wired it puts an un-pre-approved tool call to
 *    the user instead of auto-declining it. Every outcome that is not an
 *    explicit allow — no channel, no answer, a broken bridge — stays a decline.
 * 2. REMEMBER. A run owned by an agent profile sees that agent's memories and
 *    writes back under the same owner, so a recurring job accumulates its own
 *    context instead of starting cold.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
import { CodeService } from '../../src/main/code/code-service'
import { createToolSystem } from '../../src/main/tools'
import { HEADLESS_CONVERSATION_ID } from '../../src/main/tools/executor'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-headless-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function providerWithKey(suffix: string): string {
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
    'insecure:' + Buffer.from(`sk-${suffix}`, 'utf8').toString('base64'),
    `sk-…${suffix}`
  )
  return provider.id
}

/** Calls one tool on the first round, then finishes. */
class ToolThenDoneAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  readonly chatRequests: AdapterChatRequest[] = []
  constructor(private readonly wireName: string) {}
  async chat(req: AdapterChatRequest): Promise<AdapterChatResult> {
    this.chatRequests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
    if (this.chatRequests.length === 1) {
      return {
        text: '',
        toolCalls: [{ id: 't1', name: this.wireName, arguments: '{}', status: 'proposed' }],
        finishReason: 'tool_calls',
      }
    }
    return { text: 'Done.', toolCalls: [], finishReason: 'stop' }
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

/** Returns a fixed reply and records what it was asked. */
class EchoAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  readonly chatRequests: AdapterChatRequest[] = []
  constructor(private readonly reply: string) {}
  async chat(req: AdapterChatRequest): Promise<AdapterChatResult> {
    this.chatRequests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
    return { text: this.reply, toolCalls: [], finishReason: 'stop' }
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

interface HeadlessFixture {
  providerId: string
  adapter: ToolThenDoneAdapter
  tools: ChatToolSystem
}

/** A run whose single tool call goes through the real 'ask' shape. */
function headlessFixture(keySuffix: string): HeadlessFixture {
  const adapter = new ToolThenDoneAdapter('deploy')
  const tool: ToolDefinition = {
    id: 'deploy',
    name: 'deploy',
    description: 'ships it',
    parameters: { type: 'object', properties: {} },
    risk: 'dangerous',
    builtin: false,
    enabled: true,
  }
  const execute = vi.fn(async (toolCall, ctx: ToolExecuteContext) => {
    const answer = await ctx.approval({
      streamId: ctx.streamId ?? '',
      conversationId: ctx.conversation.id,
      toolCall,
      risk: 'dangerous',
    })
    return answer.approved ? 'Shipped.' : 'User declined this tool call.'
  })
  return {
    providerId: providerWithKey(keySuffix),
    adapter,
    tools: {
      registry: { listEnabledDefinitions: () => [tool] },
      executor: { execute },
      broker: { request: vi.fn(async () => ({ approved: false, scope: 'once' as const })) },
    },
  }
}

function toolResult(adapter: ToolThenDoneAdapter): string {
  const content = adapter.chatRequests[1].messages.find((m) => m.role === 'tool')?.content
  return typeof content === 'string' ? content : ''
}

function fileRunFixture(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  const projectDir = join(dir, 'worktree')
  mkdirSync(projectDir)
  const project = db.code.projectUpsertByPath(projectDir, 'Headless worktree')
  const code = new CodeService(db)
  const tools = createToolSystem(db, code, {
    codeChanges: {
      propose: (cid, path, kind, content) => code.proposeChange(cid, path, kind, content),
      proposeForProject: (pid, path, kind, content) => code.proposeProjectChange(pid, path, kind, content),
      apply: (id) => code.applyChange(id),
    },
  })
  const adapter = new EchoAdapter('Done.')
  let round = 0
  vi.spyOn(adapter, 'chat').mockImplementation(async (request) => {
    adapter.chatRequests.push(request)
    const call = calls[round++]
    return call
      ? { text: '', toolCalls: [{ id: `file-${round}`, name: call.name, arguments: JSON.stringify(call.args), status: 'proposed' }], finishReason: 'tool_calls' }
      : { text: 'Done.', toolCalls: [], finishReason: 'stop' }
  })
  const providerId = providerWithKey('files')
  const service = new ChatService(db, () => undefined, {
    tools: { ...tools, broker: { request: vi.fn(async () => ({ approved: false, scope: 'once' as const })) } },
    resolveAdapter: () => adapter,
  })
  const run = (overrides: Parameters<ChatService['generateForWorkflow']>[3] = {}) =>
    service.generateForWorkflow('change the granted files', providerId, 'm', {
      useTools: true,
      approvedToolIds: ['write_file', 'edit_file'],
      projectId: project.id,
      ...overrides,
    })
  return { projectDir, project, code, tools, adapter, run }
}

it('creates and edits in the granted worktree without borrowing a saved conversation', async () => {
  const fixture = fileRunFixture([
    { name: 'write_file', args: { path: 'result.txt', content: 'before' } },
    { name: 'edit_file', args: { path: 'result.txt', old_string: 'before', new_string: 'after' } },
  ])
  const original = join(dir, 'original')
  mkdirSync(original)
  const originalProject = db.code.projectUpsertByPath(original, 'Original project')
  // Even a saved row colliding with the synthetic id must not steal its scope.
  db.conversations.create({ id: HEADLESS_CONVERSATION_ID, mode: 'work', projectId: originalProject.id })
  expect(await fixture.run()).toBe('Done.')
  expect(readFileSync(join(fixture.projectDir, 'result.txt'), 'utf8')).toBe('after')
  expect(existsSync(join(original, 'result.txt'))).toBe(false)
  const changes = db.code.changesList(fixture.project.id)
  expect(changes).toHaveLength(2)
  expect(changes.every((change) => change.conversationId === null && change.status === 'applied')).toBe(true)
  const edit = changes.find((change) => change.changeType === 'edit')!
  fixture.code.revertChange(edit.id)
  expect(readFileSync(join(fixture.projectDir, 'result.txt'), 'utf8')).toBe('before')
})

it('reports a denied headless write as failure even when the model says Done', async () => {
  const fixture = fileRunFixture([{ name: 'write_file', args: { path: 'denied.txt', content: 'no' } }])
  fixture.tools.registry.setPermission('write_file', 'deny')
  await expect(fixture.run()).rejects.toThrow(/File changes failed:.*denied/s)
  expect(existsSync(join(fixture.projectDir, 'denied.txt'))).toBe(false)
  expect(fixture.adapter.chatRequests).toHaveLength(2)
})

it('keeps the read-only sandbox effective for a pre-approved headless write', async () => {
  const fixture = fileRunFixture([{ name: 'write_file', args: { path: 'readonly.txt', content: 'no' } }])
  await expect(fixture.run({ sandboxLevel: 'read-only' })).rejects.toThrow(/File changes failed:.*read-only/s)
  expect(existsSync(join(fixture.projectDir, 'readonly.txt'))).toBe(false)
})

it('rejects an escaping headless path and reports failure to the caller', async () => {
  const fixture = fileRunFixture([{ name: 'write_file', args: { path: '../outside.txt', content: 'no' } }])
  await expect(fixture.run()).rejects.toThrow(/File changes failed:/)
  expect(existsSync(join(dir, 'outside.txt'))).toBe(false)
  expect(db.code.changesList(fixture.project.id)).toHaveLength(0)
})

it('allows the model to recover a failed edit with a corrected retry of the same path', async () => {
  const fixture = fileRunFixture([
    { name: 'edit_file', args: { path: './result.txt', old_string: 'missing', new_string: 'after' } },
    { name: 'edit_file', args: { path: 'result.txt', old_string: 'before', new_string: 'after' } },
  ])
  writeFileSync(join(fixture.projectDir, 'result.txt'), 'before')
  expect(await fixture.run()).toBe('Done.')
  expect(readFileSync(join(fixture.projectDir, 'result.txt'), 'utf8')).toBe('after')
})

it('does not erase another file failure after one successful write', async () => {
  const fixture = fileRunFixture([
    { name: 'edit_file', args: { path: 'missing.txt', old_string: 'before', new_string: 'after' } },
    { name: 'write_file', args: { path: 'success.txt', content: 'yes' } },
  ])
  await expect(fixture.run()).rejects.toThrow(/File changes failed:.*missing.txt/s)
  expect(readFileSync(join(fixture.projectDir, 'success.txt'), 'utf8')).toBe('yes')
})

it('reports a file tool outside the agent toolset as a failed operation', async () => {
  const fixture = fileRunFixture([{ name: 'write_file', args: { path: 'unavailable.txt', content: 'no' } }])
  const agent = db.agents.create({ name: 'Reader', systemPrompt: 'Read only.', toolIds: ['read_file'] })
  await expect(fixture.run({ agentId: agent.id })).rejects.toThrow(/File changes failed:.*not available/s)
  expect(existsSync(join(fixture.projectDir, 'unavailable.txt'))).toBe(false)
})

it('asks over the remote channel when nothing pre-approved the call', async () => {
  const fixture = headlessFixture('r1')
  const remoteApproval = vi.fn(async (_input: { title: string; detail: string }) => true)
  const service = new ChatService(db, () => undefined, {
    tools: fixture.tools,
    resolveAdapter: () => fixture.adapter,
    remoteApproval,
  })

  await service.generateForWorkflow('ship it', fixture.providerId, 'm', { useTools: true })

  expect(remoteApproval).toHaveBeenCalledTimes(1)
  expect(remoteApproval.mock.calls[0][0].title).toContain('deploy')
  expect(toolResult(fixture.adapter)).toBe('Shipped.')
})

it('never bothers the remote channel about a pre-approved tool', async () => {
  const fixture = headlessFixture('r2')
  const remoteApproval = vi.fn(async () => true)
  const service = new ChatService(db, () => undefined, {
    tools: fixture.tools,
    resolveAdapter: () => fixture.adapter,
    remoteApproval,
  })

  await service.generateForWorkflow('ship it', fixture.providerId, 'm', {
    useTools: true,
    approvedToolIds: ['deploy'],
  })

  expect(remoteApproval).not.toHaveBeenCalled()
  expect(toolResult(fixture.adapter)).toBe('Shipped.')
})

it('reads every non-allow remote outcome as a decline', async () => {
  const cases: Array<[string, () => Promise<boolean | null>]> = [
    // Nobody answered in time, or no channel is configured.
    ['r3', async () => null],
    ['r4', async () => false],
    [
      'r5',
      async () => {
        throw new Error('bridge down')
      },
    ],
  ]
  for (const [suffix, remote] of cases) {
    const fixture = headlessFixture(suffix)
    const service = new ChatService(db, () => undefined, {
      tools: fixture.tools,
      resolveAdapter: () => fixture.adapter,
      remoteApproval: remote,
    })
    await service.generateForWorkflow('ship it', fixture.providerId, 'm', { useTools: true })
    expect(toolResult(fixture.adapter)).toContain('declined')
  }
})

it('declines without asking when no remote channel is wired at all', async () => {
  const fixture = headlessFixture('r6')
  const service = new ChatService(db, () => undefined, {
    tools: fixture.tools,
    resolveAdapter: () => fixture.adapter,
  })
  await service.generateForWorkflow('ship it', fixture.providerId, 'm', { useTools: true })
  expect(toolResult(fixture.adapter)).toContain('declined')
})

it("injects an agent's own memories plus the shared pool — never another agent's", async () => {
  const providerId = providerWithKey('m1')
  const watcher = db.agents.create({ name: 'Watcher', systemPrompt: 'You watch.' })
  const scribe = db.agents.create({ name: 'Scribe', systemPrompt: 'You write.' })
  db.memories.create({ title: 'last-seen', content: 'build 41', agentId: watcher.id })
  db.memories.create({ title: 'other-agent', content: 'not yours', agentId: scribe.id })
  db.memories.create({ title: 'shared-fact', content: 'user speaks Swedish' })

  const adapter = new EchoAdapter('Nothing new.')
  const service = new ChatService(db, () => undefined, { resolveAdapter: () => adapter })
  await service.generateForWorkflow('check', providerId, 'm', { agentId: watcher.id })

  const systemContent = adapter.chatRequests[0].messages.find((m) => m.role === 'system')?.content
  const system = typeof systemContent === 'string' ? systemContent : ''
  expect(system).toContain('You watch.')
  expect(system).toContain('build 41')
  // Own memories plus the user's shared pool; another agent's stay private.
  expect(system).not.toContain('not yours')
  expect(system).toContain('user speaks Swedish')
})

it("persists an agent's memory block under that agent, not the shared pool", async () => {
  const providerId = providerWithKey('m2')
  const watcher = db.agents.create({ name: 'Watcher', systemPrompt: 'You watch.' })
  const fence = '```'
  const reply = [
    'Checked.',
    `${fence}uld-memory`,
    '{"title":"last-seen","action":"remember"}',
    'build 42',
    fence,
  ].join('\n')

  const service = new ChatService(db, () => undefined, {
    resolveAdapter: () => new EchoAdapter(reply),
  })
  await service.generateForWorkflow('check', providerId, 'm', { agentId: watcher.id })

  expect(db.memories.listForAgent(null)).toHaveLength(0)
  expect(db.memories.listForAgent(watcher.id)).toMatchObject([
    { title: 'last-seen', content: 'build 42' },
  ])
})

it('writes no agent memory while the memory setting is off', async () => {
  const providerId = providerWithKey('m3')
  const watcher = db.agents.create({ name: 'Watcher', systemPrompt: 'You watch.' })
  db.settings.update({ memoryEnabled: false })
  const fence = '```'
  const reply = [`${fence}uld-memory`, '{"title":"last-seen"}', 'build 42', fence].join('\n')

  const service = new ChatService(db, () => undefined, {
    resolveAdapter: () => new EchoAdapter(reply),
  })
  await service.generateForWorkflow('check', providerId, 'm', { agentId: watcher.id })
  expect(db.memories.list()).toHaveLength(0)
})

it('a run with no agent profile leaves agent memories untouched and unseen', async () => {
  const providerId = providerWithKey('m4')
  const watcher = db.agents.create({ name: 'Watcher', systemPrompt: 'You watch.' })
  db.memories.create({ title: 'last-seen', content: 'build 41', agentId: watcher.id })

  const adapter = new EchoAdapter('ok')
  const service = new ChatService(db, () => undefined, { resolveAdapter: () => adapter })
  await service.generateForWorkflow('check', providerId, 'm', {})

  // No profile means no persona message at all, so nothing to leak into.
  expect(adapter.chatRequests[0].messages.some((m) => m.role === 'system')).toBe(false)
  expect(db.memories.listForAgent(watcher.id)).toHaveLength(1)
})

// ---------------------------------------------------------------------------
// A headless run raising its hand (ask_user_question)
// ---------------------------------------------------------------------------

/** A run whose single tool call is a question to the user. */
function questionFixture(keySuffix: string): HeadlessFixture {
  const adapter = new ToolThenDoneAdapter('ask_user_question')
  const tool: ToolDefinition = {
    id: 'ask_user_question',
    name: 'ask_user_question',
    description: 'asks the user',
    parameters: { type: 'object', properties: {} },
    risk: 'safe',
    builtin: true,
    enabled: true,
  }
  // Mirrors the real tool: it forwards to ctx.askUser and reports the answer.
  const execute = vi.fn(async (_toolCall, ctx: ToolExecuteContext) => {
    if (!ctx.askUser) return 'Error: asking the user a question is unavailable here.'
    const answer = await ctx.askUser('Which branch?', ['main', 'develop'])
    return answer === null
      ? 'The user dismissed the question without answering. Proceed with your best judgment.'
      : `The user answered: ${answer}`
  })
  return {
    providerId: providerWithKey(keySuffix),
    adapter,
    tools: {
      registry: { listEnabledDefinitions: () => [tool] },
      executor: { execute },
      broker: { request: vi.fn(async () => ({ approved: false, scope: 'once' as const })) },
    },
  }
}

it('puts a question from a headless run to the user over the side channel', async () => {
  const fixture = questionFixture('q1')
  const remoteChoice = vi.fn(async (_input: { question: string; options: string[] }) => 'develop')
  const service = new ChatService(db, () => undefined, {
    tools: fixture.tools,
    resolveAdapter: () => fixture.adapter,
    remoteChoice,
  })

  await service.generateForWorkflow('open a PR', fixture.providerId, 'm', { useTools: true })

  expect(remoteChoice).toHaveBeenCalledTimes(1)
  expect(remoteChoice.mock.calls[0][0].options).toEqual(['main', 'develop'])
  expect(toolResult(fixture.adapter)).toBe('The user answered: develop')
})

it('tells the model to use its own judgement when nobody could be reached', async () => {
  // No channel at all, and a channel that answered nothing: a headless run
  // must keep going rather than stalling on a question no one will see.
  for (const [suffix, remoteChoice] of [
    ['q2', undefined],
    ['q3', vi.fn(async () => null)],
  ] as const) {
    const fixture = questionFixture(suffix)
    const service = new ChatService(db, () => undefined, {
      tools: fixture.tools,
      resolveAdapter: () => fixture.adapter,
      ...(remoteChoice ? { remoteChoice } : {}),
    })
    await service.generateForWorkflow('open a PR', fixture.providerId, 'm', { useTools: true })
    expect(toolResult(fixture.adapter)).toContain('best judgment')
  }
})

it('a broken question channel is a dismissal, not a crash', async () => {
  const fixture = questionFixture('q4')
  const service = new ChatService(db, () => undefined, {
    tools: fixture.tools,
    resolveAdapter: () => fixture.adapter,
    remoteChoice: async () => {
      throw new Error('bridge down')
    },
  })
  await service.generateForWorkflow('open a PR', fixture.providerId, 'm', { useTools: true })
  expect(toolResult(fixture.adapter)).toContain('best judgment')
})
