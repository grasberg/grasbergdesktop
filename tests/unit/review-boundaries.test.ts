import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { applyBackup, buildBackup } from '../../src/main/services/backup'
import { ChatService, type ChatToolSystem } from '../../src/main/services/chat-service'
import { BotService, type BotChatService } from '../../src/main/services/bots'
import { currentInvocationPolicy } from '../../src/main/invocation-context'
import { createRemoteRouter } from '../../src/main/remote/router'
import { CHANNELS } from '../../src/shared/ipc'
import type { ProviderAdapter, AdapterChatRequest, AdapterChatResult, AdapterContext } from '../../src/main/providers/adapter'
import type { ToolDefinition } from '../../src/shared/types'
import type { ToolExecuteContext } from '../../src/main/tools/executor'

let dir: string
let db: AppDatabase
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'grasberg-review-')); db = openDatabase(join(dir, 'db.sqlite')) })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
function seed() {
  const p = db.providers.create({ id: 'p', type: 'openai-compatible', label: 'fake', baseUrl: 'https://fake.example/v1', defaultModelId: 'm', enabled: true })
  db.providers.setKeyRow(p.id, 'insecure:' + Buffer.from('fake-review-key').toString('base64'), 'fake')
  db.settings.update({ defaultProviderId: p.id, defaultModelId: 'm' })
  return db.conversations.create({ mode: 'chat', title: 'Parent', providerId: p.id, modelId: 'm' })
}
function adapter(chat: (req: AdapterChatRequest, ctx: AdapterContext) => Promise<AdapterChatResult>): ProviderAdapter {
  return { type: 'openai-compatible', chat, async *chatStream() {}, async listModels() { return [] }, async testConnection() { return { ok: true, message: 'ok' } } }
}
const tool: ToolDefinition = { id: 'file_search', name: 'file_search', description: 'test', parameters: { type: 'object' }, risk: 'safe', builtin: true, enabled: true }
const call = { id: 't1', name: tool.name, arguments: '{}', status: 'proposed' as const }
const done: AdapterChatResult = { text: 'Done', toolCalls: [], finishReason: 'stop' }
function toolSystem(execute: ChatToolSystem['executor']['execute'] = vi.fn(async () => 'ok')): ChatToolSystem {
  return { registry: { listEnabledDefinitions: () => [tool] }, executor: { execute }, broker: { request: async () => ({ approved: true, scope: 'once' }) } }
}

it('backup retains private memory ownership', () => {
  const bot = db.agents.create({ name: 'Private', systemPrompt: 'private' })
  db.memories.create({ title: 'Private fact', content: 'private-only value', agentId: bot.id })
  const target = openDatabase(join(dir, 'target.sqlite'))
  try {
    applyBackup(target, buildBackup(db))
    expect(target.memories.listVisibleTo(null).map(m => m.content)).not.toContain('private-only value')
  } finally { target.close() }
})

it('foreground delegate stops before dispatch for an aborted parent', async () => {
  const conversation = seed()
  const chat = vi.fn(async () => done)
  const service = new ChatService(db, () => {}, { resolveAdapter: () => adapter(chat) })
  const c = new AbortController(); c.abort()
  await service.runDelegate('task', { conversation, signal: c.signal, approval: async () => ({ approved: true, scope: 'once' }) }, undefined)
  expect(chat).not.toHaveBeenCalled()
})

it('headless agent rejects tools outside its restricted toolset', async () => {
  seed()
  const bot = db.agents.create({ name: 'Restricted', systemPrompt: 'test', toolIds: [] })
  const requests: AdapterChatRequest[] = []
  const execute = vi.fn(async (_call, _ctx: ToolExecuteContext) => 'ok')
  const service = new ChatService(db, () => {}, { tools: toolSystem(execute), resolveAdapter: () => adapter(async req => {
    requests.push(req)
    return requests.length === 1 ? { text: '', toolCalls: [call], finishReason: 'tool_calls' } : done
  }) })
  await service.generateForWorkflow('task', undefined, undefined, { agentId: bot.id, useTools: true })
  expect(requests[0].tools).toBeUndefined()
  expect(execute).not.toHaveBeenCalled()
})

