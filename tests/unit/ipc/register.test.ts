/**
 * IPC boundary tests: the handlers in src/main/ipc/register.ts, driven through
 * a mocked ipcMain against a real temp SQLite database. Electron is stubbed
 * (register.ts is the only module in this import graph that touches it).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHANNELS, type ChannelName, type IpcResult } from '@shared/ipc'
import { DEFAULT_SETTINGS, type Message, type MoaPreset } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import { registerIpc, type RegisterIpcDeps } from '../../../src/main/ipc/register'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

const handlers = new Map<string, Handler>()
/** What the mocked open dialog returns (empty = the user cancelled). */
let picked: string[] = []

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => tmpdir() },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {
    showOpenDialog: async () => ({ canceled: picked.length === 0, filePaths: picked }),
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
let webhookCalls: (string | null)[]

/** Invokes a registered handler the way ipcMain would, returning its IpcResult. */
async function invoke<T>(channel: ChannelName, ...args: unknown[]): Promise<IpcResult<T>> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler registered for ${channel}`)
  return (await handler(null, ...args)) as IpcResult<T>
}

function createProvider(label: string): string {
  const id = randomUUID()
  db.providers.create({
    id,
    type: 'openai',
    label,
    baseUrl: 'https://api.openai.com/v1',
    defaultModelId: 'gpt-5.5',
  })
  return id
}

beforeEach(() => {
  handlers.clear()
  webhookCalls = []
  picked = []
  dir = mkdtempSync(join(tmpdir(), 'uld-ipc-'))
  db = openDatabase(join(dir, 'app.db'))
  const imBridgeManager = {
    setWebhook: (url: string | null) => {
      webhookCalls.push(url)
      db.settings.update({ outboundWebhookUrl: url && url.trim() ? url.trim() : null })
      return { telegramEnabled: false, telegramConnected: false, telegramConversationId: null, webhookUrl: url }
    },
  }
  registerIpc({
    db,
    chatService: { stopConversation: () => undefined },
    imBridgeManager,
    workspaceRoots: { withAutoFlag: (p: unknown) => p, deleteIfAutoRegistered: () => undefined },
    getWindows: () => [],
  } as unknown as RegisterIpcDeps)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('providers:delete', () => {
  const moaPreset = (providerId: string, otherId: string): MoaPreset => ({
    id: 'moa-1',
    name: 'Panel',
    referenceModels: [
      { providerId, modelId: 'gpt-5.5' },
      { providerId: otherId, modelId: 'gpt-4o' },
    ],
    aggregator: { providerId: otherId, modelId: 'gpt-4o' },
    enabled: true,
  })

  it('deletes the DEFAULT provider (a settings write inside the handler transaction)', async () => {
    const providerId = createProvider('Main')
    db.settings.update({ defaultProviderId: providerId, defaultModelId: 'gpt-5.5' })

    const result = await invoke(CHANNELS.providersDelete, providerId)

    expect(result.ok).toBe(true)
    expect(db.providers.getById(providerId)).toBeNull()
    expect(db.settings.get().defaultProviderId).toBeNull()
    expect(db.settings.get().defaultModelId).toBeNull()
  })

  it('clears every settings reference to the deleted provider', async () => {
    const providerId = createProvider('Main')
    const otherId = createProvider('Other')
    db.settings.update({
      perModeModelsEnabled: true,
      modeModels: {
        chat: { providerId, modelId: 'gpt-5.5' },
        work: { providerId: otherId, modelId: 'gpt-4o' },
      },
      researchWorkerProviderId: providerId,
      researchWorkerModelId: 'gpt-5.5',
      defaultImageProviderId: providerId,
      defaultImageModelId: 'gpt-image-2',
      moaPresets: [moaPreset(providerId, otherId)],
    })

    expect((await invoke(CHANNELS.providersDelete, providerId)).ok).toBe(true)

    const settings = db.settings.get()
    expect(settings.modeModels.chat).toEqual({ providerId: null, modelId: null })
    // Another provider's mode default is untouched.
    expect(settings.modeModels.work).toEqual({ providerId: otherId, modelId: 'gpt-4o' })
    expect(settings.researchWorkerProviderId).toBeNull()
    expect(settings.researchWorkerModelId).toBeNull()
    expect(settings.defaultImageProviderId).toBeNull()
    expect(settings.defaultImageModelId).toBeNull()
    // The preset loses its dead advisor and is disabled, never left dangling.
    expect(settings.moaPresets[0].referenceModels).toEqual([
      { providerId: otherId, modelId: 'gpt-4o' },
    ])
    expect(settings.moaPresets[0].enabled).toBe(false)
  })

  it('leaves settings alone when the deleted provider is referenced nowhere', async () => {
    const providerId = createProvider('Main')
    const otherId = createProvider('Other')
    db.settings.update({ defaultProviderId: otherId, moaPresets: [moaPreset(otherId, otherId)] })

    expect((await invoke(CHANNELS.providersDelete, providerId)).ok).toBe(true)

    const settings = db.settings.get()
    expect(settings.defaultProviderId).toBe(otherId)
    expect(settings.moaPresets[0].enabled).toBe(true)
    expect(settings.moaPresets[0].referenceModels).toHaveLength(2)
  })
})

describe('providers:create', () => {
  // ProviderConfigInput.presetId is `string | null`, so a caller spreading a
  // ProviderConfig row must not be rejected at runtime.
  it('accepts an explicit null presetId', async () => {
    const result = await invoke<{ id: string; type: string }>(CHANNELS.providersCreate, {
      type: 'openai',
      label: 'Main',
      presetId: null,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.type).toBe('openai')
    expect(db.providers.getById(result.data.id)?.presetId).toBeNull()
  })
})

describe('conv:fork', () => {
  const seed = (): string => {
    const conversation = db.conversations.create({ mode: 'chat', title: 'Source' })
    for (let seq = 1; seq <= 3; seq += 1) {
      const message: Message = {
        id: randomUUID(),
        conversationId: conversation.id,
        role: seq % 2 === 1 ? 'user' : 'assistant',
        content: `m${seq}`,
        seq,
        status: 'complete',
        createdAt: Date.now(),
      }
      db.messages.insert(message)
    }
    return conversation.id
  }

  it('copies the transcript into the fork', async () => {
    const sourceId = seed()
    const result = await invoke<{ id: string }>(CHANNELS.convFork, { id: sourceId })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(db.messages.listByConversation(result.data.id).map((m) => m.content)).toEqual([
      'm1',
      'm2',
      'm3',
    ])
  })

  it('strips usage from copied rows so budget aggregates never double-count (v44)', async () => {
    const sourceId = seed()
    const assistant = db.messages.listByConversation(sourceId).find((m) => m.role === 'assistant')!
    db.messages.update(assistant.id, {
      usage: { promptTokens: 100, completionTokens: 50 },
      providerId: 'p1',
      modelId: 'm-priced',
    })
    const rowsBefore = db.messages.usageSince(0).length
    expect(rowsBefore).toBe(1)

    const result = await invoke<{ id: string }>(CHANNELS.convFork, { id: sourceId })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Cost attribution stays with the source: no copied row carries usage,
    // so globalMonthSpend / the fork's HUD see nothing new.
    const copied = db.messages.listByConversation(result.data.id)
    expect(copied.every((m) => m.usage === undefined)).toBe(true)
    expect(db.messages.usageSince(0).length).toBe(rowsBefore)
    expect(db.messages.usageForConversationSince(result.data.id, 0)).toEqual([])
  })

  it('keeps the knowledge-base attachment of the source conversation', async () => {
    const kb = db.knowledge.create({ name: 'Docs', providerId: 'p', modelId: 'e' })
    const sourceId = seed()
    db.conversations.update(sourceId, { knowledgeBaseId: kb.id })

    const result = await invoke<{ id: string }>(CHANNELS.convFork, { id: sourceId })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(db.conversations.getById(result.data.id)?.knowledgeBaseId).toBe(kb.id)
  })

  it('rolls the fork back when a message copy fails (no truncated fork survives)', async () => {
    const sourceId = seed()
    const insert = db.messages.insert
    let copied = 0
    vi.spyOn(db.messages, 'insert').mockImplementation((message) => {
      copied += 1
      if (copied === 2) throw new Error('disk full')
      insert(message)
    })

    const result = await invoke(CHANNELS.convFork, { id: sourceId })

    expect(result.ok).toBe(false)
    expect(db.conversations.list().map((c) => c.id)).toEqual([sourceId])
  })

  it('forks at a mid-transcript message: prefix only, original seqs, fresh ids, provenance', async () => {
    const sourceId = seed()
    const source = db.messages.listByConversation(sourceId)
    const target = source.find((m) => m.seq === 2)!

    const result = await invoke<{ id: string }>(CHANNELS.convFork, {
      id: sourceId,
      messageId: target.id,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const copied = db.messages.listByConversation(result.data.id)
    expect(copied.map((m) => [m.seq, m.content])).toEqual([
      [1, 'm1'],
      [2, 'm2'],
    ])
    const sourceIds = new Set(source.map((m) => m.id))
    expect(copied.every((m) => !sourceIds.has(m.id))).toBe(true)

    const fork = db.conversations.getById(result.data.id)!
    expect(fork.title).toBe('Source (fork)')
    expect(fork.parentConversationId).toBe(sourceId)
    expect(fork.forkedAtMessageId).toBe(target.id)
  })

  it('records the last message as the fork point when messageId is omitted', async () => {
    const sourceId = seed()
    const last = db.messages.listByConversation(sourceId).find((m) => m.seq === 3)!

    const result = await invoke<{ id: string }>(CHANNELS.convFork, { id: sourceId })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(db.conversations.getById(result.data.id)?.forkedAtMessageId).toBe(last.id)
  })

  it("rejects a messageId from a different conversation (no fork row survives)", async () => {
    const sourceId = seed()
    const other = db.conversations.create({ mode: 'chat', title: 'Other' })
    const foreign: Message = {
      id: randomUUID(),
      conversationId: other.id,
      role: 'user',
      content: 'elsewhere',
      seq: 1,
      status: 'complete',
      createdAt: Date.now(),
    }
    db.messages.insert(foreign)

    const result = await invoke(CHANNELS.convFork, { id: sourceId, messageId: foreign.id })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_request')
    expect(db.conversations.list().map((c) => c.id).sort()).toEqual([sourceId, other.id].sort())
  })

  it('copies the source params onto the fork', async () => {
    const sourceId = seed()
    db.conversations.update(sourceId, { params: { temperature: 0.2 } })

    const result = await invoke<{ id: string; params: { temperature?: number } }>(
      CHANNELS.convFork,
      { id: sourceId }
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.params.temperature).toBe(0.2)
    expect(db.conversations.getById(result.data.id)?.params.temperature).toBe(0.2)
  })

  it('keeps the compaction summary when forking at/after the compaction point', async () => {
    const sourceId = seed()
    db.conversations.setSummary(sourceId, 'sum', 2)
    const target = db.messages.listByConversation(sourceId).find((m) => m.seq === 3)!

    const result = await invoke<{ id: string }>(CHANNELS.convFork, {
      id: sourceId,
      messageId: target.id,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(db.conversations.getById(result.data.id)).toMatchObject({
      summaryText: 'sum',
      summaryThroughSeq: 2,
    })
  })

  it('drops the compaction summary when forking before the compaction point', async () => {
    const sourceId = seed()
    db.conversations.setSummary(sourceId, 'sum', 2)
    const target = db.messages.listByConversation(sourceId).find((m) => m.seq === 1)!

    const result = await invoke<{ id: string }>(CHANNELS.convFork, {
      id: sourceId,
      messageId: target.id,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(db.conversations.getById(result.data.id)).toMatchObject({
      summaryText: null,
      summaryThroughSeq: null,
    })
  })

  it("copies a 'streaming' source message as 'stopped' (a copy can never resume)", async () => {
    const sourceId = seed()
    const streaming: Message = {
      id: randomUUID(),
      conversationId: sourceId,
      role: 'assistant',
      content: 'partial',
      seq: 4,
      status: 'streaming',
      createdAt: Date.now(),
    }
    db.messages.insert(streaming)

    const result = await invoke<{ id: string }>(CHANNELS.convFork, { id: sourceId })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const copy = db.messages.listByConversation(result.data.id).find((m) => m.seq === 4)!
    expect(copy.status).toBe('stopped')
  })

  it('shares attachment storage instead of duplicating files (same storageKey)', async () => {
    const sourceId = seed()
    const withImage: Message = {
      id: randomUUID(),
      conversationId: sourceId,
      role: 'user',
      content: 'look',
      seq: 4,
      status: 'complete',
      createdAt: Date.now(),
      attachments: [
        { id: 'a1', name: 'pic.png', mimeType: 'image/png', sizeBytes: 12, kind: 'image', storageKey: 'k.png' },
      ],
    }
    db.messages.insert(withImage)

    const result = await invoke<{ id: string }>(CHANNELS.convFork, { id: sourceId })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const copy = db.messages.listByConversation(result.data.id).find((m) => m.seq === 4)!
    expect(copy.attachments?.[0].storageKey).toBe('k.png')
  })
})

describe('conv:forkLineage', () => {
  it('resolves parent and sibling forks; the source itself has neither', async () => {
    const source = db.conversations.create({ mode: 'chat', title: 'Source' })
    const forkA = await invoke<{ id: string }>(CHANNELS.convFork, { id: source.id })
    const forkB = await invoke<{ id: string }>(CHANNELS.convFork, { id: source.id })
    expect(forkA.ok && forkB.ok).toBe(true)
    if (!forkA.ok || !forkB.ok) return

    const lineageA = await invoke<{ parent: unknown; siblings: Array<{ id: string }> }>(
      CHANNELS.convForkLineage,
      forkA.data.id
    )
    expect(lineageA.ok).toBe(true)
    if (!lineageA.ok) return
    expect(lineageA.data.parent).toEqual({ id: source.id, title: 'Source' })
    expect(lineageA.data.siblings.map((s) => s.id)).toEqual([forkB.data.id])

    const sourceLineage = await invoke<{ parent: unknown; siblings: unknown[] }>(
      CHANNELS.convForkLineage,
      source.id
    )
    expect(sourceLineage.ok).toBe(true)
    if (!sourceLineage.ok) return
    expect(sourceLineage.data).toEqual({ parent: null, siblings: [] })
  })

  it('survives a deleted parent: parent null, siblings still listed', async () => {
    const source = db.conversations.create({ mode: 'chat', title: 'Source' })
    const forkA = await invoke<{ id: string }>(CHANNELS.convFork, { id: source.id })
    const forkB = await invoke<{ id: string }>(CHANNELS.convFork, { id: source.id })
    expect(forkA.ok && forkB.ok).toBe(true)
    if (!forkA.ok || !forkB.ok) return

    expect((await invoke(CHANNELS.convDelete, source.id)).ok).toBe(true)

    const lineage = await invoke<{ parent: unknown; siblings: Array<{ id: string }> }>(
      CHANNELS.convForkLineage,
      forkA.data.id
    )
    expect(lineage.ok).toBe(true)
    if (!lineage.ok) return
    expect(lineage.data.parent).toBeNull()
    expect(lineage.data.siblings.map((s) => s.id)).toEqual([forkB.data.id])
  })
})

describe('im:setWebhook', () => {
  it('rejects a URL that delivery would silently drop', async () => {
    for (const url of ['example.com/hook', 'http://192.168.1.10:9000/hook', 'htp://x.dev', 'x'.repeat(2001)]) {
      const result = await invoke(CHANNELS.imSetWebhook, url)
      expect(result.ok, url).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('invalid_request')
    }
    expect(webhookCalls).toEqual([])
    expect(db.settings.get().outboundWebhookUrl).toBeNull()
  })

  it('accepts https, loopback http, and null (clear)', async () => {
    expect((await invoke(CHANNELS.imSetWebhook, 'https://example.com/hook')).ok).toBe(true)
    expect((await invoke(CHANNELS.imSetWebhook, 'http://localhost:9000/hook')).ok).toBe(true)
    expect((await invoke(CHANNELS.imSetWebhook, null)).ok).toBe(true)
    expect(webhookCalls).toEqual(['https://example.com/hook', 'http://localhost:9000/hook', null])
  })
})

describe('workflows:create', () => {
  const graph = { nodes: [], edges: [] }

  it('caps the workflow name like every other handler input', async () => {
    const result = await invoke(CHANNELS.workflowsCreate, { name: 'w'.repeat(201), graph })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_request')
    expect(db.workflows.list()).toHaveLength(0)
  })

  it('still saves a normal workflow (and clamps its interval)', async () => {
    const result = await invoke(CHANNELS.workflowsCreate, {
      name: '  Nightly  ',
      graph,
      schedule: { everyMinutes: 10 ** 6 },
      scheduleEnabled: true,
    })
    expect(result.ok).toBe(true)
    const [saved] = db.workflows.list()
    expect(saved.name).toBe('Nightly')
    expect(saved.schedule).toEqual({ kind: 'interval', everyMinutes: 7 * 24 * 60 })
  })
})

describe('code:checkpoints:list', () => {
  it('returns metadata + file paths, never the file snapshots', async () => {
    const conversation = db.conversations.create({ mode: 'work', title: 'Task' })
    const project = db.code.projectUpsertByPath(join(dir, 'proj'), 'proj')
    db.agentPlatform.checkpointCreate({
      conversationId: conversation.id,
      projectId: project.id,
      changeId: null,
      label: 'Before edit',
      messageSeq: 1,
      files: [{ relPath: 'src/a.ts', content: 'secret contents' }],
    })

    const result = await invoke<Array<Record<string, unknown>>>(
      CHANNELS.codeCheckpointsList,
      conversation.id
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toHaveLength(1)
    expect(result.data[0].filePaths).toEqual(['src/a.ts'])
    expect(result.data[0].files).toBeUndefined()
    expect(JSON.stringify(result.data)).not.toContain('secret contents')
  })
})

describe('agents:pack:import', () => {
  it('reports a non-JSON file as invalid input, not a raw parser error', async () => {
    const file = join(dir, 'not-a-pack.json')
    writeFileSync(file, 'this is not json')
    picked = [file]

    const result = await invoke(CHANNELS.agentPackImport)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('invalid_request')
    expect(result.error.message).toBe('The selected file is not valid JSON.')
  })

  it('imports a valid pack', async () => {
    const file = join(dir, 'pack.json')
    writeFileSync(
      file,
      JSON.stringify({
        format: 'grasberg-agent-pack',
        version: 1,
        agents: [{ name: 'Reviewer', systemPrompt: 'Review code.' }],
        skills: [],
        hooks: [],
      })
    )
    picked = [file]

    const result = await invoke(CHANNELS.agentPackImport)

    expect(result.ok).toBe(true)
    expect(db.agents.getByName('Reviewer')).not.toBeNull()
  })
})

describe('settings:update', () => {
  it('rejects an outbound webhook URL that could never fire', async () => {
    const bad = await invoke(CHANNELS.settingsUpdate, { outboundWebhookUrl: 'http://example.com/hook' })
    expect(bad.ok).toBe(false)
    const good = await invoke(CHANNELS.settingsUpdate, { outboundWebhookUrl: 'https://example.com/hook' })
    expect(good.ok).toBe(true)
    expect(db.settings.get().outboundWebhookUrl).toBe('https://example.com/hook')
    expect(DEFAULT_SETTINGS.outboundWebhookUrl).toBeNull()
  })

  it('never lets a renderer choose the trigger endpoint token', async () => {
    const chosen = await invoke(CHANNELS.settingsUpdate, { workflowWebhookToken: 'aaaaaaaa' })
    expect(chosen.ok).toBe(false)
    expect(db.settings.get().workflowWebhookToken).toBeNull()
    // …including in the same payload that switches the endpoint on, which is
    // the ordering that would otherwise skip the mint.
    const smuggled = await invoke(CHANNELS.settingsUpdate, {
      workflowWebhookEnabled: true,
      workflowWebhookToken: 'aaaaaaaa',
    })
    expect(smuggled.ok).toBe(false)
    expect(db.settings.get().workflowWebhookEnabled).toBe(false)
    expect(db.settings.get().workflowWebhookToken).toBeNull()
  })

  it('mints a token when the trigger endpoint is switched on, and keeps it after', async () => {
    const on = await invoke(CHANNELS.settingsUpdate, { workflowWebhookEnabled: true })
    expect(on.ok).toBe(true)
    const minted = db.settings.get().workflowWebhookToken
    expect(minted).toMatch(/^[0-9a-f]{32}$/)

    // A later unrelated write must not rotate it: every URL already handed out
    // would stop working.
    const again = await invoke(CHANNELS.settingsUpdate, { workflowWebhookPort: 9100 })
    expect(again.ok).toBe(true)
    expect(db.settings.get().workflowWebhookToken).toBe(minted)
  })
})

describe('activity:list', () => {
  /** The page shape the Activity tab reads, as it crosses IPC. */
  interface ActivityPageResult {
    entries: Array<{ at: number; detail: string }>
    cursor: { at: number; seq: number } | null
    total: number
  }

  /** One log row. `at` is explicit so the newest-first order is deterministic. */
  const record = (at: number, detail: string): void => {
    db.activity.record({
      at,
      conversationId: null,
      agentName: null,
      toolId: 'file_search',
      toolName: 'file_search',
      risk: 'safe',
      decision: 'auto',
      detail,
      arguments: '',
      result: '',
      changeId: null,
    })
  }

  const BASE = 1_700_000_000_000

  it('answers a first page with a cursor to continue from and the untruncated total', async () => {
    for (let i = 0; i < 5; i++) record(BASE + i, `e-${i}`)

    const result = await invoke<ActivityPageResult>(CHANNELS.activityList, { limit: 2 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.entries.map((e) => e.detail)).toEqual(['e-4', 'e-3'])
    // "Showing N of M": the total counts the whole log, not the page.
    expect(result.data.total).toBe(5)
    // Both halves of the cursor cross the boundary. A page that came back with
    // only a timestamp could not resume inside a millisecond several calls share.
    expect(result.data.cursor).toEqual({ at: BASE + 3, seq: expect.any(Number) })
  })

  it('pages with the cursor it handed back, dropping and duplicating nothing', async () => {
    // Every entry in the same millisecond: two cheap tool calls land there
    // routinely, and it is exactly where a clock-only cursor goes wrong.
    const written = 7
    for (let i = 0; i < written; i++) record(BASE, `same-${i}`)

    const seen: string[] = []
    let before: { at: number; seq: number } | undefined
    // Bounded: a cursor that never advances must fail the assertions below
    // rather than spin here.
    for (let page = 0; page <= written; page++) {
      const result = await invoke<ActivityPageResult>(CHANNELS.activityList, {
        limit: 3,
        ...(before ? { before } : {}),
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // The total is of the log, so it does not shrink as pages are consumed.
      expect(result.data.total).toBe(written)
      seen.push(...result.data.entries.map((e) => e.detail))
      if (result.data.cursor === null) break
      before = result.data.cursor
    }

    // Newest first, which within one millisecond means newest-inserted first.
    expect(seen).toEqual(['same-6', 'same-5', 'same-4', 'same-3', 'same-2', 'same-1', 'same-0'])
    expect(new Set(seen).size).toBe(written)
  })

  it('rejects a malformed cursor rather than silently restarting at page one', async () => {
    for (let i = 0; i < 3; i++) record(BASE + i, `e-${i}`)

    const malformed: unknown[] = [
      // A bare timestamp — the shape the cursor used to be. Honouring it would
      // skip every entry sharing the boundary millisecond.
      BASE + 2,
      { at: BASE + 2 },
      { seq: 2 },
      // Strict: nothing rides along beside the two halves of the cursor.
      { at: BASE + 2, seq: 2, extra: 1 },
      { at: 0, seq: 0 },
      { at: `${BASE + 2}`, seq: '2' },
      // "End of log" is not "start over".
      null,
    ]

    for (const before of malformed) {
      const result = await invoke<ActivityPageResult>(CHANNELS.activityList, {
        limit: 2,
        before,
      })
      // The alternative — ignoring the cursor and serving page one again — is
      // an endless "Load older" that never leaves the newest entries.
      expect(result.ok, JSON.stringify(before)).toBe(false)
      if (result.ok) continue
      expect(result.error.code).toBe('invalid_request')
    }
  })
})

describe('documents (notebooks)', () => {
  it('creates and rejects an extra key (strict schema)', async () => {
    const created = await invoke<{ id: string; title: string }>(CHANNELS.documentsCreate, {
      title: 'Plan',
      content: 'v1',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.title).toBe('Plan')
    expect(db.documents.getById(created.data.id)?.content).toBe('v1')

    const rejected = await invoke(CHANNELS.documentsCreate, { title: 'X', extra: 1 })
    expect(rejected.ok).toBe(false)
  })

  it('update and revert on missing targets return ok:false', async () => {
    const update = await invoke(CHANNELS.documentsUpdate, 'ghost', { content: 'x' })
    expect(update.ok).toBe(false)

    const doc = db.documents.create({ title: 'Note', content: 'v1' })
    const revert = await invoke(CHANNELS.documentsRevert, { id: doc.id, versionId: 999 })
    expect(revert.ok).toBe(false)
  })

  it('listVersions reflects an update made through the update handler', async () => {
    const doc = db.documents.create({ title: 'Note', content: 'v1' })
    expect((await invoke(CHANNELS.documentsUpdate, doc.id, { content: 'v2' })).ok).toBe(true)

    const versions = await invoke<Array<{ contentLength: number; content?: string }>>(
      CHANNELS.documentsListVersions,
      doc.id
    )
    expect(versions.ok).toBe(true)
    if (!versions.ok) return
    // Summary shape over IPC: the length of 'v1', never the content itself.
    expect(versions.data.map((v) => v.contentLength)).toEqual(['v1'.length])
    expect(versions.data.every((v) => v.content === undefined)).toBe(true)
  })

  it('export returns canceled under the mocked save dialog; delete removes the doc', async () => {
    const doc = db.documents.create({ title: 'Note', content: 'v1' })
    const exported = await invoke<{ canceled: boolean }>(CHANNELS.documentsExport, doc.id)
    expect(exported.ok).toBe(true)
    if (exported.ok) expect(exported.data.canceled).toBe(true)

    expect((await invoke(CHANNELS.documentsDelete, doc.id)).ok).toBe(true)
    expect(db.documents.getById(doc.id)).toBeNull()
  })
})
