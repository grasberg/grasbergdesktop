/**
 * The notebook tools (list_documents / read_document / edit_document) through
 * the real executor choke point: safe reads run without approval, edits are
 * approval-gated + versioned, posture gates (plan mode, read-only sandbox)
 * refuse the mutating tool, and every call lands in the activity log.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, ToolApprovalAnswer, ToolCallRecord } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import { createToolSystem, USER_DECLINED_RESULT } from '../../../src/main/tools'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-doc-tools-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
})

function conv(): Conversation {
  return {
    id: 'conv-1',
    mode: 'chat',
    title: 'Test',
    providerId: null,
    modelId: null,
    systemPrompt: null,
    params: {},
    workspaceId: null,
    projectId: null,
    projectRef: null,
    moaPresetId: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

function call(name: string, args: unknown = {}): ToolCallRecord {
  return {
    id: 'tc-1',
    name,
    arguments: JSON.stringify(args),
    status: 'proposed',
  }
}

const APPROVE: ToolApprovalAnswer = { approved: true, scope: 'once' }
const DECLINE: ToolApprovalAnswer = { approved: false, scope: 'once' }

describe('list_documents + read_document (safe reads)', () => {
  it('run without the approval dialog and resolve titles case-insensitively', async () => {
    db.documents.create({ title: 'Shopping List', content: 'milk' })
    const { executor } = createToolSystem(db)
    const approval = vi.fn(async () => APPROVE)

    const listed = await executor.execute(call('list_documents'), {
      conversation: conv(),
      approval,
    })
    expect(listed).toContain('Shopping List')

    const read = await executor.execute(call('read_document', { title: 'shopping list' }), {
      conversation: conv(),
      approval,
    })
    expect(read).toContain('milk')
    expect(approval).not.toHaveBeenCalled()
  })

  it('returns error strings for a missing target and an unknown id', async () => {
    const { executor } = createToolSystem(db)
    const approval = vi.fn(async () => APPROVE)

    expect(
      await executor.execute(call('read_document'), { conversation: conv(), approval })
    ).toMatch(/provide 'id' or 'title'/i)
    expect(
      await executor.execute(call('read_document', { id: 'nope' }), {
        conversation: conv(),
        approval,
      })
    ).toMatch(/no notebook with id 'nope'/i)
    expect(
      await executor.execute(call('list_documents'), { conversation: conv(), approval })
    ).toMatch(/no notebooks exist yet/i)
  })
})

describe('edit_document (approval-gated, versioned)', () => {
  it('declined leaves nothing behind; approved creates then versions a replace', async () => {
    const onDocumentsChanged = vi.fn()
    const { executor } = createToolSystem(db, null, { onDocumentsChanged })

    const declined = await executor.execute(
      call('edit_document', { title: 'Plan', content: 'v1' }),
      { conversation: conv(), approval: vi.fn(async () => DECLINE) }
    )
    expect(declined).toBe(USER_DECLINED_RESULT)
    expect(db.documents.list()).toHaveLength(0)
    expect(onDocumentsChanged).not.toHaveBeenCalled()

    const approval = vi.fn(async () => APPROVE)
    const created = await executor.execute(
      call('edit_document', { title: 'Plan', content: 'v1' }),
      { conversation: conv(), approval }
    )
    expect(created).toMatch(/created notebook "Plan"/i)
    const doc = db.documents.findByTitle('plan')!
    expect(doc.conversationId).toBeNull()
    expect(doc.kind).toBe('doc')
    expect(onDocumentsChanged).toHaveBeenCalledTimes(1)

    // Same title (different case) replaces the content and snapshots v1.
    const updated = await executor.execute(
      call('edit_document', { title: 'plan', content: 'v2' }),
      { conversation: conv(), approval }
    )
    expect(updated).toMatch(/updated notebook/i)
    expect(updated).toMatch(/saved as a version/i)
    expect(db.documents.getById(doc.id)?.content).toBe('v2')
    const versions = db.documents.listVersions(doc.id)
    expect(versions).toHaveLength(1)
    expect(versions[0].content).toBe('v1')
    expect(onDocumentsChanged).toHaveBeenCalledTimes(2)
    expect(approval).toHaveBeenCalledTimes(2)
    // The case-insensitive match must never rename the notebook: the stored
    // title survives an edit_document call spelled differently.
    expect(db.documents.getById(doc.id)?.title).toBe('Plan')
  })

  it('id-targeted edits replace content only — the stored title survives', async () => {
    const { executor } = createToolSystem(db)
    const doc = db.documents.create({ title: 'Q3 Marketing Plan', content: 'v1' })
    const result = await executor.execute(
      call('edit_document', { id: doc.id, title: 'Marketing Plan', content: 'v2' }),
      { conversation: conv(), approval: vi.fn(async () => APPROVE) }
    )
    expect(result).toMatch(/updated notebook/i)
    const stored = db.documents.getById(doc.id)!
    expect(stored.content).toBe('v2')
    expect(stored.title).toBe('Q3 Marketing Plan')
  })

  it('an explicit unknown id errors without creating', async () => {
    const { executor } = createToolSystem(db)
    const result = await executor.execute(
      call('edit_document', { id: 'ghost', title: 'X', content: 'y' }),
      { conversation: conv(), approval: vi.fn(async () => APPROVE) }
    )
    expect(result).toMatch(/no notebook with id 'ghost'/i)
    expect(db.documents.list()).toHaveLength(0)
  })

  it('refuses oversize content without writing', async () => {
    const { executor } = createToolSystem(db)
    const result = await executor.execute(
      call('edit_document', { title: 'Big', content: 'x'.repeat(200_001) }),
      { conversation: conv(), approval: vi.fn(async () => APPROVE) }
    )
    expect(result).toMatch(/at most 200000 characters/i)
    expect(db.documents.list()).toHaveLength(0)
  })

  it('is blocked in plan mode and in the read-only sandbox (mutating)', async () => {
    const { executor } = createToolSystem(db)
    const approval = vi.fn(async () => APPROVE)

    const planned = await executor.execute(
      call('edit_document', { title: 'Plan', content: 'x' }),
      { conversation: conv(), approval, planMode: true }
    )
    expect(planned).toMatch(/plan mode/i)

    const readOnly = await executor.execute(
      call('edit_document', { title: 'Plan', content: 'x' }),
      { conversation: conv(), approval, sandboxLevel: 'read-only' }
    )
    expect(readOnly).toMatch(/read-only/i)

    expect(db.documents.list()).toHaveLength(0)
    expect(approval).not.toHaveBeenCalled()

    // The safe reads still run under both postures.
    const listed = await executor.execute(call('list_documents'), {
      conversation: conv(),
      approval,
      sandboxLevel: 'read-only',
    })
    expect(listed).toMatch(/no notebooks exist yet/i)
  })

  it('shows a main-computed approval note naming the target', async () => {
    db.documents.create({ title: 'Plan', content: 'old' })
    const { executor } = createToolSystem(db)
    const approval = vi.fn(async () => APPROVE)
    await executor.execute(call('edit_document', { title: 'Plan', content: 'newer' }), {
      conversation: conv(),
      approval,
    })
    expect(approval).toHaveBeenCalledWith(
      expect.objectContaining({
        note: expect.stringContaining('Replaces the content of notebook "Plan"'),
      })
    )
  })
})

describe('activity log (executor choke point)', () => {
  it("records the edit as 'approved' and the reads as 'auto'", async () => {
    const { executor } = createToolSystem(db)
    const approval = vi.fn(async () => APPROVE)

    await executor.execute(call('edit_document', { title: 'Note', content: 'x' }), {
      conversation: conv(),
      approval,
    })
    await executor.execute(call('list_documents'), { conversation: conv(), approval })
    await executor.execute(call('read_document', { title: 'Note' }), {
      conversation: conv(),
      approval,
    })

    const entries = db.activity.list().entries
    const byTool = new Map(entries.map((entry) => [entry.toolId, entry]))
    expect(byTool.get('edit_document')?.decision).toBe('approved')
    expect(byTool.get('list_documents')?.decision).toBe('auto')
    expect(byTool.get('read_document')?.decision).toBe('auto')
  })
})
