/**
 * The activity log: every tool call, with the reason it was allowed to run.
 *
 * What these tests pin down is that the log is HONEST — a refused call is
 * recorded as loudly as a completed one, the recorded reason distinguishes
 * "you approved this" from "a rule did", and nothing key-shaped survives into
 * the stored text. A log that only remembers the successes, or that leaks the
 * secret it was auditing, is worse than no log.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, ToolApprovalAnswer, ToolCallRecord } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { createToolSystem } from '../../src/main/tools'

let dir: string
let db: AppDatabase
let projectId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-activity-'))
  db = openDatabase(join(dir, 'app.db'))
  const projectDir = join(dir, 'project')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'alpha.txt'), 'the needle is here\n')
  projectId = db.code.projectUpsertByPath(projectDir, 'project').id
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
})

function conv(): Conversation {
  return {
    id: 'conv-1',
    mode: 'work',
    title: 'Test',
    providerId: null,
    modelId: null,
    systemPrompt: null,
    params: {},
    workspaceId: null,
    projectId,
    projectRef: null,
    moaPresetId: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

function call(name: string, args: unknown = {}): ToolCallRecord {
  return {
    id: 'tc-1',
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
    status: 'proposed',
  }
}

const APPROVE: ToolApprovalAnswer = { approved: true, scope: 'once' }
const DECLINE: ToolApprovalAnswer = { approved: false, scope: 'once' }

describe('activity log', () => {
  it('records an approved call with who allowed it and what came back', async () => {
    const { executor } = createToolSystem(db)
    await executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv(),
      approval: vi.fn(async () => APPROVE),
    })

    const [entry] = db.activity.list()
    expect(entry).toMatchObject({
      toolName: 'file_search',
      decision: 'approved',
      detail: 'approved once',
      conversationId: 'conv-1',
      agentName: null,
    })
    expect(entry.arguments).toContain('needle')
    expect(entry.result).toContain('needle is here')
  })

  it('names the scope a wider approval was given with', async () => {
    const { executor } = createToolSystem(db)
    await executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv(),
      approval: vi.fn(async () => ({ approved: true, scope: 'always' as const })),
    })
    expect(db.activity.list()[0].detail).toBe('approved everywhere')
  })

  it('distinguishes a rule from a human, and from an always-allow permission', async () => {
    const { registry, executor } = createToolSystem(db)
    const approval = vi.fn(async () => APPROVE)

    // 1. Covered by a standing rule.
    db.toolRules.create({ toolId: 'file_search', effect: 'allow', scope: 'global' })
    await executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv(),
      approval,
    })
    // 2. Simply an always-allow permission, no rule in sight.
    registry.setPermission('web_search', 'always_allow')
    db.toolRules.deleteAll()

    const entries = db.activity.list()
    expect(entries[0]).toMatchObject({ decision: 'rule', detail: 'covered by an approval rule' })
    expect(approval).not.toHaveBeenCalled()
  })

  it('records a refusal as loudly as a run — declined, denied, plan mode, sandbox', async () => {
    const { registry, executor } = createToolSystem(db)

    // Declined at the prompt.
    await executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv(),
      approval: vi.fn(async () => DECLINE),
    })
    // Denied in settings — never even asked.
    registry.setPermission('repo_map', 'deny')
    await executor.execute(call('repo_map', { query: 'x' }), {
      conversation: conv(),
      approval: vi.fn(async () => APPROVE),
    })
    // Blocked by plan mode.
    await executor.execute(call('write_file', { path: 'a.txt', content: 'x' }), {
      conversation: conv(),
      approval: vi.fn(async () => APPROVE),
      planMode: true,
    })
    // Blocked by the read-only sandbox.
    await executor.execute(call('write_file', { path: 'a.txt', content: 'x' }), {
      conversation: conv(),
      approval: vi.fn(async () => APPROVE),
      sandboxLevel: 'read-only',
    })

    const entries = db.activity.list()
    expect(entries).toHaveLength(4)
    // Newest first.
    expect(entries.map((e) => e.detail)).toEqual([
      'read-only sandbox',
      'plan mode',
      'denied in settings',
      'declined at the approval prompt',
    ])
    expect(entries.filter((e) => e.decision === 'blocked')).toHaveLength(3)
    expect(entries.filter((e) => e.decision === 'declined')).toHaveLength(1)
  })

  it('records the acting agent profile when there is one', async () => {
    const { executor } = createToolSystem(db)
    await executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv(),
      approval: vi.fn(async () => APPROVE),
      agentName: 'Watcher',
    })
    expect(db.activity.list()[0].agentName).toBe('Watcher')
  })

  it('redacts secret-looking arguments before they are stored', async () => {
    const { executor } = createToolSystem(db)
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345'
    await executor.execute(call('file_search', { query: secret }), {
      conversation: conv(),
      approval: vi.fn(async () => APPROVE),
    })
    const [entry] = db.activity.list()
    expect(entry.arguments).not.toContain(secret)
    expect(entry.result).not.toContain(secret)
  })

  it('does not record a call that never reached a decision', async () => {
    const { executor } = createToolSystem(db)
    const approval = vi.fn(async () => APPROVE)
    // An unknown tool and malformed arguments are model mistakes, not actions.
    await executor.execute(call('does_not_exist'), { conversation: conv(), approval })
    await executor.execute(call('file_search', '{not json'), { conversation: conv(), approval })
    expect(db.activity.list()).toHaveLength(0)
  })

  it('links a file write to the change it proposed', async () => {
    const { executor } = createToolSystem(
      db,
      { readFile: (_p, relPath) => ({ relPath, content: '', truncated: false, sizeBytes: 0 }) },
      {
        codeChanges: {
          propose: () => ({ id: 'change-42' }),
          apply: () => undefined,
        },
      }
    )
    await executor.execute(call('write_file', { path: 'new.txt', content: 'hello' }), {
      conversation: conv(),
      approval: vi.fn(async () => APPROVE),
    })
    expect(db.activity.list()[0].changeId).toBe('change-42')
  })

  it('filters by decision and by free text', async () => {
    const { executor } = createToolSystem(db)
    await executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv(),
      approval: vi.fn(async () => APPROVE),
    })
    await executor.execute(call('file_search', { query: 'haystack' }), {
      conversation: conv(),
      approval: vi.fn(async () => DECLINE),
    })

    expect(db.activity.list({ decision: 'declined' })).toHaveLength(1)
    expect(db.activity.list({ search: 'haystack' })).toHaveLength(1)
    expect(db.activity.list({ search: 'needle' })[0].decision).toBe('approved')
    expect(db.activity.list({ search: 'nothing-like-this' })).toHaveLength(0)
  })

  it('treats a wildcard typed in the search box as literal text', async () => {
    const { executor } = createToolSystem(db)
    await executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv(),
      approval: vi.fn(async () => APPROVE),
    })
    // Without an ESCAPE clause this would match everything.
    expect(db.activity.list({ search: '%' })).toHaveLength(0)
  })

  it('pages with `before` and reports the untruncated total', async () => {
    const { executor } = createToolSystem(db)
    for (let i = 0; i < 3; i++) {
      await executor.execute(call('file_search', { query: `q${i}` }), {
        conversation: conv(),
        approval: vi.fn(async () => APPROVE),
      })
    }
    const all = db.activity.list()
    expect(db.activity.count()).toBe(3)
    const older = db.activity.list({ before: all[0].at })
    expect(older.every((entry) => entry.at < all[0].at)).toBe(true)
  })
})
