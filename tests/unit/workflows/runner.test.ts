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
      schedule: { everyMinutes: 30 },
      scheduleEnabled: true,
    })
    expect(db.workflows.getById(wf.id)?.schedule).toEqual({ everyMinutes: 30 })
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
})

describe('scheduler due check + tick', () => {
  const base: Omit<Workflow, 'schedule' | 'scheduleEnabled' | 'lastRunAt'> = {
    id: 'w',
    name: 'W',
    graph: SIMPLE_GRAPH,
    createdAt: 0,
    updatedAt: 0,
  }

  it('isDue: never-run is due; interval must elapse; disabled never fires', () => {
    const now = 10 * 60_000
    expect(isDue({ ...base, schedule: { everyMinutes: 5 }, scheduleEnabled: true, lastRunAt: null }, now)).toBe(true)
    expect(isDue({ ...base, schedule: { everyMinutes: 5 }, scheduleEnabled: true, lastRunAt: now - 4 * 60_000 }, now)).toBe(false)
    expect(isDue({ ...base, schedule: { everyMinutes: 5 }, scheduleEnabled: true, lastRunAt: now - 5 * 60_000 }, now)).toBe(true)
    expect(isDue({ ...base, schedule: { everyMinutes: 5 }, scheduleEnabled: false, lastRunAt: null }, now)).toBe(false)
    expect(isDue({ ...base, schedule: null, scheduleEnabled: true, lastRunAt: null }, now)).toBe(false)
  })

  it('tick runs due workflows once and not again before the interval', async () => {
    const wf = db.workflows.create({
      name: 'Tick',
      graph: SIMPLE_GRAPH,
      schedule: { everyMinutes: 60 },
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
})
