import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-skills-test-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('skills repository', () => {
  it('creates enabled by default and lists standalone skills before plugin skills', () => {
    db.skills.create({ name: 'zeta', content: 'z' })
    db.skills.create({ name: 'alpha', content: 'a', pluginName: 'pack' })
    const listed = db.skills.list()
    expect(listed.map((s) => s.name)).toEqual(['zeta', 'alpha'])
    expect(listed.every((s) => s.enabled)).toBe(true)
  })

  it('listEnabled excludes disabled skills', () => {
    const a = db.skills.create({ name: 'a', content: 'x' })
    db.skills.create({ name: 'b', content: 'y' })
    db.skills.update(a.id, { enabled: false })
    expect(db.skills.listEnabled().map((s) => s.name)).toEqual(['b'])
  })

  it('countEnabled counts enabled skills without loading them', () => {
    expect(db.skills.countEnabled()).toBe(0)
    const a = db.skills.create({ name: 'a', content: 'x' })
    db.skills.create({ name: 'b', content: 'y' })
    expect(db.skills.countEnabled()).toBe(2)
    db.skills.update(a.id, { enabled: false })
    expect(db.skills.countEnabled()).toBe(1)
  })

  it('getByName matches case-insensitively', () => {
    db.skills.create({ name: 'Commit-Helper', content: 'x' })
    expect(db.skills.getByName('commit-helper')?.name).toBe('Commit-Helper')
    expect(db.skills.getByName('missing')).toBeNull()
  })

  it('update patches fields and unknown ids return null', () => {
    const created = db.skills.create({ name: 'a', content: 'old' })
    const updated = db.skills.update(created.id, { content: 'new', description: 'd' })
    expect(updated).toMatchObject({ name: 'a', content: 'new', description: 'd' })
    expect(db.skills.update('missing', { content: 'x' })).toBeNull()
  })

  it('upsertByName updates in place (case-insensitive) and preserves the enabled flag', () => {
    const created = db.skills.create({ name: 'Triage', content: 'v1', description: 'old' })
    db.skills.update(created.id, { enabled: false })
    const upserted = db.skills.upsertByName({
      name: 'triage',
      content: 'v2',
      description: 'new',
      pluginName: 'pack',
      sourcePath: 'C:/skills/triage',
    })
    expect(upserted.id).toBe(created.id)
    expect(upserted.content).toBe('v2')
    expect(upserted.pluginName).toBe('pack')
    expect(upserted.enabled).toBe(false) // re-import must not re-enable
    expect(db.skills.list()).toHaveLength(1)
  })

  it('remove deletes by id', () => {
    const created = db.skills.create({ name: 'gone', content: 'x' })
    db.skills.remove(created.id)
    expect(db.skills.getById(created.id)).toBeNull()
  })
})
