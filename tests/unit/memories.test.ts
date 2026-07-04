import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-mem-test-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('memories repository', () => {
  it('creates and lists memories, most recently updated first', () => {
    const a = db.memories.create({ title: 'a', content: 'first' })
    const b = db.memories.create({ title: 'b', content: 'second' })
    // Touch a so it becomes the most recently updated (well past b's stamp).
    db.driver.run('UPDATE memories SET updated_at = ? WHERE id = ?', [b.updatedAt + 60_000, a.id])
    expect(db.memories.list().map((m) => m.title)).toEqual(['a', 'b'])
  })

  it('create defaults sourceConversationId to null and stores it when given', () => {
    const anon = db.memories.create({ title: 'anon', content: 'x' })
    expect(anon.sourceConversationId).toBeNull()
    const sourced = db.memories.create({ title: 'sourced', content: 'y', sourceConversationId: 'c1' })
    expect(sourced.sourceConversationId).toBe('c1')
  })

  it('update patches title/content and bumps updatedAt', () => {
    const created = db.memories.create({ title: 'orig', content: 'old' })
    db.driver.run('UPDATE memories SET updated_at = updated_at - 10 WHERE id = ?', [created.id])
    const before = db.memories.getById(created.id)!
    const updated = db.memories.update(created.id, { content: 'new' })
    expect(updated?.title).toBe('orig')
    expect(updated?.content).toBe('new')
    expect(updated!.updatedAt).toBeGreaterThan(before.updatedAt)
    expect(db.memories.update('missing-id', { content: 'x' })).toBeNull()
  })

  it('remove deletes by id', () => {
    const created = db.memories.create({ title: 'gone', content: 'x' })
    db.memories.remove(created.id)
    expect(db.memories.getById(created.id)).toBeNull()
  })

  it('upsertByTitle creates, then updates case-insensitively without duplicating', () => {
    const first = db.memories.upsertByTitle({ title: 'Preferred-Language', content: 'Swedish' })
    const second = db.memories.upsertByTitle({
      title: 'preferred-language',
      content: 'Swedish, formal tone',
      sourceConversationId: 'conv-2',
    })
    expect(second.id).toBe(first.id)
    expect(second.content).toBe('Swedish, formal tone')
    expect(second.sourceConversationId).toBe('conv-2')
    // Original title casing is kept — only content/provenance change.
    expect(second.title).toBe('Preferred-Language')
    expect(db.memories.list()).toHaveLength(1)
  })

  it('removeByTitle deletes case-insensitively and reports whether a row was removed', () => {
    db.memories.create({ title: 'Old-Fact', content: 'x' })
    expect(db.memories.removeByTitle('old-fact')).toBe(true)
    expect(db.memories.list()).toHaveLength(0)
    expect(db.memories.removeByTitle('never-existed')).toBe(false)
  })
})