it('headless bot tools retain the acting browser owner', async () => {
  seed()
  const bot = db.agents.create({ name: 'Browser bot', systemPrompt: 'test', toolIds: [tool.id] })
  let count = 0
  const execute = vi.fn(async (_call, _ctx: ToolExecuteContext) => 'ok')
  const service = new ChatService(db, () => {}, { tools: toolSystem(execute), resolveAdapter: () => adapter(async () => ++count === 1 ? { text: '', toolCalls: [call], finishReason: 'tool_calls' } : done) })
  await service.generateForWorkflow('task', undefined, undefined, { agentId: bot.id, useTools: true })
  expect(execute.mock.calls[0]?.[1]?.conversation.agentId).toBe(bot.id)
})

it('delegate records incurred usage once when a later round fails', async () => {
  const conversation = seed()
  let count = 0
  const service = new ChatService(db, () => {}, { tools: toolSystem(), resolveAdapter: () => adapter(async () => {
    if (++count === 1) return { text: '', toolCalls: [call], finishReason: 'tool_calls', usage: { promptTokens: 1000, completionTokens: 100 } }
    throw new Error('simulated transport failure')
  }) })
  await service.runDelegate('task', { conversation, approval: async () => ({ approved: true, scope: 'once' }) })
  expect(db.driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM headless_usage')?.n).toBe(1)
})

it('stopping a busy group cancels its pending sends', async () => {
  const bot = db.agents.create({ name: 'One', systemPrompt: 'test' })
  const observer = db.agents.create({ name: 'Two', systemPrompt: 'test' })
  let release: (value: string) => void = () => {}
  const signals: AbortSignal[] = []
  const generate = vi.fn((_prompt, _provider, _model, opts) => {
    signals.push(opts.signal)
    return signals.length === 1 ? new Promise<string>(resolve => { release = resolve }) : Promise.resolve('PASS')
  })
  const service = new BotService({ db, broadcast: () => {}, chat: { generateForWorkflow: generate } as unknown as BotChatService })
  const group = service.createGroup({ name: 'Room', memberIds: [bot.id, observer.id], activation: 'mention' })
  service.groupSend(group.id, '@One first')
  service.groupSend(group.id, '@One second')
  service.stopGroup(group.id)
  expect(signals[0].aborted).toBe(true)
  release('PASS')
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(generate).toHaveBeenCalledTimes(1)
  service.groupSend(group.id, '@One new request after stopping')
  await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2))
  expect(signals[1].aborted).toBe(false)
})

it('private delegation does not mirror into an ordinary backup', () => {
  const space = db.spaces.create({ name: 'Private' })
  const conversation = db.conversations.create({ mode: 'chat', title: 'Private title', spaceId: space.id })
  const bot = db.agents.create({ name: 'Reviewer', systemPrompt: 'test' })
  const service = new BotService({ db, broadcast: () => {}, chat: {} as BotChatService })
  const info = { delegateKey: 'review', agentId: bot.id, agentName: bot.name, callerConversationId: conversation.id, callerAgentId: null, callerTitle: conversation.title, task: 'private task content', background: false, runId: null }
  service.delegateStarted(info)
  service.delegateFinished({ ...info, status: 'done', result: 'private result content' })
  const backup = buildBackup(db)
  expect(backup.conversations.some(c => c.id === conversation.id)).toBe(false)
  expect(JSON.stringify(backup)).not.toContain('private task content')
  expect(JSON.stringify(backup)).not.toContain('private result content')
})

