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
