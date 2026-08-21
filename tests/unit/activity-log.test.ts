/**
 * The activity log: every tool call, with the reason it was allowed to run.
 *
 * What these tests pin down is that the log is HONEST — a refused call is
 * recorded as loudly as a completed one, the recorded reason distinguishes
 * "you approved this" from "a rule did", and nothing key-shaped survives into
 * the stored text. A log that only remembers the successes, or that leaks the
 * secret it was auditing, is worse than no log.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ActivityCursor,
  Conversation,
  ModelInfo,
  TestConnectionResult,
  ToolApprovalAnswer,
  ToolCallRecord,
} from '@shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import {
  MAX_ENTRIES,
  PRUNE_SLACK,
  type ActivityEntryInput,
} from '../../src/main/db/repositories/activity'
import type {
  AdapterChatRequest,
  AdapterChatResult,
  AdapterStreamEvent,
  ProviderAdapter,
} from '../../src/main/providers/adapter'
import { ChatService, type ChatToolSystem } from '../../src/main/services/chat-service'
import { createToolSystem } from '../../src/main/tools'
import { HEADLESS_CONVERSATION_ID, type ToolExecuteContext } from '../../src/main/tools/executor'

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

/** A ready-made entry, for the cases that are about the table, not the executor. */
function logged(overrides: Partial<ActivityEntryInput> = {}): ActivityEntryInput {
  return {
    at: Date.now(),
    conversationId: null,
    agentName: null,
    toolId: 'file_search',
    toolName: 'file_search',
    risk: 'safe',
    decision: 'auto',
    detail: '',
    arguments: '',
    result: '',
    changeId: null,
    ...overrides,
  }
}

const APPROVE: ToolApprovalAnswer = { approved: true, scope: 'once' }
const DECLINE: ToolApprovalAnswer = { approved: false, scope: 'once' }

/** Calls file_search once, then finishes — enough to drive one real tool call. */
class SearchOnceAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const
  rounds = 0
  async chat(_req: AdapterChatRequest): Promise<AdapterChatResult> {
    this.rounds++
    if (this.rounds === 1) {
      return {
        text: '',
        toolCalls: [
          { id: 't1', name: 'file_search', arguments: '{"query":"needle"}', status: 'proposed' },
        ],
        finishReason: 'tool_calls',
      }
    }
    return { text: 'Done.', toolCalls: [], finishReason: 'stop' }
  }
  // eslint-disable-next-line require-yield
  async *chatStream(): AsyncGenerator<AdapterStreamEvent> {
    throw new Error('not used')
  }
  async listModels(): Promise<ModelInfo[]> {
    return []
  }
  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'ok' }
  }
}

/** An enabled provider with a key, so a headless generation can resolve one. */
function providerWithKey(): string {
  const provider = db.providers.create({
    id: randomUUID(),
    type: 'openai-compatible',
    label: 'P',
    baseUrl: 'https://x.example/v1',
    defaultModelId: 'm',
    enabled: true,
  })
  db.providers.setKeyRow(
    provider.id,
    'insecure:' + Buffer.from('sk-headless', 'utf8').toString('base64'),
    'sk-…ss'
  )
  return provider.id
}

