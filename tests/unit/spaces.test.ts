/**
 * Private spaces (v45) — THE exclusion-surface checklist. Every surface the
 * charter names must filter on space membership, and each maps to a describe
 * block below:
 *
 *   1. conversation list + search + sidebar snippets — repository WHERE
 *      ('conversations repository space scoping')
 *   2. backup export — private conversations excluded unless the explicit
 *      include flag is set; import restores spaces ('backup')
 *   3. mobile relay — conversation-addressed channels refused, spaceId params
 *      stripped ('remote router'), pushes dropped ('remotePushAllowed')
 *   4. Telegram bridge — bind guard at im:setTelegram (the runtime
 *      handleInbound backstop lives in tests/unit/im/manager.test.ts)
 *   4b. outbound webhook — onCompletion never posts a private-space
 *      conversation (tests/unit/im/manager.test.ts)
 *   5. desktop notifications — title-only ('titleOnlyForPrivateSpace')
 *   6. agent inbox — private agent runs show without preview text
 *      ('buildInboxItems private blanking')
 *
 * Plus the provider allowlist enforced at generation time ('provider
 * allowlist') and the spaces IPC guards ('spaces IPC').
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHANNELS, type ChannelName, type IpcResult } from '@shared/ipc'
import type {
  AgentRun,
  Conversation,
  Message,
  ModelInfo,
  StreamEventEnvelope,
  TestConnectionResult,
} from '@shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { registerIpc, type RegisterIpcDeps } from '../../src/main/ipc/register'
import { applyBackup, buildBackup } from '../../src/main/services/backup'
import { buildInboxItems } from '../../src/main/services/inbox'
import { titleOnlyForPrivateSpace } from '../../src/main/services/notify'
import { createRemoteRouter, remotePushAllowed } from '../../src/main/remote/router'
import type { IpcHandlerMap } from '../../src/main/ipc/handler-map'
import type {
  AdapterChatRequest,
  AdapterChatResult,
  AdapterContext,
  AdapterStreamEvent,
  ProviderAdapter,
} from '../../src/main/providers/adapter'
import { ChatService } from '../../src/main/services/chat-service'
import type { SetTelegramInput } from '../../src/main/im/manager'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => tmpdir() },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
  },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    },
  },
  shell: { openPath: async () => '' },
}))

let dir: string
let db: AppDatabase
let telegramBinds: SetTelegramInput[]

async function invoke<T>(channel: ChannelName, ...args: unknown[]): Promise<IpcResult<T>> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler registered for ${channel}`)
  return (await handler(null, ...args)) as IpcResult<T>
}

function registerHarness(): void {
  handlers.clear()
  telegramBinds = []
  registerIpc({
    db,
    chatService: { stopConversation: () => undefined },
    imBridgeManager: {
      setTelegram: (input: SetTelegramInput) => {
        telegramBinds.push(input)
        return {
          telegramEnabled: input.enabled,
          telegramConversationId: input.conversationId,
          telegramConnected: false,
          hasToken: false,
          telegramPairingCode: null,
          webhookUrl: null,
        }
      },
    },
    workspaceRoots: { withAutoFlag: (p: unknown) => p, deleteIfAutoRegistered: () => undefined },
    getWindows: () => [],
  } as unknown as RegisterIpcDeps)
}

function message(conversationId: string, seq: number, content: string): Message {
  return {
    id: randomUUID(),
    conversationId,
    role: seq % 2 === 1 ? 'user' : 'assistant',
    content,
    seq,
    status: 'complete',
    createdAt: Date.now(),
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-spaces-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// -- surface 1: conversation list + search + snippets ------------------------

describe('conversations repository space scoping', () => {
  it('defaults to the default space (space rows never leak into a plain list)', () => {
    const space = db.spaces.create({ name: 'Secret' })
    db.conversations.create({ mode: 'chat', title: 'Public' })
    db.conversations.create({ mode: 'chat', title: 'Hidden', spaceId: space.id })

    expect(db.conversations.list().map((c) => c.title)).toEqual(['Public'])
  })

  it('an explicit spaceId lists only that space; allSpaces lists everything', () => {
    const a = db.spaces.create({ name: 'A' })
    const b = db.spaces.create({ name: 'B' })
    db.conversations.create({ mode: 'chat', title: 'Default' })
    db.conversations.create({ mode: 'chat', title: 'In A', spaceId: a.id })
    db.conversations.create({ mode: 'chat', title: 'In B', spaceId: b.id })

    expect(db.conversations.list({ spaceId: a.id }).map((c) => c.title)).toEqual(['In A'])
    expect(db.conversations.list({ allSpaces: true })).toHaveLength(3)
  })

  it('summaries carry spaceId (the renderer guards cross-space refreshes on it)', () => {
    const space = db.spaces.create({ name: 'S' })
    db.conversations.create({ mode: 'chat', title: 'Hidden', spaceId: space.id })
    const [summary] = db.conversations.list({ spaceId: space.id })
    expect(summary.spaceId).toBe(space.id)
    db.conversations.create({ mode: 'chat', title: 'Public' })
    expect(db.conversations.list()[0].spaceId).toBeNull()
  })

  it('search and the snippet subquery never cross spaces', () => {
    const space = db.spaces.create({ name: 'Secret' })
    const hidden = db.conversations.create({ mode: 'chat', title: 'Hidden', spaceId: space.id })
    db.messages.insert(message(hidden.id, 1, 'the launch codes are 0000'))
    const open = db.conversations.create({ mode: 'chat', title: 'Open' })
    db.messages.insert(message(open.id, 1, 'nothing to see'))

    // Match by title and by message content: both stay inside the default space.
    expect(db.conversations.list({ search: 'Hidden' })).toHaveLength(0)
    expect(db.conversations.list({ search: 'launch codes' })).toHaveLength(0)
    // Inside the space, the same search matches.
    expect(db.conversations.list({ spaceId: space.id, search: 'launch codes' })).toHaveLength(1)
    // Snippets in a listing come only from that listing's own rows.
    const summaries = db.conversations.list()
    expect(JSON.stringify(summaries)).not.toContain('launch codes')
  })

  it('listPrivateSpaceConversationIds lists exactly the space members', () => {
    const space = db.spaces.create({ name: 'S' })
    const hidden = db.conversations.create({ mode: 'chat', title: 'H', spaceId: space.id })
    db.conversations.create({ mode: 'chat', title: 'P' })
    expect(db.conversations.listPrivateSpaceConversationIds()).toEqual([hidden.id])
  })
})

// -- spaces repository + IPC guards ------------------------------------------

describe('spaces repository', () => {
  it('round-trips the allowlist and collapses empty to null', () => {
    const space = db.spaces.create({ name: 'S', providerAllowlist: ['p1', 'p2'] })
    expect(db.spaces.getById(space.id)?.providerAllowlist).toEqual(['p1', 'p2'])
    db.spaces.update(space.id, { providerAllowlist: null })
    expect(db.spaces.getById(space.id)?.providerAllowlist).toBeNull()
  })

  it('removeProviderFromAllowlists filters the id and collapses empty to null', () => {
    const both = db.spaces.create({ name: 'Both', providerAllowlist: ['p1', 'p2'] })
    const only = db.spaces.create({ name: 'Only', providerAllowlist: ['p1'] })
    const other = db.spaces.create({ name: 'Other', providerAllowlist: ['p2'] })

    db.spaces.removeProviderFromAllowlists('p1')

    expect(db.spaces.getById(both.id)?.providerAllowlist).toEqual(['p2'])
    // A list that would become empty collapses to null (= all providers)
    // rather than leaving a space that can never generate.
    expect(db.spaces.getById(only.id)?.providerAllowlist).toBeNull()
    expect(db.spaces.getById(other.id)?.providerAllowlist).toEqual(['p2'])
  })
})

describe('spaces IPC', () => {
  beforeEach(registerHarness)

  it('creates, rejects a case-insensitive duplicate name, renames', async () => {
    const created = await invoke<{ id: string }>(CHANNELS.spacesCreate, { name: 'Work' })
    expect(created.ok).toBe(true)
    const dup = await invoke(CHANNELS.spacesCreate, { name: 'work' })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.error.message).toContain('already exists')
  })

  it('refuses to delete a non-empty space; deletes once empty', async () => {
    const space = db.spaces.create({ name: 'S' })
    const conversation = db.conversations.create({ mode: 'chat', spaceId: space.id })

    const refused = await invoke(CHANNELS.spacesDelete, space.id)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.message).toContain('only be deleted when empty')
    expect(db.spaces.getById(space.id)).not.toBeNull()

    db.conversations.remove(conversation.id)
    expect((await invoke(CHANNELS.spacesDelete, space.id)).ok).toBe(true)
    expect(db.spaces.getById(space.id)).toBeNull()
  })

  it('rejects unknown providers in an allowlist update', async () => {
    const space = db.spaces.create({ name: 'S' })
    const result = await invoke(CHANNELS.spacesUpdate, {
      id: space.id,
      patch: { providerAllowlist: ['ghost'] },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('Unknown provider')
  })

  it('providers:delete scrubs the deleted id from every space allowlist', async () => {
    const providerId = randomUUID()
    db.providers.create({
      id: providerId,
      type: 'openai',
      label: 'Main',
      baseUrl: 'https://api.openai.com/v1',
      defaultModelId: 'gpt-5.5',
    })
    const space = db.spaces.create({ name: 'S', providerAllowlist: [providerId] })

    expect((await invoke(CHANNELS.providersDelete, providerId)).ok).toBe(true)
    expect(db.spaces.getById(space.id)?.providerAllowlist).toBeNull()
  })

  it('conv:create validates the spaceId and stamps membership', async () => {
    const ghost = await invoke(CHANNELS.convCreate, { mode: 'chat', spaceId: 'ghost' })
    expect(ghost.ok).toBe(false)

    const space = db.spaces.create({ name: 'S' })
    const created = await invoke<Conversation>(CHANNELS.convCreate, {
      mode: 'chat',
      spaceId: space.id,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(db.conversations.getById(created.data.id)?.spaceId).toBe(space.id)
  })

  it('conv:fork keeps the fork in the source conversation space', async () => {
    const space = db.spaces.create({ name: 'S' })
    const source = db.conversations.create({ mode: 'chat', title: 'Src', spaceId: space.id })
    db.messages.insert(message(source.id, 1, 'hello'))

    const fork = await invoke<Conversation>(CHANNELS.convFork, { id: source.id })
    expect(fork.ok).toBe(true)
    if (!fork.ok) return
    expect(db.conversations.getById(fork.data.id)?.spaceId).toBe(space.id)
  })
})

// -- surface 2: backup export/import -----------------------------------------

describe('backup', () => {
  const seed = (): { spaceId: string; hiddenId: string; publicId: string } => {
    const space = db.spaces.create({ name: 'Secret', providerAllowlist: ['p1'] })
    const hidden = db.conversations.create({ mode: 'chat', title: 'Hidden', spaceId: space.id })
    db.messages.insert(message(hidden.id, 1, 'private words'))
    const open = db.conversations.create({ mode: 'chat', title: 'Public' })
    db.messages.insert(message(open.id, 1, 'public words'))
    return { spaceId: space.id, hiddenId: hidden.id, publicId: open.id }
  }

  it('excludes private-space conversations (and the spaces section) by default', () => {
    seed()
    const backup = buildBackup(db)
    expect(backup.conversations.map((c) => c.title)).toEqual(['Public'])
    expect(backup.spaces).toBeUndefined()
    expect(JSON.stringify(backup)).not.toContain('private words')
  })

  it('includes them + a spaces section with the explicit flag', () => {
    const { spaceId, hiddenId } = seed()
    const backup = buildBackup(db, { includePrivateSpaces: true })
    expect(backup.conversations.map((c) => c.title).sort()).toEqual(['Hidden', 'Public'])
    expect(backup.spaces).toEqual([
      { id: spaceId, name: 'Secret', providerAllowlist: ['p1'] },
    ])
    expect(backup.conversations.find((c) => c.id === hiddenId)?.spaceId).toBe(spaceId)
  })

  it('applyBackup recreates spaces and remaps membership on a fresh database', () => {
    seed()
    const backup = JSON.parse(JSON.stringify(buildBackup(db, { includePrivateSpaces: true })))

    const dir2 = mkdtempSync(join(tmpdir(), 'uld-spaces-import-'))
    const db2 = openDatabase(join(dir2, 'app.db'))
    try {
      const summary = applyBackup(db2, backup)
      expect(summary.conversationsImported).toBe(2)
      const spaces = db2.spaces.list()
      expect(spaces.map((s) => s.name)).toEqual(['Secret'])
      // Allowlists reference provider ids that don't survive backups → null.
      expect(spaces[0].providerAllowlist).toBeNull()
      expect(db2.conversations.list({ spaceId: spaces[0].id }).map((c) => c.title)).toEqual([
        'Hidden',
      ])
      expect(db2.conversations.list().map((c) => c.title)).toEqual(['Public'])
    } finally {
      db2.close()
      rmSync(dir2, { recursive: true, force: true })
    }
  })

  it('matches an existing space by case-insensitive name instead of duplicating', () => {
    seed()
    const backup = JSON.parse(JSON.stringify(buildBackup(db, { includePrivateSpaces: true })))

    const dir2 = mkdtempSync(join(tmpdir(), 'uld-spaces-import2-'))
    const db2 = openDatabase(join(dir2, 'app.db'))
    try {
      const existing = db2.spaces.create({ name: 'secret' })
      applyBackup(db2, backup)
      expect(db2.spaces.list()).toHaveLength(1)
      expect(db2.conversations.list({ spaceId: existing.id })).toHaveLength(1)
    } finally {
      db2.close()
      rmSync(dir2, { recursive: true, force: true })
    }
  })

  it('drops an unknown spaceId to the default space, and v3 files import clean', () => {
    const v3 = {
      format: 'grasberg-backup',
      version: 3,
      conversations: [
        { id: 'c-v3', mode: 'chat', title: 'Old', messages: [] },
        // A spaceId with no spaces section (tampered/partial file).
        { id: 'c-orphan', mode: 'chat', title: 'Orphan', spaceId: 'gone', messages: [] },
      ],
    }
    const summary = applyBackup(db, v3)
    expect(summary.conversationsImported).toBe(2)
    expect(db.conversations.getById('c-orphan')?.spaceId).toBeNull()
    expect(db.conversations.list().map((c) => c.title).sort()).toEqual(['Old', 'Orphan'])
  })
})

// -- surface 3: the mobile relay ---------------------------------------------

describe('remote router', () => {
  const privateId = 'private-conv'
  const isConversationRemotable = (id: string): boolean => id !== privateId

  const makeRouter = (): { captured: unknown[]; run: ReturnType<typeof createRemoteRouter> } => {
    const captured: unknown[] = []
    const map: IpcHandlerMap = new Map()
    for (const channel of [
      CHANNELS.convList,
      CHANNELS.convCreate,
      CHANNELS.convGet,
      CHANNELS.convUpdate,
      CHANNELS.convDelete,
      CHANNELS.convMessages,
      CHANNELS.convFork,
      CHANNELS.chatSend,
      CHANNELS.chatRegenerate,
      CHANNELS.chatEditAndRerun,
      CHANNELS.chatPickCompareWinner,
      CHANNELS.chatCompact,
    ]) {
      map.set(channel, async (...args: unknown[]) => {
        captured.push(args[0])
        return { ok: true }
      })
    }
    return { captured, run: createRemoteRouter(map, { isConversationRemotable }) }
  }

  it('refuses every conversation-addressed channel for a private conversation', async () => {
    const { captured, run } = makeRouter()
    const calls: Array<[ChannelName, unknown[]]> = [
      [CHANNELS.convGet, [privateId]],
      [CHANNELS.convDelete, [privateId]],
      [CHANNELS.convMessages, [privateId]],
      [CHANNELS.chatCompact, [privateId]],
      [CHANNELS.convUpdate, [{ id: privateId, patch: { title: 'x' } }]],
      [CHANNELS.convFork, [{ id: privateId }]],
      [CHANNELS.chatSend, [{ conversationId: privateId, content: 'hi' }]],
      [CHANNELS.chatRegenerate, [{ conversationId: privateId, messageId: 'm' }]],
      [CHANNELS.chatEditAndRerun, [{ conversationId: privateId, messageId: 'm', content: 'x' }]],
      [CHANNELS.chatPickCompareWinner, [{ conversationId: privateId, messageId: 'm', referenceIndex: 0 }]],
    ]
    for (const [channel, args] of calls) {
      const result = await run(channel, args)
      expect(result.ok, channel).toBe(false)
      if (!result.ok) expect(result.error.message).toContain('not available remotely')
    }
    expect(captured).toHaveLength(0)
  })

  it('serves the same channels for a default-space conversation', async () => {
    const { captured, run } = makeRouter()
    const result = await run(CHANNELS.convGet, ['open-conv'])
    expect(result.ok).toBe(true)
    expect(captured).toHaveLength(1)
  })

  it('strips spaceId from remote conv:list and conv:create', async () => {
    const { captured, run } = makeRouter()
    await run(CHANNELS.convList, [{ mode: 'chat', spaceId: 's1', limit: 5 }])
    await run(CHANNELS.convCreate, [{ mode: 'chat', spaceId: 's1' }])
    expect(captured[0]).toEqual({ mode: 'chat', limit: 5 })
    expect(captured[1]).toEqual({ mode: 'chat' })
  })
})

describe('remotePushAllowed', () => {
  const isRemotable = (id: string): boolean => id !== 'private-conv'

  it('drops payloads naming a private conversation', () => {
    const dropped: Array<[string, unknown]> = [
      [CHANNELS.streamEvent, { streamId: 's', conversationId: 'private-conv', event: {} }],
      [CHANNELS.toolApprovalRequest, { requestId: 'r', conversationId: 'private-conv' }],
      [CHANNELS.userQuestionRequest, { requestId: 'r', conversationId: 'private-conv' }],
      [CHANNELS.conversationsChanged, { conversationId: 'private-conv' }],
      [CHANNELS.arenaChanged, { arena: { conversationId: 'private-conv' } }],
    ]
    for (const [channel, payload] of dropped) {
      expect(remotePushAllowed(channel, payload, isRemotable), channel).toBe(false)
    }
  })

  it('passes default-space payloads and payloads with no conversation reference', () => {
    expect(
      remotePushAllowed(CHANNELS.streamEvent, { conversationId: 'open' }, isRemotable)
    ).toBe(true)
    expect(remotePushAllowed(CHANNELS.scheduledTasksChanged, {}, isRemotable)).toBe(true)
    expect(remotePushAllowed(CHANNELS.toolRulesChanged, undefined, isRemotable)).toBe(true)
    expect(
      remotePushAllowed(CHANNELS.arenaChanged, { arena: { conversationId: 'open' } }, isRemotable)
    ).toBe(true)
  })
})

// -- surface 4: the Telegram bridge (bind guard) ------------------------------

describe('im:setTelegram bind guard', () => {
  beforeEach(registerHarness)

  it('refuses binding a private-space conversation', async () => {
    const space = db.spaces.create({ name: 'S' })
    const hidden = db.conversations.create({ mode: 'chat', spaceId: space.id })

    const result = await invoke(CHANNELS.imSetTelegram, {
      conversationId: hidden.id,
      enabled: true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('private space')
    expect(telegramBinds).toHaveLength(0)
  })

  it('still binds a default-space conversation', async () => {
    const open = db.conversations.create({ mode: 'chat' })
    const result = await invoke(CHANNELS.imSetTelegram, {
      conversationId: open.id,
      enabled: true,
    })
    expect(result.ok).toBe(true)
    expect(telegramBinds).toHaveLength(1)
  })
})

// -- surface 5: desktop notifications ----------------------------------------

describe('titleOnlyForPrivateSpace', () => {
  it('blanks the body only when private', () => {
    const notification = { kind: 'result' as const, title: 'Agent finished', body: 'the secret' }
    expect(titleOnlyForPrivateSpace(notification, true)).toEqual({
      kind: 'result',
      title: 'Agent finished',
      body: '',
    })
    expect(titleOnlyForPrivateSpace(notification, false)).toBe(notification)
  })
})

// -- surface 6: the agent inbox ----------------------------------------------

describe('buildInboxItems private blanking', () => {
  const run = (conversationId: string | null): AgentRun => ({
    id: 'run-1',
    conversationId,
    projectId: null,
    agentName: 'Research bot',
    task: 'summarize the secret plan',
    status: 'done',
    result: 'the secret result',
    worktreePath: null,
    providerId: null,
    modelId: null,
    startedAt: 1,
    finishedAt: 2,
  })

  const sources = (agentRun: AgentRun) => ({
    agentRuns: [agentRun],
    workflowRuns: [],
    scheduledTasks: [],
  })

  it('blanks title and snippet for a private-space agent run', () => {
    const [item] = buildInboxItems(sources(run('hidden')), new Map(), new Set(['hidden']))
    expect(item.title).toBe('Research bot')
    expect(item.snippet).toBe('')
    expect(JSON.stringify(item)).not.toContain('secret')
  })

  it('leaves default-space runs (and runs with no conversation) untouched', () => {
    const [open] = buildInboxItems(sources(run('open')), new Map(), new Set(['hidden']))
    expect(open.title).toContain('secret plan')
    expect(open.snippet).toContain('secret result')
    const [detached] = buildInboxItems(sources(run(null)), new Map(), new Set(['hidden']))
    expect(detached.title).toContain('secret plan')
  })
})

// -- provider allowlist enforced at generation time ---------------------------

class StubAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  async chat(_req: AdapterChatRequest): Promise<AdapterChatResult> {
    return { text: 'ok', toolCalls: [], finishReason: 'stop' }
  }
  async *chatStream(
    _req: AdapterChatRequest,
    _ctx: AdapterContext
  ): AsyncGenerator<AdapterStreamEvent> {
    yield { type: 'text', text: 'answer' }
    yield { type: 'finish', reason: 'stop' }
  }
  async listModels(): Promise<ModelInfo[]> {
    return []
  }
  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'ok' }
  }
}

describe('provider allowlist', () => {
  const seedProvider = (label: string): string => {
    const provider = db.providers.create({
      id: randomUUID(),
      type: 'openai-compatible',
      label,
      baseUrl: 'https://fake.example/v1',
      defaultModelId: 'm1',
      enabled: true,
    })
    db.providers.setKeyRow(
      provider.id,
      'insecure:' + Buffer.from('sk-test', 'utf8').toString('base64'),
      'sk-…test'
    )
    return provider.id
  }

  const makeService = (): { service: ChatService; done: Promise<StreamEventEnvelope> } => {
    let resolveDone: (env: StreamEventEnvelope) => void = () => undefined
    const done = new Promise<StreamEventEnvelope>((resolve) => {
      resolveDone = resolve
    })
    const service = new ChatService(
      db,
      (channel, payload) => {
        if (channel !== CHANNELS.streamEvent) return
        const envelope = payload as StreamEventEnvelope
        if (envelope.event.type === 'done' || envelope.event.type === 'error') {
          resolveDone(envelope)
        }
      },
      { resolveAdapter: () => new StubAdapter() }
    )
    return { service, done }
  }

  it('refuses a provider outside the space allowlist, naming the space', async () => {
    const allowed = seedProvider('Allowed')
    const blocked = seedProvider('Blocked')
    const space = db.spaces.create({ name: 'Vault', providerAllowlist: [allowed] })
    const conversation = db.conversations.create({
      mode: 'chat',
      spaceId: space.id,
      providerId: blocked,
      modelId: 'm1',
    })

    const { service } = makeService()
    await expect(
      service.send({ conversationId: conversation.id, content: 'hi' })
    ).rejects.toThrow(/Vault.*does not allow.*Blocked/)
    // Nothing was persisted: the gate fires before the user message insert.
    expect(db.messages.listByConversation(conversation.id)).toHaveLength(0)
  })

  it('allows an allowlisted provider and a null allowlist', async () => {
    const allowed = seedProvider('Allowed')
    const space = db.spaces.create({ name: 'Vault', providerAllowlist: [allowed] })
    const conversation = db.conversations.create({
      mode: 'chat',
      spaceId: space.id,
      providerId: allowed,
      modelId: 'm1',
    })
    const { service, done } = makeService()
    await service.send({ conversationId: conversation.id, content: 'hi' })
    expect((await done).event.type).toBe('done')

    const openSpace = db.spaces.create({ name: 'Open' })
    const anyProvider = seedProvider('Any')
    const conversation2 = db.conversations.create({
      mode: 'chat',
      spaceId: openSpace.id,
      providerId: anyProvider,
      modelId: 'm1',
    })
    const second = makeService()
    await second.service.send({ conversationId: conversation2.id, content: 'hi' })
    expect((await second.done).event.type).toBe('done')
  })

  it('is indifferent to spaces for default-space conversations', async () => {
    const provider = seedProvider('Solo')
    const conversation = db.conversations.create({
      mode: 'chat',
      providerId: provider,
      modelId: 'm1',
    })
    const { service, done } = makeService()
    await service.send({ conversationId: conversation.id, content: 'hi' })
    expect((await done).event.type).toBe('done')
  })
})
