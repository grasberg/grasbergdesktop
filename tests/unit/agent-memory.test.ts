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
  it('consolidates only shared memories, never merging across owners', async () => {
    for (let i = 0; i < 6; i++) {
      db.memories.create({ title: `shared-${i}`, content: `fact ${i}` })
    }
    db.memories.create({ title: 'private', content: 'watcher only', agentId: watcherId })

    let seenPrompt = ''
    const dreaming = new DreamingService({
      db,
      generate: async (prompt) => {
        seenPrompt = prompt
        return JSON.stringify({ operations: [] })
      },
    })
    await dreaming.dreamNow(true)

    // The private memory never reaches the consolidation prompt, so it can
    // never be rewritten into, or merged with, someone else's recollection.
    expect(seenPrompt).toContain('shared-0')
    expect(seenPrompt).not.toContain('watcher only')
    expect(db.memories.listForAgent(watcherId)).toHaveLength(1)
  })
})
