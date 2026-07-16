/**
 * Agent inbox: the inbox_state repository (v30) and the pure aggregation that
 * merges agent runs, workflow runs and scheduled-task runs into one reviewed/
 * unreviewed feed.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentRun, ScheduledTask, WorkflowRunListItem } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { buildInboxItems } from '../../src/main/services/inbox'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-inbox-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function agentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    conversationId: 'conv-1',
    projectId: null,
    agentName: 'researcher',
    task: 'Investigate the flaky test',
    status: 'done',
    result: 'It is a race in the setup.',
    worktreePath: null,
    providerId: null,
    modelId: null,
    startedAt: 1_000,
    finishedAt: 2_000,
    ...overrides,
  }
}

function workflowRun(overrides: Partial<WorkflowRunListItem> = {}): WorkflowRunListItem {
  return {
    id: 'wrun-1',
    workflowId: 'wf-1',
    workflowName: 'Morning digest',
    trigger: 'schedule',
    status: 'ok',
    output: 'Digest sent.',
    error: null,
    startedAt: 3_000,
    finishedAt: 4_000,
    ...overrides,
  }
}

function scheduledTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    title: 'Nightly summary',
    prompt: 'Summarize the day',
    recurrence: 'daily',
    nextRunAt: null,
    enabled: true,
    approvedToolIds: [],
    projectId: null,
    lastRunAt: 5_000,
    lastStatus: 'ok',
    lastOutput: 'All quiet.',
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('inbox_state repository', () => {
  it('marks items reviewed idempotently (upsert refreshes the timestamp)', () => {
    db.inbox.markReviewed('agent_run', 'run-1', 111)
    db.inbox.markReviewed('agent_run', 'run-1', 222)
    db.inbox.markReviewed('workflow_run', 'wrun-9', 333)
    const map = db.inbox.reviewedByKey()
    expect(map.get('agent_run:run-1')).toBe(222)
    expect(map.get('workflow_run:wrun-9')).toBe(333)
    expect(map.size).toBe(2)
  })
})

describe('buildInboxItems', () => {
  it('merges the three sources, newest first, with reviewed state joined on', () => {
    const items = buildInboxItems(
      {
        agentRuns: [agentRun()],
        workflowRuns: [workflowRun()],
        scheduledTasks: [scheduledTask()],
      },
      new Map([['workflow_run:wrun-1', 9_000]])
    )
    expect(items.map((i) => i.itemType)).toEqual([
      'scheduled_task_run',
      'workflow_run',
      'agent_run',
    ])
    expect(items[1].reviewedAt).toBe(9_000)
    expect(items[0].reviewedAt).toBeNull()
    expect(items[0].itemId).toBe('task-1:5000')
  })

  it('skips running agent runs and never-run/running scheduled tasks', () => {
    const items = buildInboxItems(
      {
        agentRuns: [agentRun({ status: 'running' })],
        workflowRuns: [],
        scheduledTasks: [
          scheduledTask({ lastRunAt: null }),
          scheduledTask({ id: 't2', lastStatus: 'running' }),
        ],
      },
      new Map()
    )
    expect(items).toHaveLength(0)
  })

  it('maps statuses and snips long output', () => {
    const items = buildInboxItems(
      {
        agentRuns: [
          agentRun({ id: 'a', status: 'error', result: 'x'.repeat(1000) }),
          agentRun({ id: 'b', status: 'stopped' }),
        ],
        workflowRuns: [workflowRun({ status: 'error', error: 'Node 3 failed' })],
        scheduledTasks: [],
      },
      new Map()
    )
    const error = items.find((i) => i.itemId === 'a')!
    expect(error.status).toBe('error')
    expect(error.snippet.length).toBeLessThan(260)
    expect(items.find((i) => i.itemId === 'b')!.status).toBe('stopped')
    expect(items.find((i) => i.itemType === 'workflow_run')!.snippet).toBe('Node 3 failed')
  })

  it('a re-run scheduled task reappears as a new unreviewed item', () => {
    const reviewed = new Map([['scheduled_task_run:task-1:5000', 6_000]])
    const before = buildInboxItems(
      { agentRuns: [], workflowRuns: [], scheduledTasks: [scheduledTask()] },
      reviewed
    )
    expect(before[0].reviewedAt).toBe(6_000)
    const after = buildInboxItems(
      { agentRuns: [], workflowRuns: [], scheduledTasks: [scheduledTask({ lastRunAt: 7_000 })] },
      reviewed
    )
    expect(after[0].itemId).toBe('task-1:7000')
    expect(after[0].reviewedAt).toBeNull()
  })
})
