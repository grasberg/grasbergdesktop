import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-ws-test-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('workspaces.itemUpsertByKindTitle', () => {
  it('creates a new item when no kind+title match exists', () => {
    const ws = db.workspaces.create({ name: 'W' })
    const item = db.workspaces.itemUpsertByKindTitle({
      workspaceId: ws.id,
      kind: 'checklist',
      title: 'Launch checklist',
      content: '- [ ] a',
      origin: 'assistant',
    })
    expect(item.content).toBe('- [ ] a')
    expect(db.workspaces.itemsList(ws.id)).toHaveLength(1)
  })

  it('updates the existing item instead of duplicating on same kind+title', () => {
    const ws = db.workspaces.create({ name: 'W' })
    const first = db.workspaces.itemUpsertByKindTitle({
      workspaceId: ws.id,
      kind: 'checklist',
      title: 'Launch checklist',
      content: '- [ ] a\n- [ ] b',
      origin: 'assistant',
    })
    const second = db.workspaces.itemUpsertByKindTitle({
      workspaceId: ws.id,
      kind: 'checklist',
      title: 'Launch checklist',
      content: '- [x] a\n- [ ] b',
      origin: 'assistant',
    })
    expect(second.id).toBe(first.id)
    expect(second.content).toBe('- [x] a\n- [ ] b')
    expect(db.workspaces.itemsList(ws.id)).toHaveLength(1)
  })

  it('matches titles case-insensitively and keeps sort and origin', () => {
    const ws = db.workspaces.create({ name: 'W' })
    const first = db.workspaces.itemCreate({
      workspaceId: ws.id,
      kind: 'plan',
      title: 'Roadmap',
      content: 'v1',
      sort: 7,
      origin: 'user',
    })
    const updated = db.workspaces.itemUpsertByKindTitle({
      workspaceId: ws.id,
      kind: 'plan',
      title: 'ROADMAP',
      content: 'v2',
      origin: 'assistant',
    })
    expect(updated.id).toBe(first.id)
    expect(updated.content).toBe('v2')
    expect(updated.sort).toBe(7)
    expect(updated.origin).toBe('user')
    // The original title is kept — only content/status change on update.
    expect(updated.title).toBe('Roadmap')
  })

  it('does not match across kinds or across workspaces', () => {
    const ws = db.workspaces.create({ name: 'W' })
    const other = db.workspaces.create({ name: 'Other' })
    db.workspaces.itemUpsertByKindTitle({
      workspaceId: ws.id,
      kind: 'note',
      title: 'Same title',
      content: 'note body',
      origin: 'assistant',
    })
    db.workspaces.itemUpsertByKindTitle({
      workspaceId: ws.id,
      kind: 'doc',
      title: 'Same title',
      content: 'doc body',
      origin: 'assistant',
    })
    db.workspaces.itemUpsertByKindTitle({
      workspaceId: other.id,
      kind: 'note',
      title: 'Same title',
      content: 'other workspace',
      origin: 'assistant',
    })
    expect(db.workspaces.itemsList(ws.id)).toHaveLength(2)
    expect(db.workspaces.itemsList(other.id)).toHaveLength(1)
  })

  it('applies a provided status on update and keeps the old one otherwise', () => {
    const ws = db.workspaces.create({ name: 'W' })
    const created = db.workspaces.itemUpsertByKindTitle({
      workspaceId: ws.id,
      kind: 'task',
      title: 'Ship it',
      content: '',
      origin: 'assistant',
    })
    expect(created.status).toBe('todo') // task default

    const doing = db.workspaces.itemUpsertByKindTitle({
      workspaceId: ws.id,
      kind: 'task',
      title: 'Ship it',
      content: 'in progress',
      status: 'doing',
      origin: 'assistant',
    })
    expect(doing.id).toBe(created.id)
    expect(doing.status).toBe('doing')

    const noStatus = db.workspaces.itemUpsertByKindTitle({
      workspaceId: ws.id,
      kind: 'task',
      title: 'Ship it',
      content: 'still going',
      origin: 'assistant',
    })
    expect(noStatus.status).toBe('doing')
  })

  it('updates the earliest-created item when duplicates already exist', () => {
    const ws = db.workspaces.create({ name: 'W' })
    const a = db.workspaces.itemCreate({
      workspaceId: ws.id,
      kind: 'note',
      title: 'Dup',
      content: 'first',
      origin: 'assistant',
    })
    db.workspaces.itemCreate({
      workspaceId: ws.id,
      kind: 'note',
      title: 'Dup',
      content: 'second',
      origin: 'assistant',
    })
    const updated = db.workspaces.itemUpsertByKindTitle({
      workspaceId: ws.id,
      kind: 'note',
      title: 'Dup',
      content: 'merged',
      origin: 'assistant',
    })
    expect(updated.id).toBe(a.id)
    expect(db.workspaces.itemsList(ws.id)).toHaveLength(2)
  })
})
