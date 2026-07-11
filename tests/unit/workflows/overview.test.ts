/**
 * Overview repo queries over a real temp db: latest run per workflow (the
 * scheduled section's status source), cross-workflow recent runs with names,
 * SQL-level snippet truncation, and FK cascade cleanup.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Workflow, WorkflowRun } from '@shared/types'
import { WORKFLOW_RUN_SNIPPET_MAX } from '@shared/workflow-status'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'

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
