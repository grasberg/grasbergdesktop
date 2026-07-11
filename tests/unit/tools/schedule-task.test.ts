/**
 * schedule_task through the REAL registry + executor: the approval flow as
 * the consent gate for standing autonomous runs, create/list/cancel against
 * the real scheduled_tasks table, argument validation, and the unavailable
 * path (executor built without the dep).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, ToolCallRecord } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import { createToolSystem, ToolExecutor, USER_DECLINED_RESULT } from '../../../src/main/tools'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-schedtool-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const conversation: Conversation = {
  id: 'conv-sched',
  mode: 'chat',
  title: 'Sched',
  providerId: null,
  modelId: null,
  systemPrompt: null,
  params: {},
  workspaceId: null,
  projectId: null,
  projectRef: null,
  moaPresetId: null,
  createdAt: 0,
  updatedAt: 0,
}

function call(args: unknown): ToolCallRecord {
  return {
    id: 'tc-sched',
    name: 'schedule_task',
    arguments: JSON.stringify(args),
    status: 'proposed',
  }
}

const APPROVE = { approved: true, scope: 'once' as const }
const DECLINE = { approved: false, scope: 'once' as const }

describe('schedule_task execution', () => {
  it("risk 'sensitive' => approval requested; approve creates a row the scheduler will pick up", async () => {
    const onChanged = vi.fn()
    const { executor } = createToolSystem(db, null, { onScheduledTasksChanged: onChanged })
    const approval = vi.fn(async () => APPROVE)

    const result = await executor.execute(
      call({
        action: 'create',
        title: 'Hourly check',
        prompt: 'Check the feeds.',
        recurrence: 'hourly',
      }),
      { conversation, approval }
    )

    expect(approval).toHaveBeenCalledTimes(1)
    expect(result).toContain('Scheduled task "Hourly check" created')
    expect(result).toContain('repeats hourly')
    const tasks = db.scheduledTasks.list()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].recurrence).toBe('hourly')
    expect(tasks[0].nextRunAt).toBeGreaterThan(Date.now())
    expect(tasks[0].enabled).toBe(true)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('decline returns the standard note and creates nothing', async () => {
    const { executor } = createToolSystem(db)
    const result = await executor.execute(
      call({ action: 'create', title: 'X', prompt: 'Y', recurrence: 'daily', time: '09:00' }),
      { conversation, approval: vi.fn(async () => DECLINE) }
    )
    expect(result).toBe(USER_DECLINED_RESULT)
    expect(db.scheduledTasks.list()).toEqual([])
  })

  it('lists tasks with ids and cancels by id', async () => {
    const onChanged = vi.fn()
    const { executor } = createToolSystem(db, null, { onScheduledTasksChanged: onChanged })
    const task = db.scheduledTasks.create({
      title: 'Morning brief',
      prompt: 'Summarize.',
      recurrence: 'daily',
      runAt: Date.now() + 60_000,
    })

    const listed = await executor.execute(call({ action: 'list' }), {
      conversation,
      approval: vi.fn(async () => APPROVE),
    })
    expect(listed).toContain('Morning brief')
    expect(listed).toContain(task.id)

    const cancelled = await executor.execute(call({ action: 'cancel', id: task.id }), {
      conversation,
      approval: vi.fn(async () => APPROVE),
    })
    expect(cancelled).toContain('Cancelled scheduled task "Morning brief"')
    expect(db.scheduledTasks.list()).toEqual([])
    expect(onChanged).toHaveBeenCalledTimes(1)

    const missing = await executor.execute(call({ action: 'cancel', id: 'nope' }), {
      conversation,
      approval: vi.fn(async () => APPROVE),
    })
    expect(missing).toContain("no scheduled task with id 'nope'")
  })

  it('validates arguments with readable errors', async () => {
    const { executor } = createToolSystem(db)
    const ctx = { conversation, approval: vi.fn(async () => APPROVE) }

    expect(await executor.execute(call({}), ctx)).toContain('missing required argument')
    expect(await executor.execute(call({ action: 'pause' }), ctx)).toContain("unknown action 'pause'")
    expect(
      await executor.execute(call({ action: 'create', title: 'T', prompt: 'P' }), ctx)
    ).toContain('recurrence must be one of')
    expect(
      await executor.execute(
        call({ action: 'create', title: 'T', prompt: 'P', recurrence: 'daily' }),
        ctx
      )
    ).toContain("provide 'time'")
    expect(
      await executor.execute(
        call({ action: 'create', title: 'T', prompt: 'P', recurrence: 'daily', time: '9pm' }),
        ctx
      )
    ).toContain('"HH:MM"')
    expect(db.scheduledTasks.list()).toEqual([])
  })

  it('pre-approves valid tools; folderless grants carry a warning', async () => {
    const { executor } = createToolSystem(db)
    const result = await executor.execute(
      call({
        action: 'create',
        title: 'Fetcher',
        prompt: 'Fetch the page.',
        recurrence: 'hourly',
        tools: ['fetch_url', 'fetch_url'],
      }),
      { conversation, approval: vi.fn(async () => APPROVE) }
    )
    expect(result).toContain('Pre-approved tools: fetch_url')
    expect(result).toContain('WARNING: no working folder')
    const stored = db.scheduledTasks.list()[0]
    expect(stored.approvedToolIds).toEqual(['fetch_url']) // deduped
    expect(stored.projectId).toBeNull()
  })

  it('inherits the conversation working folder for granted tools', async () => {
    const project = db.code.projectUpsertByPath(dir, 'Proj')
    const conv = db.conversations.create({ mode: 'work', projectId: project.id })
    const { executor } = createToolSystem(db)
    const result = await executor.execute(
      call({
        action: 'create',
        title: 'Writer',
        prompt: 'Write the report.',
        recurrence: 'daily',
        time: '09:00',
        tools: ['write_file'],
      }),
      { conversation: conv, approval: vi.fn(async () => APPROVE) }
    )
    expect(result).toContain('working folder')
    expect(result).not.toContain('WARNING')
    expect(db.scheduledTasks.list()[0].projectId).toBe(project.id)
  })

  it('refuses grants for unknown, hidden and per-call-approval tools', async () => {
    const { executor } = createToolSystem(db)
    const ctx = { conversation, approval: vi.fn(async () => APPROVE) }
    const base = { action: 'create', title: 'T', prompt: 'P', recurrence: 'hourly' }

    expect(await executor.execute(call({ ...base, tools: ['nope'] }), ctx)).toContain(
      "unknown or disabled tool 'nope'"
    )
    // run_shell_command is hidden while shell execution is off => not grantable.
    expect(
      await executor.execute(call({ ...base, tools: ['run_shell_command'] }), ctx)
    ).toContain('unknown or disabled')
    expect(await executor.execute(call({ ...base, tools: ['git_write'] }), ctx)).toContain(
      'cannot be pre-approved'
    )
    expect(await executor.execute(call({ ...base, tools: ['schedule_task'] }), ctx)).toContain(
      'cannot be pre-approved'
    )
    expect(db.scheduledTasks.list()).toEqual([])
  })

  it('reports unavailable when built without the dep', async () => {
    const executor = new ToolExecutor({
      registry: createToolSystem(db).registry,
      getProjectRoot: () => null,
    })
    const result = await executor.execute(call({ action: 'list' }), {
      conversation,
      approval: vi.fn(async () => APPROVE),
    })
    expect(result).toContain('unavailable')
  })
})
