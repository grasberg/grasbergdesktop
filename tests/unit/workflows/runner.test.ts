/**
 * Workflow runner + scheduler over a real temp db: saved-workflow execution
 * persists to workflow_runs (with output picking + pruning), lastRunAt drives
 * the scheduler's due check, and schedules round-trip through the repository.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workflow, WorkflowGraph, WorkflowNode } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import { createWorkflowRunner, pickRunOutput } from '../../../src/main/workflows/runner'
import { WorkflowScheduler, isDue } from '../../../src/main/workflows/scheduler'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-wf-runner-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function node(id: string, kind: WorkflowNode['kind'], config: Record<string, unknown>): WorkflowNode {
  return { id, kind, label: id, position: { x: 0, y: 0 }, config }
}

const SIMPLE_GRAPH: WorkflowGraph = {
  nodes: [node('m', 'manual', { text: 'hi' }), node('o', 'output', {})],
  edges: [{ id: 'e', source: 'm', target: 'o' }],
}

describe('workflows repository (schedule + runs)', () => {
  it('round-trips schedule fields and lists scheduled workflows', () => {
    const wf = db.workflows.create({
      name: 'Sched',
      graph: SIMPLE_GRAPH,
      schedule: { kind: 'interval' as const, everyMinutes: 30 },
      scheduleEnabled: true,
    })
    expect(db.workflows.getById(wf.id)?.schedule).toEqual({ kind: 'interval' as const, everyMinutes: 30 })
    expect(db.workflows.listScheduled().map((w) => w.id)).toEqual([wf.id])

    db.workflows.update(wf.id, { name: 'Sched', graph: SIMPLE_GRAPH, scheduleEnabled: false })
    expect(db.workflows.listScheduled()).toEqual([])
  })

  it('prunes run history beyond the cap', () => {
    const wf = db.workflows.create({ name: 'W', graph: SIMPLE_GRAPH })
    for (let i = 0; i < 55; i++) {
      db.workflows.insertRun({
        workflowId: wf.id,
        trigger: 'manual',
        status: 'ok',
        output: `run ${i}`,
        error: null,
        startedAt: 1000 + i,
        finishedAt: 1001 + i,
      })
    }
    const runs = db.workflows.listRuns(wf.id, 50)
    expect(runs).toHaveLength(50)
    // Newest kept, oldest pruned.
    expect(runs[0].output).toBe('run 54')
    expect(runs.some((r) => r.output === 'run 0')).toBe(false)
  })
})

describe('pickRunOutput', () => {
  it('prefers the output node, falls back to the last executed output', () => {
    const result = { ok: true, order: ['m', 'o'], nodeOutputs: { m: 'hi', o: 'final' } }
    expect(pickRunOutput(SIMPLE_GRAPH, result)).toBe('final')
    const noOutputNode: WorkflowGraph = { nodes: [node('m', 'manual', {})], edges: [] }
    expect(
      pickRunOutput(noOutputNode, { ok: true, order: ['m'], nodeOutputs: { m: 'only' } })
    ).toBe('only')
  })
})

describe('WorkflowRunner', () => {
  it('runs a saved workflow, persists the run and stamps lastRunAt', async () => {
    const wf = db.workflows.create({ name: 'W', graph: SIMPLE_GRAPH })
    const runner = createWorkflowRunner(db, { runAgent: async () => '' })
    const result = await runner.runById(wf.id, 'manual')
    expect(result.ok).toBe(true)

    const runs = db.workflows.listRuns(wf.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ trigger: 'manual', status: 'ok', output: 'hi' })
    expect(db.workflows.getById(wf.id)?.lastRunAt).not.toBeNull()
  })

  it('records a failed run with its error', async () => {
    const graph: WorkflowGraph = {
      nodes: [node('n', 'notify', {})],
      edges: [],
    }
    const wf = db.workflows.create({ name: 'Broken', graph })
    const runner = createWorkflowRunner(db, { runAgent: async () => '' }) // no notify channel
    const result = await runner.runById(wf.id, 'schedule')
    expect(result.ok).toBe(false)
    const runs = db.workflows.listRuns(wf.id)
    expect(runs[0].status).toBe('error')
    expect(runs[0].error).toMatch(/delivery channel/i)
  })

  it('fires onRunRecorded with the persisted run for ok and error runs', async () => {
    const onRunRecorded = vi.fn()
    const runner = createWorkflowRunner(db, { runAgent: async () => '' }, { onRunRecorded })

    const good = db.workflows.create({ name: 'Good', graph: SIMPLE_GRAPH })
    await runner.runById(good.id, 'manual')
    expect(onRunRecorded).toHaveBeenCalledTimes(1)
    const [okRun, okWorkflow] = onRunRecorded.mock.calls[0]
    expect(okRun).toMatchObject({ workflowId: good.id, trigger: 'manual', status: 'ok' })
    expect(db.workflows.listRuns(good.id)[0].id).toBe(okRun.id)
    expect(okWorkflow.name).toBe('Good')

    const broken = db.workflows.create({
      name: 'Broken',
      graph: { nodes: [node('n', 'notify', {})], edges: [] },
    })
    await runner.runById(broken.id, 'schedule')
    expect(onRunRecorded).toHaveBeenCalledTimes(2)
    expect(onRunRecorded.mock.calls[1][0]).toMatchObject({
      workflowId: broken.id,
      trigger: 'schedule',
      status: 'error',
    })
  })

  it('does not fire onRunRecorded when the run never persists', async () => {
    const onRunRecorded = vi.fn()
    const runner = createWorkflowRunner(db, { runAgent: async () => '' }, { onRunRecorded })
    await expect(runner.runById('missing-id', 'manual')).rejects.toThrow(/not found/i)
    expect(onRunRecorded).not.toHaveBeenCalled()
  })

  it('a throwing hook never breaks the run result', async () => {
    const runner = createWorkflowRunner(
      db,
      { runAgent: async () => '' },
      {
        onRunRecorded: () => {
          throw new Error('listener bug')
        },
      }
    )
    const wf = db.workflows.create({ name: 'W', graph: SIMPLE_GRAPH })
    const result = await runner.runById(wf.id, 'manual')
    expect(result.ok).toBe(true)
    expect(db.workflows.listRuns(wf.id)).toHaveLength(1)
  })
})

describe('scheduler due check + tick', () => {
  const base: Omit<Workflow, 'schedule' | 'scheduleEnabled' | 'lastRunAt'> = {
    id: 'w',
    name: 'W',
    graph: SIMPLE_GRAPH,
    webhookEnabled: false,
    watch: null,
    scheduleUpdatedAt: 0,
    createdAt: 0,
    updatedAt: 0,
  }

  it('isDue: never-run is due; interval must elapse; disabled never fires', () => {
    const now = 10 * 60_000
    expect(isDue({ ...base, schedule: { kind: 'interval' as const, everyMinutes: 5 }, scheduleEnabled: true, lastRunAt: null }, now)).toBe(true)
    expect(isDue({ ...base, schedule: { kind: 'interval' as const, everyMinutes: 5 }, scheduleEnabled: true, lastRunAt: now - 4 * 60_000 }, now)).toBe(false)
    expect(isDue({ ...base, schedule: { kind: 'interval' as const, everyMinutes: 5 }, scheduleEnabled: true, lastRunAt: now - 5 * 60_000 }, now)).toBe(true)
    expect(isDue({ ...base, schedule: { kind: 'interval' as const, everyMinutes: 5 }, scheduleEnabled: false, lastRunAt: null }, now)).toBe(false)
    expect(isDue({ ...base, schedule: null, scheduleEnabled: true, lastRunAt: null }, now)).toBe(false)
  })

  it('tick runs due workflows once and not again before the interval', async () => {
    const wf = db.workflows.create({
      name: 'Tick',
      graph: SIMPLE_GRAPH,
      schedule: { kind: 'interval' as const, everyMinutes: 60 },
      scheduleEnabled: true,
    })
    const runner = createWorkflowRunner(db, { runAgent: async () => '' })
    const onError = vi.fn()
    const scheduler = new WorkflowScheduler({ db, runner, onError })

    await scheduler.tick()
    expect(db.workflows.listRuns(wf.id)).toHaveLength(1)
    // Immediately after, the interval hasn't elapsed — nothing new runs.
    await scheduler.tick()
    expect(db.workflows.listRuns(wf.id)).toHaveLength(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('a scheduled tick fires onRunRecorded with the schedule trigger', async () => {
    db.workflows.create({
      name: 'Tick',
      graph: SIMPLE_GRAPH,
      schedule: { kind: 'interval' as const, everyMinutes: 60 },
      scheduleEnabled: true,
    })
    const onRunRecorded = vi.fn()
    const runner = createWorkflowRunner(db, { runAgent: async () => '' }, { onRunRecorded })
    const scheduler = new WorkflowScheduler({ db, runner })

    await scheduler.tick()
    expect(onRunRecorded).toHaveBeenCalledTimes(1)
    expect(onRunRecorded.mock.calls[0][0]).toMatchObject({ trigger: 'schedule', status: 'ok' })
  })

  it('never runs a workflow twice when an earlier due run outlasts the tick', async () => {
    const AGENT_GRAPH: WorkflowGraph = {
      nodes: [node('m', 'manual', { text: 'go' }), node('a', 'ai_agent', { prompt: '{{input}}' })],
      edges: [{ id: 'e', source: 'm', target: 'a' }],
    }
    const first = db.workflows.create({
      name: 'Slow',
      graph: AGENT_GRAPH,
      schedule: { kind: 'interval' as const, everyMinutes: 60 },
      scheduleEnabled: true,
    })
    const second = db.workflows.create({
      name: 'Second',
      graph: AGENT_GRAPH,
      schedule: { kind: 'interval' as const, everyMinutes: 60 },
      scheduleEnabled: true,
    })
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runAgent = vi.fn(async () => {
      await gate
      return 'done'
    })
    const runner = createWorkflowRunner(db, { runAgent })
    const scheduler = new WorkflowScheduler({ db, runner })

    // The first workflow's run outlasts the tick interval; the next tick sees
    // the second workflow still due and must not run it from a stale snapshot.
    const tickA = scheduler.tick()
    const tickB = scheduler.tick()
    release()
    await Promise.all([tickA, tickB])

    expect(db.workflows.listRuns(first.id)).toHaveLength(1)
    expect(db.workflows.listRuns(second.id)).toHaveLength(1)
    expect(runAgent).toHaveBeenCalledTimes(2)
  })
})
