/**
 * Two-mode migrations over a genuine older database: v24 deletes legacy
 * non-chat content (an explicit product decision — chat survives untouched),
 * v25 rebuilds conversations/projects without the mode CHECK so 'work' rows
 * can be created. Also re-asserts the v8 rebuild guarantee it replaced: table
 * rebuilds never cascade children away.
 */

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
  dir = mkdtempSync(join(tmpdir(), 'uld-two-modes-'))
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

/** Builds a genuine pre-v24 database seeded with chat + legacy-mode content. */
function seedLegacyDatabase(): void {
  const raw = open(dbFile)
  for (const migration of MIGRATIONS.filter((m) => m.version <= 23)) {
    for (const statement of migration.statements) raw.exec(statement)
  }
  raw.run("INSERT INTO meta (key, value) VALUES ('schema_version', '23')")

  // Surviving chat conversation with a message and a chat project.
  raw.run(
    "INSERT INTO projects (id, mode, name, created_at, updated_at) VALUES ('pc','chat','Keep',1,1)"
  )
  raw.run(
    "INSERT INTO conversations (id, mode, title, params_json, project_ref, created_at, updated_at) VALUES ('c1','chat','Old chat','{}','pc',1,1)"
  )
  raw.run(
    "INSERT INTO messages (id, conversation_id, role, content, status, seq, created_at) VALUES ('m1','c1','user','hello','complete',1,1)"
  )

  // Legacy cowork conversation with a workspace + item.
  raw.run(
    "INSERT INTO workspaces (id, name, status, created_at, updated_at) VALUES ('w1','Old workspace','active',1,1)"
  )
  raw.run(
    "INSERT INTO workspace_items (id, workspace_id, kind, title, content, sort, origin, created_at, updated_at) VALUES ('wi1','w1','note','Note','body',0,'user',1,1)"
  )
  raw.run(
    "INSERT INTO conversations (id, mode, title, params_json, workspace_id, created_at, updated_at) VALUES ('c2','cowork','Old cowork','{}','w1',1,1)"
  )
  raw.run(
    "INSERT INTO messages (id, conversation_id, role, content, status, seq, created_at) VALUES ('m2','c2','user','plan this','complete',1,1)"
  )

  // Legacy code conversation with a granted folder + a proposed change,
  // legacy write conversation with a document, and a legacy-mode project.
  raw.run(
    "INSERT INTO code_projects (id, path, name, approved_at) VALUES ('cp1','C:/granted','Granted',1)"
  )
  raw.run(
    "INSERT INTO conversations (id, mode, title, params_json, project_id, created_at, updated_at) VALUES ('c3','code','Old code','{}','cp1',1,1)"
  )
  raw.run(
    "INSERT INTO code_changes (id, project_id, conversation_id, file_path, change_type, status, created_at) VALUES ('ch1','cp1','c3','a.ts','create','proposed',1)"
  )
  raw.run(
    "INSERT INTO conversations (id, mode, title, params_json, created_at, updated_at) VALUES ('c4','write','Old write','{}',1,1)"
  )
  raw.run(
    "INSERT INTO documents (id, conversation_id, kind, title, content, created_at, updated_at) VALUES ('d1','c4','doc','Doc','# text',1,1)"
  )
  raw.run(
    "INSERT INTO projects (id, mode, name, created_at, updated_at) VALUES ('pw','write','Doomed',1,1)"
  )
  raw.close()
}

describe('migrations v24 + v25 (two modes)', () => {
  it('deletes legacy-mode content, keeps chat, and accepts work rows', () => {
    seedLegacyDatabase()
    db = openDatabase(dbFile)

    const version = db.driver.get<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    )!.value
    expect(Number.parseInt(version, 10)).toBeGreaterThanOrEqual(25)

    // Chat content survived the deletes AND the v25 rebuild (no cascade fired).
    expect(db.conversations.getById('c1')).toMatchObject({ id: 'c1', title: 'Old chat' })
    expect(db.messages.listByConversation('c1')).toHaveLength(1)
    expect(db.projects.list('chat').map((p) => p.id)).toEqual(['pc'])
    expect(db.conversations.getById('c1')?.projectRef).toBe('pc')

    // Every legacy-mode conversation is gone, with its children.
    for (const id of ['c2', 'c3', 'c4']) {
      expect(db.conversations.getById(id)).toBeNull()
      expect(db.messages.listByConversation(id)).toHaveLength(0)
    }
    expect(db.workspaces.list()).toHaveLength(0)
    expect(db.code.changesList('cp1')).toHaveLength(0)
    expect(db.projects.list('work')).toHaveLength(0)
    expect(
      db.driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM documents')!.n
    ).toBe(0)

    // User-granted folder rows are grants, not content — they survive.
    expect(db.code.projectGetById('cp1')).not.toBeNull()

    // The mode CHECK is gone: 'work' rows insert cleanly.
    const work = db.conversations.create({ mode: 'work', title: 'New work' })
    expect(work.mode).toBe('work')
    expect(db.projects.create({ mode: 'work', name: 'Work project' }).mode).toBe('work')
    expect(db.conversations.list({ mode: 'work' }).map((s) => s.id)).toEqual([work.id])
  }, 15_000)
})
