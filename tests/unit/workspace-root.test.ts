/**
 * WorkspaceRootService over a real temp db: lazy per-task folder creation
 * (idempotent, linked via conversation.projectId), and deletion that only
 * ever touches auto-created workspace paths — never user-granted folders.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { WorkspaceRootService } from '../../src/main/code/workspace-root'

let dir: string
let db: AppDatabase
let service: WorkspaceRootService
let workspacesBase: string
let grantedDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-workspace-root-'))
  db = openDatabase(join(dir, 'app.db'))
  workspacesBase = join(dir, 'workspaces')
  grantedDir = join(dir, 'granted-project')
  service = new WorkspaceRootService(db, workspacesBase)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ensure', () => {
  it('creates the folder, registers it and links the conversation once', () => {
    const conv = db.conversations.create({ mode: 'work', title: 'Build a page' })
    const first = service.ensure(conv.id)

    expect(first.root).toBe(join(workspacesBase, conv.id))
    expect(existsSync(first.root)).toBe(true)
    expect(db.code.projectGetById(first.projectId)?.path).toBe(first.root)
    expect(db.conversations.getById(conv.id)?.projectId).toBe(first.projectId)

    // Idempotent: a second call returns the same link, creates nothing new.
    const second = service.ensure(conv.id)
    expect(second).toEqual(first)
    expect(db.code.projectsList()).toHaveLength(1)
  })

  it('returns an already-linked (user-granted) folder untouched', () => {
    rmSync(grantedDir, { recursive: true, force: true })
    const granted = db.code.projectUpsertByPath(grantedDir, 'Granted')
    const conv = db.conversations.create({ mode: 'work', title: 'On my repo' })
    db.conversations.update(conv.id, { projectId: granted.id })

    const result = service.ensure(conv.id)
    expect(result.projectId).toBe(granted.id)
    expect(result.root).toBe(grantedDir)
    // No auto folder was created for it.
    expect(existsSync(join(workspacesBase, conv.id))).toBe(false)
  })
})

describe('isAutoPath', () => {
  it('accepts paths under the base and rejects everything else', () => {
    expect(service.isAutoPath(join(workspacesBase, 'abc'))).toBe(true)
    expect(service.isAutoPath(workspacesBase)).toBe(true)
    expect(service.isAutoPath(grantedDir)).toBe(false)
    // Prefix trickery: a sibling dir sharing the base as a name prefix.
    expect(service.isAutoPath(`${workspacesBase}-evil`)).toBe(false)
  })
})

describe('deleteIfAutoRegistered', () => {
  it('removes the auto workspace dir and row (changes cascade)', () => {
    const conv = db.conversations.create({ mode: 'work', title: 'Doomed' })
    const { projectId, root } = service.ensure(conv.id)
    db.code.changeCreate({
      projectId,
      conversationId: conv.id,
      filePath: 'a.txt',
      changeType: 'create',
      diff: '',
      newContent: 'x',
      oldContent: null,
    })

    service.deleteIfAutoRegistered(db.conversations.getById(conv.id)!)

    expect(existsSync(root)).toBe(false)
    expect(db.code.projectGetById(projectId)).toBeNull()
    expect(db.code.changesList(projectId)).toHaveLength(0)
  })

  it('never touches a user-granted folder', () => {
    const granted = db.code.projectUpsertByPath(grantedDir, 'Granted')
    const conv = db.conversations.create({ mode: 'work', title: 'On my repo' })
    db.conversations.update(conv.id, { projectId: granted.id })

    service.deleteIfAutoRegistered(db.conversations.getById(conv.id)!)

    expect(db.code.projectGetById(granted.id)).not.toBeNull()
  })
})

describe('deleteAll', () => {
  it('sweeps every auto workspace but keeps grants', () => {
    const a = db.conversations.create({ mode: 'work', title: 'A' })
    const b = db.conversations.create({ mode: 'work', title: 'B' })
    const rootA = service.ensure(a.id)
    const rootB = service.ensure(b.id)
    const granted = db.code.projectUpsertByPath(grantedDir, 'Granted')

    service.deleteAll()

    expect(existsSync(rootA.root)).toBe(false)
    expect(existsSync(rootB.root)).toBe(false)
    expect(db.code.projectGetById(rootA.projectId)).toBeNull()
    expect(db.code.projectGetById(rootB.projectId)).toBeNull()
    expect(db.code.projectGetById(granted.id)).not.toBeNull()
  })
})
