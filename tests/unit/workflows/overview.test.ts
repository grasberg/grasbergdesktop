/**
 * Overview repo queries over a real temp db: latest run per workflow (the
 * scheduled section's status source), cross-workflow recent runs with names,
 * SQL-level snippet truncation, and FK cascade cleanup. Plus the patch
 * semantics of workflows:update, driven through the IPC handler itself.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHANNELS, type ChannelName, type IpcResult } from '@shared/ipc'
import type { Workflow, WorkflowGraph, WorkflowRun } from '@shared/types'
import { WORKFLOW_RUN_SNIPPET_MAX } from '@shared/workflow-status'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import { registerIpc, type RegisterIpcDeps } from '../../../src/main/ipc/register'

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-wf-overview-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const EMPTY_GRAPH = { nodes: [], edges: [] }

/**
 * A graph with actual content. An empty graph cannot tell "kept" from "reset",
 * which is exactly where a patch that always rewrites `graph_json` would hide.
 */
const SAMPLE_GRAPH: WorkflowGraph = {
  nodes: [
    {
      id: 'n1',
      kind: 'manual',
      label: 'Start',
      position: { x: 10, y: 20 },
      config: { note: 'keep me' },
    },
    {
      id: 'n2',
      kind: 'output',
      label: 'Result',
      position: { x: 240, y: 20 },
      config: {},
    },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
}

/** The raw stored column, so "unchanged" means byte-identical, not merely equivalent. */
function storedGraphJson(id: string): string | undefined {
  return db.driver.get<{ graph_json: string }>('SELECT graph_json FROM workflows WHERE id = ?', [
    id,
  ])?.graph_json
}

function makeWorkflow(name: string): Workflow {
  return db.workflows.create({ name, graph: EMPTY_GRAPH })
}

function addRun(
  workflowId: string,
  startedAt: number,
  overrides: Partial<Pick<WorkflowRun, 'status' | 'output' | 'error' | 'trigger'>> = {}
): WorkflowRun {
  return db.workflows.insertRun({
    workflowId,
    trigger: overrides.trigger ?? 'manual',
    status: overrides.status ?? 'ok',
    output: overrides.output ?? `out@${startedAt}`,
    error: overrides.error ?? null,
    startedAt,
    finishedAt: startedAt + 1000,
  })
}

describe('latestRunsPerWorkflow', () => {
  it('returns exactly the newest run of each workflow with runs', () => {
    const a = makeWorkflow('A')
    const b = makeWorkflow('B')
    makeWorkflow('NeverRan')
    addRun(a.id, 1000)
    addRun(a.id, 3000, { status: 'error', error: 'boom' })
    addRun(b.id, 2000)

    const latest = db.workflows.latestRunsPerWorkflow()
    expect(latest).toHaveLength(2)
    const byWorkflow = new Map(latest.map((r) => [r.workflowId, r]))
    expect(byWorkflow.get(a.id)).toMatchObject({ startedAt: 3000, status: 'error' })
    expect(byWorkflow.get(b.id)).toMatchObject({ startedAt: 2000, status: 'ok' })
  })

  it('truncates output and error at the snippet cap', () => {
    const wf = makeWorkflow('Long')
    const long = 'x'.repeat(WORKFLOW_RUN_SNIPPET_MAX + 200)
    addRun(wf.id, 1000, { status: 'error', output: long, error: long })

    const [latest] = db.workflows.latestRunsPerWorkflow()
    expect(latest.output).toHaveLength(WORKFLOW_RUN_SNIPPET_MAX)
    expect(latest.error).toHaveLength(WORKFLOW_RUN_SNIPPET_MAX)
  })
})

describe('listRecentRunsWithNames', () => {
  it('interleaves runs across workflows newest first with the right names', () => {
    const a = makeWorkflow('Alpha')
    const b = makeWorkflow('Beta')
    addRun(a.id, 1000)
    addRun(b.id, 2000)
    addRun(a.id, 3000)

    const recent = db.workflows.listRecentRunsWithNames()
    expect(recent.map((r) => [r.workflowName, r.startedAt])).toEqual([
      ['Alpha', 3000],
      ['Beta', 2000],
      ['Alpha', 1000],
    ])
  })

  it('respects and clamps the limit', () => {
    const wf = makeWorkflow('W')
    for (let i = 0; i < 5; i++) addRun(wf.id, 1000 + i)
    expect(db.workflows.listRecentRunsWithNames(2)).toHaveLength(2)
    expect(db.workflows.listRecentRunsWithNames(0)).toHaveLength(1) // floor 1
    expect(db.workflows.listRecentRunsWithNames(10_000)).toHaveLength(5) // cap tolerated
  })

  it('truncates long output at the snippet cap', () => {
    const wf = makeWorkflow('W')
    addRun(wf.id, 1000, { output: 'y'.repeat(WORKFLOW_RUN_SNIPPET_MAX + 50) })
    const [run] = db.workflows.listRecentRunsWithNames()
    expect(run.output).toHaveLength(WORKFLOW_RUN_SNIPPET_MAX)
  })

  it('deleting a workflow cascades its runs out of both queries', () => {
    const keep = makeWorkflow('Keep')
    const drop = makeWorkflow('Drop')
    addRun(keep.id, 1000)
    addRun(drop.id, 2000)

    db.workflows.remove(drop.id)

    expect(db.workflows.listRecentRunsWithNames().map((r) => r.workflowId)).toEqual([keep.id])
    expect(db.workflows.latestRunsPerWorkflow().map((r) => r.workflowId)).toEqual([keep.id])
  })
})

// update is a PATCH: an absent field keeps its stored value, so no caller can
// silently revoke a workflow's trigger opt-in (or its schedule) by omission;
// only an explicit null/false clears.
describe('workflows update patch semantics', () => {
  const EVERY_HOUR = { kind: 'interval' as const, everyMinutes: 60 }

  const triggered = (): Workflow =>
    db.workflows.create({
      name: 'Triggered',
      graph: EMPTY_GRAPH,
      schedule: EVERY_HOUR,
      scheduleEnabled: true,
      webhookEnabled: true,
    })

  /** Same, but carrying a real node graph — the column with the most to lose. */
  const withGraph = (): Workflow =>
    db.workflows.create({
      name: 'Digest',
      graph: SAMPLE_GRAPH,
      schedule: EVERY_HOUR,
      scheduleEnabled: true,
      webhookEnabled: true,
    })

  describe('repository', () => {
    it('keeps an omitted webhookEnabled, clears an explicit false', () => {
      const wf = triggered()
      db.workflows.update(wf.id, { name: 'Renamed' })
      expect(db.workflows.getById(wf.id)).toMatchObject({
        name: 'Renamed',
        webhookEnabled: true,
      })

      db.workflows.update(wf.id, { webhookEnabled: false })
      expect(db.workflows.getById(wf.id)?.webhookEnabled).toBe(false)
    })

    it('keeps an omitted schedule, clears an explicit null', () => {
      const wf = triggered()
      db.workflows.update(wf.id, { name: 'Renamed' })
      expect(db.workflows.getById(wf.id)?.schedule).toEqual(EVERY_HOUR)

      db.workflows.update(wf.id, { schedule: null })
      expect(db.workflows.getById(wf.id)?.schedule).toBeNull()
    })

    it('keeps an omitted scheduleEnabled, clears an explicit false', () => {
      const wf = triggered()
      db.workflows.update(wf.id, { name: 'Renamed' })
      expect(db.workflows.getById(wf.id)?.scheduleEnabled).toBe(true)

      db.workflows.update(wf.id, { scheduleEnabled: false })
      expect(db.workflows.getById(wf.id)?.scheduleEnabled).toBe(false)
    })

    // The graph is the expensive column: rewriting it on every patch would let
    // "pause this schedule" blank the workflow's entire node graph. The tests
    // above each assert one field and ignore the rest, so this one re-reads the
    // whole row and pins the fields the patch never mentioned.
    it('leaves an omitted graph and name byte-identical', () => {
      const wf = withGraph()
      const before = storedGraphJson(wf.id)
      expect(before).toBe(JSON.stringify(SAMPLE_GRAPH))

      db.workflows.update(wf.id, { scheduleEnabled: false })

      expect(storedGraphJson(wf.id)).toBe(before)
      expect(db.workflows.getById(wf.id)).toMatchObject({
        name: 'Digest',
        graph: SAMPLE_GRAPH,
        scheduleEnabled: false,
        schedule: EVERY_HOUR,
        webhookEnabled: true,
      })
    })

    // The converse, so the guard above can never be satisfied by simply never
    // writing the column: an explicit graph still replaces the stored one, and
    // sending only a graph leaves the name alone.
    it('replaces the stored graph when the patch carries one', () => {
      const wf = withGraph()

      db.workflows.update(wf.id, { graph: EMPTY_GRAPH })
      expect(db.workflows.getById(wf.id)).toMatchObject({ name: 'Digest', graph: EMPTY_GRAPH })

      db.workflows.update(wf.id, { graph: SAMPLE_GRAPH })
      expect(storedGraphJson(wf.id)).toBe(JSON.stringify(SAMPLE_GRAPH))
    })
  })

  describe('through the IPC handler', () => {
    const invoke = async <T>(channel: ChannelName, ...args: unknown[]): Promise<IpcResult<T>> => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`No handler registered for ${channel}`)
      return (await handler(null, ...args)) as IpcResult<T>
    }

    beforeEach(() => {
      handlers.clear()
      registerIpc({
        db,
        chatService: { stopConversation: () => undefined },
        imBridgeManager: { notify: () => undefined },
        workspaceRoots: { withAutoFlag: (p: unknown) => p, deleteIfAutoRegistered: () => undefined },
        getWindows: () => [],
      } as unknown as RegisterIpcDeps)
    })

    it('pausing without webhookEnabled keeps the trigger opt-in and the schedule', async () => {
      const wf = triggered()
      const res = await invoke<Workflow>(CHANNELS.workflowsUpdate, wf.id, {
        name: wf.name,
        graph: wf.graph,
        scheduleEnabled: false,
      })
      expect(res.ok).toBe(true)
      expect(db.workflows.getById(wf.id)).toMatchObject({
        scheduleEnabled: false,
        webhookEnabled: true,
        schedule: EVERY_HOUR,
      })
    })

    it('a pause carrying nothing but the flag keeps the graph and the name', async () => {
      const wf = withGraph()
      const res = await invoke<Workflow>(CHANNELS.workflowsUpdate, wf.id, {
        scheduleEnabled: false,
      })
      expect(res.ok).toBe(true)
      expect(storedGraphJson(wf.id)).toBe(JSON.stringify(SAMPLE_GRAPH))
      expect(db.workflows.getById(wf.id)).toMatchObject({
        name: 'Digest',
        graph: SAMPLE_GRAPH,
        scheduleEnabled: false,
        webhookEnabled: true,
        schedule: EVERY_HOUR,
      })
    })

    it('resuming without a schedule field runs on the stored schedule', async () => {
      const wf = triggered()
      db.workflows.update(wf.id, { scheduleEnabled: false })

      const res = await invoke<Workflow>(CHANNELS.workflowsUpdate, wf.id, {
        name: wf.name,
        graph: wf.graph,
        scheduleEnabled: true,
      })
      expect(res.ok).toBe(true)
      expect(db.workflows.listScheduled().map((w) => w.id)).toEqual([wf.id])
    })

    it('the builder turns the opt-in off and clears the schedule when it sends them', async () => {
      const wf = triggered()
      const res = await invoke<Workflow>(CHANNELS.workflowsUpdate, wf.id, {
        name: wf.name,
        graph: wf.graph,
        schedule: null,
        scheduleEnabled: false,
        webhookEnabled: false,
      })
      expect(res.ok).toBe(true)
      expect(db.workflows.getById(wf.id)).toMatchObject({
        schedule: null,
        scheduleEnabled: false,
        webhookEnabled: false,
      })
    })

    it('still refuses to enable a schedule that can never fire', async () => {
      const wf = triggered()
      const cleared = await invoke(CHANNELS.workflowsUpdate, wf.id, {
        name: wf.name,
        graph: wf.graph,
        schedule: null,
        scheduleEnabled: true,
      })
      expect(cleared.ok).toBe(false)

      const bare = db.workflows.create({ name: 'No schedule', graph: EMPTY_GRAPH })
      const enabled = await invoke(CHANNELS.workflowsUpdate, bare.id, {
        name: bare.name,
        graph: bare.graph,
        scheduleEnabled: true,
      })
      expect(enabled.ok).toBe(false)
      expect(db.workflows.getById(bare.id)?.scheduleEnabled).toBe(false)
    })
  })
})
