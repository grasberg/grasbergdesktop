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
    expect(saved.schedule).toEqual({ everyMinutes: 7 * 24 * 60 })
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
})
