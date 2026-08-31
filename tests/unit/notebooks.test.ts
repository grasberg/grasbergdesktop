/**
 * Notebooks (migration v43 + the documents repository): the leaf rebuild that
 * makes documents.conversation_id nullable while preserving rows and CASCADE
 * semantics, and the repository's CRUD + version-snapshot behaviour (20-cap
 * prune, revert, cascade delete).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { open } from '../../src/main/db/driver'
import { MIGRATIONS } from '../../src/main/db/migrations'
import { MAX_VERSIONS_PER_DOC } from '../../src/main/db/repositories/documents'

let dir: string
let dbFile: string
let db: AppDatabase | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-notebooks-'))
  dbFile = join(dir, 'app.db')
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

/** Builds a genuine v42 database with a conversation-keyed documents row. */
function seedV42Database(): void {
  const raw = open(dbFile)
  for (const migration of MIGRATIONS.filter((m) => m.version <= 42)) {
    for (const statement of migration.statements) raw.exec(statement)
  }
  raw.run("INSERT INTO meta (key, value) VALUES ('schema_version', '42')")
  raw.run(
    "INSERT INTO conversations (id, mode, title, params_json, created_at, updated_at) VALUES ('c1','chat','Chat','{}',1,1)"
  )
  raw.run(
    "INSERT INTO documents (id, conversation_id, kind, title, content, created_at, updated_at) VALUES ('legacy1','c1','doc','Legacy','# body',5,6)"
  )
  raw.close()
}

describe('migration v43 (notebooks)', () => {
  it('preserves rows, allows NULL conversation_id, keeps CASCADE for keyed rows', () => {
    seedV42Database()
    db = openDatabase(dbFile)

    // The legacy row survived the rebuild byte-for-byte.
    const legacy = db.documents.getById('legacy1')
    expect(legacy).toMatchObject({
      id: 'legacy1',
      title: 'Legacy',
      content: '# body',
      conversationId: 'c1',
      kind: 'doc',
      createdAt: 5,
      updatedAt: 6,
    })

    // A NULL-conversation notebook now inserts cleanly.
    const notebook = db.documents.create({ title: 'Notes', content: 'hello' })
    expect(notebook.conversationId).toBeNull()

    // Deleting the conversation cascades ONLY its own document.
    db.driver.run("DELETE FROM conversations WHERE id = 'c1'")
    expect(db.documents.getById('legacy1')).toBeNull()
    expect(db.documents.getById(notebook.id)).not.toBeNull()
  }, 15_000)
})

describe('documents repository', () => {
  beforeEach(() => {
    db = openDatabase(dbFile)
  })

  it('create defaults: kind doc, null conversationId, empty content', () => {
    const doc = db!.documents.create({ title: 'My note' })
    expect(doc.kind).toBe('doc')
    expect(doc.conversationId).toBeNull()
    expect(doc.content).toBe('')
    expect(db!.documents.getById(doc.id)).toEqual(doc)
  })

  it('list returns summaries with contentLength and excludes html rows', () => {
    const doc = db!.documents.create({ title: 'Note', content: 'abcde' })
    db!.driver.run(
      "INSERT INTO documents (id, conversation_id, kind, title, content, created_at, updated_at) VALUES ('h1',NULL,'html','Proto','<html>',1,1)"
    )
    const list = db!.documents.list()
    expect(list.map((d) => d.id)).toEqual([doc.id])
    expect(list[0].contentLength).toBe(5)
    expect(list[0]).not.toHaveProperty('content')
  })

  it('findByTitle is case-insensitive and ignores html rows', () => {
    const doc = db!.documents.create({ title: 'Shopping List' })
    expect(db!.documents.findByTitle('shopping list')?.id).toBe(doc.id)
    expect(db!.documents.findByTitle('nope')).toBeNull()
  })

  it(`caps versions at ${MAX_VERSIONS_PER_DOC}, newest first, pruning the oldest`, () => {
    const doc = db!.documents.create({ title: 'Note', content: 'v0' })
    for (let i = 1; i <= 25; i += 1) {
      db!.documents.update(doc.id, { content: `v${i}` })
    }
    const versions = db!.documents.listVersions(doc.id)
    expect(versions).toHaveLength(MAX_VERSIONS_PER_DOC)
    // Newest snapshot holds the second-to-last content; the oldest were pruned.
    expect(versions[0].content).toBe('v24')
    expect(versions[versions.length - 1].content).toBe('v5')
    expect(db!.documents.getById(doc.id)?.content).toBe('v25')
  })

  it('title-only and identical-content updates write no version', () => {
    const doc = db!.documents.create({ title: 'Note', content: 'same' })
    db!.documents.update(doc.id, { title: 'Renamed' })
    db!.documents.update(doc.id, { content: 'same' })
    expect(db!.documents.listVersions(doc.id)).toHaveLength(0)
    expect(db!.documents.getById(doc.id)?.title).toBe('Renamed')
  })

  it('revert restores the version and snapshots the pre-revert content', () => {
    const doc = db!.documents.create({ title: 'Note', content: 'first' })
    db!.documents.update(doc.id, { content: 'second' })
    const [snapshotOfFirst] = db!.documents.listVersions(doc.id)
    expect(snapshotOfFirst.content).toBe('first')

    const reverted = db!.documents.revert(doc.id, snapshotOfFirst.id)
    expect(reverted?.content).toBe('first')
    // The pre-revert 'second' became the newest version, so the revert is
    // itself undoable.
    expect(db!.documents.listVersions(doc.id)[0].content).toBe('second')
  })

  it('revert rejects a versionId belonging to another document', () => {
    const a = db!.documents.create({ title: 'A', content: 'a1' })
    db!.documents.update(a.id, { content: 'a2' })
    const [versionOfA] = db!.documents.listVersions(a.id)
    const b = db!.documents.create({ title: 'B', content: 'b1' })

    expect(db!.documents.revert(b.id, versionOfA.id)).toBeNull()
    expect(db!.documents.getById(b.id)?.content).toBe('b1')
  })

  it('delete removes the document and cascades its versions', () => {
    const doc = db!.documents.create({ title: 'Note', content: 'one' })
    db!.documents.update(doc.id, { content: 'two' })
    expect(db!.documents.listVersions(doc.id)).toHaveLength(1)

    db!.documents.remove(doc.id)
    expect(db!.documents.getById(doc.id)).toBeNull()
    expect(
      db!.driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM document_versions')!.n
    ).toBe(0)
  })
})