it.each(['drain', 'send', 'edit'] as const)('queued remote restrictions survive consumption by %s', async (consumer) => {
  const original = seed()
  const work = db.conversations.create({ mode: 'work', title: 'Work', providerId: original.providerId, modelId: original.modelId })
  const conversation = db.conversations.update(work.id, { params: { sandboxLevel: 'full', autoAcceptEdits: true } })!
  let release: () => void = () => {}
  const policies: unknown[] = []
  const requests: AdapterChatRequest[] = []
  const execute = vi.fn(async (_call, _ctx: ToolExecuteContext) => 'ok')
  const a = adapter(async () => done)
  a.chatStream = async function* (req) {
    requests.push(req)
    policies.push(currentInvocationPolicy())
    if (requests.length === 1) await new Promise<void>(resolve => { release = resolve })
    if (requests.length === 2) {
      yield { type: 'tool_call', toolCall: call }
      yield { type: 'finish', reason: 'tool_calls' }
      return
    }
    yield { type: 'text', text: 'Done' }
    yield { type: 'finish', reason: 'stop' }
  }
  const service = new ChatService(db, () => {}, { resolveAdapter: () => a, tools: toolSystem(execute) })
  await service.send({ conversationId: conversation.id, content: 'desktop request' })
  const router = createRemoteRouter(new Map([[CHANNELS.chatSend, (req: unknown) => service.send(req as any, { queueIfBusy: true })]]))
  const response = await router(CHANNELS.chatSend, [{ conversationId: conversation.id, content: 'remote request' }])
  expect(response).toMatchObject({ ok: true, data: { queued: true } })
  release()
  if (consumer !== 'drain') {
    await vi.waitFor(() => expect(service.isConversationActive(conversation.id)).toBe(false))
    if (consumer === 'send') {
      await service.send({ conversationId: conversation.id, content: 'desktop follow-up' })
    } else {
      const queued = db.messages.listByConversation(conversation.id).at(-1)!
      await service.editAndRerun({ conversationId: conversation.id, messageId: queued.id, newContent: 'edited remote request' })
    }
  }
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1), { timeout: 2000 })
  expect(policies[1]).toMatchObject({ origin: 'remote', sandboxLevel: 'workspace-write', autoAcceptEdits: false })
  expect(requests[1].params).toMatchObject({ sandboxLevel: 'workspace-write', autoAcceptEdits: false })
  expect(execute.mock.calls[0]?.[1]).toMatchObject({ sandboxLevel: 'workspace-write', autoAcceptEdits: false })
  await service.stopAll()
})

it.each([false, true])('only ordinary delegates may persist bot memories (private=%s)', async (privateSpace) => {
  const original = seed()
  const space = privateSpace ? db.spaces.create({ name: 'Secret' }) : null
  const conversation = db.conversations.create({ mode: 'chat', title: 'Caller', providerId: original.providerId, modelId: original.modelId, spaceId: space?.id })
  const bot = db.agents.create({ name: 'Memory bot', systemPrompt: 'test' })
  const service = new ChatService(db, () => {}, { resolveAdapter: () => adapter(async () => ({ ...done, text: '```uld-memory\n{"title":"secret"}\nprivate detail\n```' })) })
  await service.runDelegate('task', { conversation, approval: async () => ({ approved: true, scope: 'once' }) }, undefined, bot.name)
  expect(db.memories.list().some((m) => m.content === 'private detail')).toBe(!privateSpace)
})

it('a private source removed before delegation cannot be mirrored from its snapshot', () => {
  const space = db.spaces.create({ name: 'Secret' })
  const caller = db.conversations.create({ mode: 'chat', title: 'Secret', spaceId: space.id })
  const bot = db.agents.create({ name: 'Target', systemPrompt: 'test' })
  db.conversations.remove(caller.id)
  const service = new BotService({ db, broadcast: () => {}, chat: {} as BotChatService })
  const info = { delegateKey: 'gone', agentId: bot.id, agentName: bot.name, callerConversationId: caller.id, callerSpaceId: space.id, callerAgentId: null, callerTitle: caller.title, task: 'secret', background: false, runId: null }
  service.delegateStarted(info)
  service.delegateFinished({ ...info, status: 'done', result: 'secret' })
  expect(db.agents.getById(bot.id)!.chatConversationId).toBeNull()
})

