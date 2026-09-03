/**
 * Agent-owned memories (migration v32): an agent profile is an owner, not just
 * a persona. What its runs remember is invisible to every other agent and to
 * ordinary conversations, and titles are unique PER OWNER — so "Watcher" and
 * "Release notes" can each keep a "last-seen" without overwriting each other.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { DreamingService } from '../../src/main/services/dreaming'

let dir: string
let db: AppDatabase
let watcherId: string
let scribeId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-agent-memory-'))
  db = openDatabase(join(dir, 'app.db'))
  watcherId = db.agents.create({ name: 'Watcher', systemPrompt: 'You watch things.' }).id
  scribeId = db.agents.create({ name: 'Scribe', systemPrompt: 'You write things.' }).id
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('memory ownership', () => {
  it('keeps a shared memory out of an agent view, and vice versa', () => {
    db.memories.create({ title: 'user-language', content: 'Swedish' })
    db.memories.create({ title: 'last-seen', content: 'build 41', agentId: watcherId })

    expect(db.memories.listForAgent(null).map((m) => m.title)).toEqual(['user-language'])
    expect(db.memories.listForAgent(watcherId).map((m) => m.title)).toEqual(['last-seen'])
    expect(db.memories.listForAgent(scribeId)).toHaveLength(0)
    // Settings → Memory still shows everything, so nothing is unauditable.
    expect(db.memories.list()).toHaveLength(2)
  })

  it('scopes the upsert by owner: the same title is three different memories', () => {
    db.memories.upsertByTitle({ title: 'last-seen', content: 'shared' })
    db.memories.upsertByTitle({ title: 'last-seen', content: 'watcher', agentId: watcherId })
    db.memories.upsertByTitle({ title: 'last-seen', content: 'scribe', agentId: scribeId })
    expect(db.memories.list()).toHaveLength(3)

    // Re-emitting under the same title updates that owner's copy only.
    db.memories.upsertByTitle({ title: 'last-seen', content: 'watcher v2', agentId: watcherId })
    expect(db.memories.list()).toHaveLength(3)
    expect(db.memories.listForAgent(watcherId)[0].content).toBe('watcher v2')
    expect(db.memories.listForAgent(null)[0].content).toBe('shared')
    expect(db.memories.listForAgent(scribeId)[0].content).toBe('scribe')
  })

  it('an agent can only forget its own memory', () => {
    db.memories.create({ title: 'last-seen', content: 'shared' })
    db.memories.create({ title: 'last-seen', content: 'watcher', agentId: watcherId })

    expect(db.memories.removeByTitle('last-seen', scribeId)).toBe(false)
    expect(db.memories.list()).toHaveLength(2)

    expect(db.memories.removeByTitle('last-seen', watcherId)).toBe(true)
    expect(db.memories.listForAgent(null)).toHaveLength(1)
    expect(db.memories.listForAgent(watcherId)).toHaveLength(0)
  })

  it('defaults to the shared owner when none is given (the chat memory hook)', () => {
    db.memories.upsertByTitle({ title: 'user-language', content: 'Swedish' })
    expect(db.memories.listForAgent(null)).toHaveLength(1)
    expect(db.memories.removeByTitle('user-language')).toBe(true)
  })

  it('outlives its agent profile rather than cascading away', () => {
    db.memories.create({ title: 'last-seen', content: 'build 41', agentId: watcherId })
    db.agents.remove(watcherId)
    // The user's remembered facts are never deleted as a side effect of
    // tidying up a profile; they simply stop being injected anywhere.
    expect(db.memories.list()).toHaveLength(1)
    expect(db.memories.listForAgent(null)).toHaveLength(0)
  })
})

describe('dreaming and agent memories', () => {
  it('dreams each owner in its own call, never merging across owners', async () => {
    for (let i = 0; i < 6; i++) {
      db.memories.create({ title: `shared-${i}`, content: `fact ${i}` })
    }
    db.memories.create({ title: 'private-a', content: 'watcher only a', agentId: watcherId })
    db.memories.create({ title: 'private-b', content: 'watcher only b', agentId: watcherId })
    db.memories.create({ title: 'lonely', content: 'scribe has one', agentId: scribeId })

    const prompts: string[] = []
    const dreaming = new DreamingService({
      db,
      generate: async (prompt) => {
        prompts.push(prompt)
        return JSON.stringify({
          operations: [{ action: 'create', title: `merged-${prompts.length}`, content: 'merged' }],
        })
      },
    })
    const result = await dreaming.dreamNow(true)

    // Two calls: the shared pool and Watcher. Scribe has a single memory and
    // is skipped; no prompt ever mixes owners.
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('shared-0')
    expect(prompts[0]).not.toContain('watcher only')
    expect(prompts[1]).toContain('watcher only a')
    expect(prompts[1]).not.toContain('shared-0')
    expect(prompts[1]).toContain('Watcher')
    // Creations inherit the namespace they were merged from.
    expect(db.memories.listForAgent(null).map((m) => m.title)).toContain('merged-1')
    expect(db.memories.listForAgent(watcherId).map((m) => m.title)).toContain('merged-2')
    expect(db.memories.listForAgent(scribeId)).toHaveLength(1)
    expect(result.perOwner?.map((run) => run.agentName)).toEqual([null, 'Watcher', 'Scribe'])
    expect(result.perOwner?.find((run) => run.agentId === scribeId)?.result.ran).toBe(false)
    // Separate watermarks per namespace.
    const keys = db.driver
      .all<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'dreaming_last_run_at%'")
      .map((row) => row.key)
      .sort()
    expect(keys).toEqual(['dreaming_last_run_at', `dreaming_last_run_at:${watcherId}`])
  })

  it('a scoped manual run touches only that namespace; a deleted profile is skipped', async () => {
    for (let i = 0; i < 3; i++) db.memories.create({ title: `s-${i}`, content: 'x' })
    db.memories.create({ title: 'w-1', content: 'x', agentId: watcherId })
    db.memories.create({ title: 'w-2', content: 'x', agentId: watcherId })
    db.memories.create({ title: 'gone-1', content: 'x', agentId: 'deleted-profile' })
    db.memories.create({ title: 'gone-2', content: 'x', agentId: 'deleted-profile' })
    const prompts: string[] = []
    const dreaming = new DreamingService({
      db,
      generate: async (prompt) => {
        prompts.push(prompt)
        return JSON.stringify({ operations: [] })
      },
    })
    await dreaming.dreamNow(true, { agentId: watcherId })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('w-1')
    expect(prompts[0]).not.toContain('s-0')

    prompts.length = 0
    await dreaming.dreamNow(true)
    expect(prompts).toHaveLength(2) // shared + Watcher; the orphaned namespace never runs
    expect(prompts.some((p) => p.includes('gone-1'))).toBe(false)
  })

  it('a failing namespace does not starve the others', async () => {
    for (let i = 0; i < 3; i++) db.memories.create({ title: `s-${i}`, content: 'x' })
    db.memories.create({ title: 'w-1', content: 'x', agentId: watcherId })
    db.memories.create({ title: 'w-2', content: 'x', agentId: watcherId })
    let calls = 0
    const dreaming = new DreamingService({
      db,
      generate: async () => {
        calls += 1
        if (calls === 1) throw new Error('provider down')
        return JSON.stringify({ operations: [] })
      },
    })
    const result = await dreaming.dreamNow(true)
    expect(calls).toBe(2)
    expect(result.ran).toBe(true)
    expect(result.perOwner?.map((run) => run.agentName)).toEqual(['Watcher'])
  })
})

describe('memory read scope (listVisibleTo)', () => {
  it('shows a bot its own memories first, then the shared pool, deduped by title with the bot winning', () => {
    db.memories.create({ title: 'Deploy day', content: 'shared: Fridays' })
    db.memories.create({ title: 'user-language', content: 'Swedish' })
    db.memories.create({ title: 'deploy day', content: 'watcher: Thursdays', agentId: watcherId })
    db.memories.create({ title: 'scribe-secret', content: 'not yours', agentId: scribeId })

    const visible = db.memories.listVisibleTo(watcherId)
    expect(visible.map((m) => m.content)).toEqual(['watcher: Thursdays', 'Swedish'])
    expect(db.memories.listVisibleTo(null).map((m) => m.title).sort()).toEqual([
      'Deploy day',
      'user-language',
    ])
    expect(db.memories.listOwners().sort()).toEqual([null, scribeId, watcherId].sort())
  })
})