describe('activity log', () => {
  it('records an approved call with who allowed it and what came back', async () => {
    const { executor } = createToolSystem(db)
    await executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv(),
      approval: vi.fn(async () => APPROVE),
    })

    const [entry] = db.activity.list().entries
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
    expect(db.activity.list().entries[0].detail).toBe('approved everywhere')
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

    const entries = db.activity.list().entries
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

    const entries = db.activity.list().entries
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
    expect(db.activity.list().entries[0].agentName).toBe('Watcher')
  })

  it('leaves the conversation empty for a headless run, keeps it for an interactive one', async () => {
    const { executor } = createToolSystem(db)
    const approval = vi.fn(async () => APPROVE)
    await executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv(),
      approval,
    })
    // A stub with no row behind it. That this is the id the REAL headless
    // caller stamps on its stub is pinned by the next test — on its own, this
    // half only shows the executor filters the constant it was handed.
    await executor.execute(call('file_search', { query: 'needle' }), {
      conversation: { ...conv(), id: HEADLESS_CONVERSATION_ID },
      approval,
    })

    const entries = db.activity.list().entries
    expect(entries[0].conversationId).toBeNull()
    expect(entries[1].conversationId).toBe('conv-1')
  })

  it('drives the real headless caller through the real executor into the log', async () => {
    // The two halves of the headless rule live in different files: the id is
    // stamped on the stub in chat-service (generateForWorkflow), the filter
    // reads it in the executor. Only running the actual caller proves they
    // still agree — hand-building the stub from the same constant the executor
    // compares against would pass no matter what generateForWorkflow does.
    const providerId = providerWithKey()
    const real = createToolSystem(db)
    const seenConversationIds: string[] = []
    const tools: ChatToolSystem = {
      registry: real.registry,
      // A pass-through around the real executor: it records which conversation
      // the caller handed down, then lets the real policy + audit path run.
      executor: {
        execute: (toolCall: ToolCallRecord, ctx: ToolExecuteContext) => {
          seenConversationIds.push(ctx.conversation.id)
          return real.executor.execute(toolCall, ctx)
        },
      },
      broker: { request: vi.fn(async () => APPROVE) },
    }
    const adapter = new SearchOnceAdapter()
    const service = new ChatService(db, () => undefined, {
      tools,
      resolveAdapter: () => adapter,
    })

    await service.generateForWorkflow('find the needle', providerId, 'm', {
      useTools: true,
      approvedToolIds: ['file_search'],
      projectId,
    })

    // The pin: the id generateForWorkflow actually builds its stub with IS the
    // one the executor treats as "no conversation". Give a headless run a
    // distinguishable id (`workflow:<runId>`, a tempting change) and this fails
    // here rather than silently writing dangling ids into the log again.
    expect(seenConversationIds).toEqual([HEADLESS_CONVERSATION_ID])

    const entries = db.activity.list().entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ toolName: 'file_search', decision: 'approved' })
    // The call really ran, so the entry below is a genuine audited one.
    expect(entries[0].result).toContain('needle is here')
    expect(entries[0].conversationId).toBeNull()
  })

  it('redacts secret-looking arguments before they are stored', async () => {
    const { executor } = createToolSystem(db)
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345'
    await executor.execute(call('file_search', { query: secret }), {
      conversation: conv(),
      approval: vi.fn(async () => APPROVE),
    })
    const [entry] = db.activity.list().entries
    expect(entry.arguments).not.toContain(secret)
    expect(entry.result).not.toContain(secret)
  })

  it('does not record a call that never reached a decision', async () => {
    const { executor } = createToolSystem(db)
    const approval = vi.fn(async () => APPROVE)
    // An unknown tool and malformed arguments are model mistakes, not actions.
    await executor.execute(call('does_not_exist'), { conversation: conv(), approval })
    await executor.execute(call('file_search', '{not json'), { conversation: conv(), approval })
    expect(db.activity.list().entries).toHaveLength(0)
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
    expect(db.activity.list().entries[0].changeId).toBe('change-42')
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

    expect(db.activity.list({ decision: 'declined' }).entries).toHaveLength(1)
    expect(db.activity.list({ search: 'haystack' }).entries).toHaveLength(1)
    expect(db.activity.list({ search: 'needle' }).entries[0].decision).toBe('approved')
    expect(db.activity.list({ search: 'nothing-like-this' }).entries).toHaveLength(0)
  })

  it('treats a wildcard typed in the search box as literal text', async () => {
    const { executor } = createToolSystem(db)
    await executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv(),
      approval: vi.fn(async () => APPROVE),
    })
    // '*' is GLOB's own "match everything"; it has to stay a character.
    expect(db.activity.list({ search: '*' }).entries).toHaveLength(0)
    expect(db.activity.list({ search: '%' }).entries).toHaveLength(0)
  })

  it('matches a search that differs in case outside ASCII', () => {
    db.activity.record(logged({ toolName: 'run_shell_command', detail: 'Öppna filen' }))
    // LIKE and LOWER only fold ASCII in the bundled SQLite build, so this is
    // the case the GLOB pattern exists for.
    expect(db.activity.list({ search: 'öppna' }).entries).toHaveLength(1)
    expect(db.activity.list({ search: 'ÖPPNA FILEN' }).entries).toHaveLength(1)
    expect(db.activity.list({ search: 'stäng' }).entries).toHaveLength(0)
  })

  it('holds the cap as entries pile up, and across a restart', () => {
    let written = 0
    /** Append `n` more entries, numbered and timestamped in insertion order. */
    const fill = (n: number): void => {
      db.driver.transaction(() => {
        for (let i = 0; i < n; i++) {
          db.activity.record(logged({ at: written + 1, detail: `e-${written}` }))
          written++
        }
      })
    }

    // Pruning is amortized: it sorts the whole table, so it is paid once per
    // slack instead of on every tool call. Below the threshold nothing has been
    // trimmed yet — the log is over the cap and even the first entry is still
    // readable. Trimming on every insert would already have dropped it.
    fill(MAX_ENTRIES + PRUNE_SLACK - 1)
    expect(db.activity.count()).toBeGreaterThan(MAX_ENTRIES)
    expect(db.activity.count()).toBeLessThanOrEqual(MAX_ENTRIES + PRUNE_SLACK)
    expect(db.activity.list({ search: 'e-0' }).entries).toHaveLength(1)

    // Past the threshold it trims back to the cap and then climbs again, so a
    // full log still sits above MAX_ENTRIES most of the time — by the slack,
    // never further, and never below the entries the cap promises to keep.
    fill(PRUNE_SLACK + 1)
    expect(db.activity.count()).toBeGreaterThan(MAX_ENTRIES)
    expect(db.activity.count()).toBeLessThanOrEqual(MAX_ENTRIES + PRUNE_SLACK)
    expect(db.activity.list({ limit: 1 }).entries[0].detail).toBe(`e-${written - 1}`)
    expect(db.activity.list({ search: 'e-0' }).entries).toHaveLength(0)

    // A restart begins with a fresh in-memory count; the rows it never saw
    // still have to be pruned, or the log grows without bound.
    db.close()
    db = openDatabase(join(dir, 'app.db'))
    fill(PRUNE_SLACK + 2)
    expect(db.activity.count()).toBeLessThanOrEqual(MAX_ENTRIES + PRUNE_SLACK)
    expect(db.activity.list({ limit: 1 }).entries[0].detail).toBe(`e-${written - 1}`)
  })

  it('pages with `before` and reports the untruncated total', async () => {
    const { executor } = createToolSystem(db)
    for (let i = 0; i < 3; i++) {
      await executor.execute(call('file_search', { query: `q${i}` }), {
        conversation: conv(),
        approval: vi.fn(async () => APPROVE),
      })
    }
    const first = db.activity.list({ limit: 2 })
    expect(db.activity.count()).toBe(3)
    expect(first.entries).toHaveLength(2)
    // The cursor is where the page stopped, and it is null only at the end.
    expect(first.cursor).toEqual({ at: first.entries[1].at, seq: expect.any(Number) })
    const older = db.activity.list({ before: first.cursor ?? undefined })
    expect(older.entries).toHaveLength(1)
    expect(older.cursor).toBeNull()
  })

  it('pages through entries that share a timestamp without dropping any', () => {
    // Two cheap tool calls land in the same millisecond routinely, so a page
    // boundary falls inside such a group sooner or later. Every entry has to
    // come back exactly once anyway: completeness is the point of this log.
    const at = 1_700_000_000_000
    const inserted = 7
    for (let i = 0; i < inserted; i++) db.activity.record(logged({ at, detail: `same-${i}` }))

    const seen: string[] = []
    let cursor: ActivityCursor | undefined
    for (let page = 0; page <= inserted; page++) {
      const res = db.activity.list({ limit: 3, before: cursor })
      seen.push(...res.entries.map((entry) => entry.detail))
      if (res.cursor === null) break
      cursor = res.cursor
    }

    // Newest first, which within one millisecond means newest-inserted first.
    expect(seen).toEqual(['same-6', 'same-5', 'same-4', 'same-3', 'same-2', 'same-1', 'same-0'])
    expect(new Set(seen).size).toBe(inserted)
    expect(db.activity.count()).toBe(inserted)
  })
})
