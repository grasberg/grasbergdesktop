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
  dir = mkdtempSync(join(tmpdir(), 'uld-documents-'))
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

describe('migration v8 (widen conversation modes) + v9 (documents)', () => {
  it('rebuilds conversations WITHOUT losing conversations or messages', () => {
    // Build a genuine v7 database and seed a conversation + message.
    const raw = open(dbFile)
    for (const migration of MIGRATIONS.filter((m) => m.version <= 7)) {
      for (const statement of migration.statements) raw.exec(statement)
    }
    raw.run("INSERT INTO meta (key, value) VALUES ('schema_version', '7')")
    raw.run(
      "INSERT INTO conversations (id, mode, title, params_json, created_at, updated_at) VALUES ('c1','chat','Old chat','{}',1,1)"
    )
    raw.run(
      "INSERT INTO messages (id, conversation_id, role, content, status, seq, created_at) VALUES ('m1','c1','user','hello','complete',1,1)"
    )
    raw.close()

    // Upgrading through v8 (FK-safe rebuild) + v9 must preserve everything.
    db = openDatabase(dbFile)
    const version = db.driver.get<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    )!.value
    expect(Number.parseInt(version, 10)).toBeGreaterThanOrEqual(9)

    expect(db.conversations.getById('c1')).toMatchObject({ id: 'c1', title: 'Old chat' })
    // The cascade did NOT fire during the table rebuild.
    expect(db.messages.listByConversation('c1')).toHaveLength(1)

    // New modes are now accepted.
    const write = db.conversations.create({ mode: 'write', title: 'Doc' })
    expect(write.mode).toBe('write')
    const design = db.conversations.create({ mode: 'design', title: 'Proto' })
    expect(design.mode).toBe('design')
  })
})

describe('documents repository', () => {
  it('upserts the single doc and appends html prototypes', () => {
    db = openDatabase(dbFile)
    const conv = db.conversations.create({ mode: 'write', title: 'W' })

    const first = db.documents.upsertDoc(conv.id, 'Title', '# v1')
    expect(db.documents.getDoc(conv.id)).toMatchObject({ id: first.id, content: '# v1' })
    // Upsert replaces the same row (still one doc).
    db.documents.upsertDoc(conv.id, 'Title', '# v2')
    expect(db.documents.listByConversation(conv.id, 'doc')).toHaveLength(1)
    expect(db.documents.getDoc(conv.id)?.content).toBe('# v2')

    // HTML prototypes accumulate.
    db.documents.addHtml(conv.id, 'A', '<html>a</html>')
    db.documents.addHtml(conv.id, 'B', '<html>b</html>')
    expect(db.documents.listByConversation(conv.id, 'html')).toHaveLength(2)

    // User content edit.
    const saved = db.documents.saveContent(first.id, '# edited')
    expect(saved?.content).toBe('# edited')

    // Deleting the conversation cascades documents.
    db.conversations.remove(conv.id)
    expect(db.documents.listByConversation(conv.id)).toHaveLength(0)
  })
})
