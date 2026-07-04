import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { open } from '../../src/main/db/driver'
import { MIGRATIONS } from '../../src/main/db/migrations'

let dir: string
let dbFile: string
let db: AppDatabase | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-prompts-'))
  dbFile = join(dir, 'app.db')
  db = openDatabase(dbFile)
})

afterEach(() => {
  try {
    db?.close()
  } catch {
    // already closed
  }
  db = null
  rmSync(dir, { recursive: true, force: true })
})

describe('prompt templates repository', () => {
  it('creates, lists, updates and removes templates', () => {
    const a = db!.prompts.create({ title: 'Reviewer', body: 'Be concise.' })
    const b = db!.prompts.create({ title: 'Translator', body: 'Translate to Swedish.' })

    expect(a.variables).toBeNull()
    const ids = db!.prompts.list().map((t) => t.id).sort()
    expect(ids).toEqual([a.id, b.id].sort())

    const updated = db!.prompts.update(a.id, { title: 'Strict reviewer' })
    expect(updated?.title).toBe('Strict reviewer')
    expect(db!.prompts.getById(a.id)?.body).toBe('Be concise.')

    db!.prompts.remove(b.id)
    expect(db!.prompts.getById(b.id)).toBeNull()
    expect(db!.prompts.list()).toHaveLength(1)
  })

  it('update returns null for an unknown id', () => {
    expect(db!.prompts.update('nope', { title: 'x' })).toBeNull()
  })
})

describe('migration v5 (prompt_templates)', () => {
  it('applies on reopen of a v4 database', () => {
    db!.close()
    db = null
    rmSync(dbFile, { force: true })

    const v4 = open(dbFile)
    for (const migration of MIGRATIONS.filter((m) => m.version <= 4)) {
      for (const statement of migration.statements) v4.exec(statement)
    }
    v4.run("INSERT INTO meta (key, value) VALUES ('schema_version', '4')")
    expect(
      v4.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prompt_templates'"
      )
    ).toBeUndefined()
    v4.close()

    db = openDatabase(dbFile)
    const version = db.driver.get<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    )!.value
    expect(Number.parseInt(version, 10)).toBeGreaterThanOrEqual(5)
    // Table is usable.
    const t = db.prompts.create({ title: 'x', body: 'y' })
    expect(db.prompts.getById(t.id)?.title).toBe('x')
  })
})
