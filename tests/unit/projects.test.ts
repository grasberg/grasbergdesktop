import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-projects-test-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('projects repository', () => {
  it('creates a project scoped to a mode and lists it per mode', () => {
    const chat = db.projects.create({ mode: 'chat', name: 'Chat A' })
    db.projects.create({ mode: 'code', name: 'Code A' })

    expect(chat.mode).toBe('chat')
    expect(db.projects.list('chat').map((p) => p.name)).toEqual(['Chat A'])
    expect(db.projects.list('code').map((p) => p.name)).toEqual(['Code A'])
    expect(db.projects.list()).toHaveLength(2)
  })

  it('lists newest first', () => {
    const a = db.projects.create({ mode: 'chat', name: 'A' })
    const b = db.projects.create({ mode: 'chat', name: 'B' })
    // b was created after a, so it sorts first (updated_at desc).
    expect(db.projects.list('chat').map((p) => p.id)).toEqual([b.id, a.id])
  })

  it('renames a project', () => {
    const p = db.projects.create({ mode: 'write', name: 'Draft' })
    const updated = db.projects.update(p.id, { name: 'Final' })
    expect(updated?.name).toBe('Final')
    expect(db.projects.getById(p.id)?.name).toBe('Final')
  })

  it('files a conversation under a project and filters the task list by it', () => {
    const project = db.projects.create({ mode: 'chat', name: 'Grouped' })
    const filed = db.conversations.create({ mode: 'chat', title: 'In', projectRef: project.id })
    db.conversations.create({ mode: 'chat', title: 'Out' })

    expect(db.conversations.getById(filed.id)?.projectRef).toBe(project.id)

    const inProject = db.conversations.list({ mode: 'chat', projectRef: project.id })
    expect(inProject.map((s) => s.id)).toEqual([filed.id])
    expect(inProject[0]?.projectRef).toBe(project.id)

    // No filter -> every task in the mode, filed or not.
    expect(db.conversations.list({ mode: 'chat' })).toHaveLength(2)
  })

  it('re-files a conversation via update', () => {
    const p1 = db.projects.create({ mode: 'chat', name: 'One' })
    const p2 = db.projects.create({ mode: 'chat', name: 'Two' })
    const conv = db.conversations.create({ mode: 'chat', projectRef: p1.id })

    const moved = db.conversations.update(conv.id, { projectRef: p2.id })
    expect(moved?.projectRef).toBe(p2.id)

    const unfiled = db.conversations.update(conv.id, { projectRef: null })
    expect(unfiled?.projectRef).toBeNull()
  })

  it('bulk deleteAll clears conversations (cascading messages), projects and workspaces', () => {
    const project = db.projects.create({ mode: 'chat', name: 'P' })
    const conv = db.conversations.create({ mode: 'chat', title: 'C', projectRef: project.id })
    db.messages.insert({
      id: 'm1',
      conversationId: conv.id,
      role: 'user',
      content: 'hello',
      status: 'complete',
      seq: 1,
      createdAt: 0,
    })
    const ws = db.workspaces.create({ name: 'W' })
    db.workspaces.itemCreate({ workspaceId: ws.id, kind: 'note', title: 'N', origin: 'user' })

    // Mirrors the data:deleteAllContent IPC handler.
    db.driver.transaction(() => {
      db.conversations.deleteAll()
      db.workspaces.deleteAll()
      db.projects.deleteAll()
    })

    expect(db.conversations.list()).toHaveLength(0)
    expect(db.messages.listByConversation(conv.id)).toHaveLength(0)
    expect(db.projects.list()).toHaveLength(0)
    expect(db.workspaces.list()).toHaveLength(0)
    expect(db.workspaces.itemsList(ws.id)).toHaveLength(0)
  })

  it('deleting a project unfiles its tasks instead of deleting them', () => {
    const project = db.projects.create({ mode: 'code', name: 'Doomed' })
    const conv = db.conversations.create({ mode: 'code', title: 'Survivor', projectRef: project.id })

    db.projects.remove(project.id)

    expect(db.projects.getById(project.id)).toBeNull()
    // The conversation still exists, just unfiled.
    const still = db.conversations.getById(conv.id)
    expect(still).not.toBeNull()
    expect(still?.projectRef).toBeNull()
  })
})