it('cancellation between delegated tools prevents later side effects and retains incurred usage', async () => {
  const conversation = seed()
  const controller = new AbortController()
  const execute = vi.fn(async (_call, ctx: ToolExecuteContext) => { expect(ctx.signal).toBe(controller.signal); controller.abort(); return 'ok' })
  const service = new ChatService(db, () => {}, { tools: toolSystem(execute), resolveAdapter: () => adapter(async () => ({ text: '', toolCalls: [call, { ...call, id: 't2' }], finishReason: 'tool_calls', usage: { promptTokens: 10, completionTokens: 5 } })) })
  const result = await service.runDelegate('task', { conversation, signal: controller.signal, approval: async () => ({ approved: true, scope: 'once' }) })
  expect(result).toBe('The task was stopped.')
  expect(execute).toHaveBeenCalledTimes(1)
  expect(db.driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM headless_usage')?.n).toBe(1)
})

it('named delegates use their own browser and drain their own screenshots', async () => {
  const conversation = seed()
  const bot = db.agents.create({ name: 'Browser delegate', systemPrompt: 'test', toolIds: [tool.id] })
  let round = 0
  const execute = vi.fn(async (_call, _ctx: ToolExecuteContext) => 'ok')
  const consumePendingScreenshot = vi.fn(() => null)
  const service = new ChatService(db, () => {}, { tools: toolSystem(execute), browser: { consumePendingScreenshot }, resolveAdapter: () => adapter(async () => ++round === 1 ? { text: '', toolCalls: [call], finishReason: 'tool_calls' } : done) })
  await service.runDelegate('task', { conversation, approval: async () => ({ approved: true, scope: 'once' }) }, undefined, bot.name)
  expect(execute.mock.calls[0][1]).toMatchObject({ agentId: bot.id, conversation: { id: conversation.id } })
  expect(consumePendingScreenshot).toHaveBeenCalledWith(bot.id)
})

it.each(['wire_name', 'custom:test'])('headless allowed custom tools resolve by wire name or id: %s', async (name) => {
  seed()
  const custom = { ...tool, id: 'custom:test', name: 'wire_name', builtin: false }
  const bot = db.agents.create({ name: 'Custom', systemPrompt: 'test', toolIds: [custom.id] })
  let round = 0
  const execute = vi.fn(async () => 'ok')
  const system = toolSystem(execute)
  system.registry.listEnabledDefinitions = () => [custom]
  const service = new ChatService(db, () => {}, { tools: system, resolveAdapter: () => adapter(async () => ++round === 1 ? { text: '', toolCalls: [{ ...call, name }], finishReason: 'tool_calls' } : done) })
  await service.generateForWorkflow('task', undefined, undefined, { agentId: bot.id, useTools: true })
  expect(execute).toHaveBeenCalledTimes(1)
})

it('queued remote messages do not enter desktop history across a compaction await', async () => {
  const conversation = seed()
  const requests: AdapterChatRequest[] = []
  const a = adapter(async () => done)
  a.chatStream = async function* (req) {
    requests.push(req)
    yield { type: 'text', text: 'Done' }
    yield { type: 'finish', reason: 'stop' }
  }
  const service = new ChatService(db, () => {}, { resolveAdapter: () => a })
  const seam = service as unknown as { maybeCompact: (...args: unknown[]) => Promise<void> }
  let resume!: () => void
  vi.spyOn(seam, 'maybeCompact').mockImplementationOnce(() => new Promise<void>((resolve) => { resume = resolve }))
  await service.send({ conversationId: conversation.id, content: 'desktop task' })
  await vi.waitFor(() => expect(resume).toBeTypeOf('function'))
  const router = createRemoteRouter(new Map([[CHANNELS.chatSend, (req: unknown) => service.send(req as any, { queueIfBusy: true })]]))
  await router(CHANNELS.chatSend, [{ conversationId: conversation.id, content: 'queued remote instruction' }])
  resume()
  await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 3000 })
  expect(JSON.stringify(requests[0].messages)).not.toContain('queued remote instruction')
  expect(JSON.stringify(requests[1].messages)).toContain('queued remote instruction')
  expect(requests[1].params).toMatchObject({ sandboxLevel: 'workspace-write', autoAcceptEdits: false })
  await service.stopAll()
})

it('private background delegate results are readable only by their originating conversation', async () => {
  const ordinary = seed()
  const space = db.spaces.create({ name: 'Private' })
  const conversation = db.conversations.create({ mode: 'chat', title: 'Private', spaceId: space.id, providerId: ordinary.providerId, modelId: ordinary.modelId })
  const service = new ChatService(db, () => {}, { resolveAdapter: () => adapter(async () => ({ ...done, text: 'private background answer' })) })
  const ctx = { conversation, approval: async () => ({ approved: true, scope: 'once' as const }) }
  service.startDelegateBackground('private background task', ctx)
  await vi.waitFor(() => expect(service.delegateTaskOutput('task-1', ctx)).toContain('private background answer'))
  expect(service.delegateTaskOutput('task-1', { ...ctx, conversation: ordinary })).toContain('unknown task')
  expect(service.delegateTaskOutput('task-1')).toContain('unknown task')
})
