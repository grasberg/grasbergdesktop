import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Message, type MessageStatus } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'

let dir: string
let dbFile: string
let db: AppDatabase | null = null

function reopen(): AppDatabase {
  db?.close()
  db = openDatabase(dbFile)
  return db
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-db-test-'))
  dbFile = join(dir, 'app.db')
  db = openDatabase(dbFile)
})

afterEach(() => {
  try {
    db?.close()
  } catch {
    // already closed by the test
  }
  db = null
  rmSync(dir, { recursive: true, force: true })
})

function msg(
  conversationId: string,
  overrides: Partial<Message> & { seq: number; role: Message['role'] }
): Message {
  return {
    id: randomUUID(),
    conversationId,
    content: '',
    status: 'complete' as MessageStatus,
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('openDatabase + migrations', () => {
  it('creates the file and records the schema version in meta', () => {
    expect(existsSync(dbFile)).toBe(true)
    const row = db!.driver.get<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    )
    expect(row).toBeDefined()
    expect(Number.parseInt(row!.value, 10)).toBeGreaterThanOrEqual(1)
  })

  it('reopening the same file keeps data and does not re-apply migrations', () => {
    const versionBefore = db!.driver.get<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    )!.value
    db!.providers.create({
      id: 'p1',
      type: 'deepseek',
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      defaultModelId: 'deepseek-chat',
    })

    const re = reopen()
    const versionAfter = re.driver.get<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    )!.value
    expect(versionAfter).toBe(versionBefore)
    expect(re.providers.getById('p1')?.label).toBe('DeepSeek')
    // Exactly one schema_version row — never duplicated by reopen.
    const metaRows = re.driver.all<{ key: string }>(
      "SELECT key FROM meta WHERE key = 'schema_version'"
    )
    expect(metaRows).toHaveLength(1)
  })
})

describe('providers repository', () => {
  const input = {
    id: 'prov-1',
    type: 'zhipu' as const,
    label: 'GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModelId: 'glm-4.5-flash',
  }

  it('create/list/update/remove roundtrip', () => {
    const created = db!.providers.create(input)
    expect(created).toMatchObject({
      id: 'prov-1',
      type: 'zhipu',
      label: 'GLM',
      enabled: true,
      hasKey: false,
      keyPreview: null,
    })
    expect(created.createdAt).toBeGreaterThan(0)

    expect(db!.providers.list().map((p) => p.id)).toContain('prov-1')

    const updated = db!.providers.update('prov-1', { label: 'GLM (edited)', enabled: false })
    expect(updated).toMatchObject({ label: 'GLM (edited)', enabled: false })
    expect(db!.providers.update('missing-id', { label: 'x' })).toBeNull()

    db!.providers.remove('prov-1')
    expect(db!.providers.getById('prov-1')).toBeNull()
    expect(db!.providers.list()).toHaveLength(0)
  })

  it('setKeyRow surfaces hasKey + keyPreview; deleteKeyRow reverts', () => {
    db!.providers.create(input)
    db!.providers.setKeyRow('prov-1', 'RU5DUllQVEVE', 'sk-…4f2a')

    const withKey = db!.providers.list().find((p) => p.id === 'prov-1')!
    expect(withKey.hasKey).toBe(true)
    expect(withKey.keyPreview).toBe('sk-…4f2a')
    expect(db!.providers.getEncryptedKey('prov-1')).toBe('RU5DUllQVEVE')

    // Upsert replaces the row in place.
    db!.providers.setKeyRow('prov-1', 'TkVXS0VZ', 'sk-…9z9z')
    expect(db!.providers.getEncryptedKey('prov-1')).toBe('TkVXS0VZ')
    expect(db!.providers.getById('prov-1')!.keyPreview).toBe('sk-…9z9z')

    db!.providers.deleteKeyRow('prov-1')
    const withoutKey = db!.providers.getById('prov-1')!
    expect(withoutKey.hasKey).toBe(false)
    expect(withoutKey.keyPreview).toBeNull()
    expect(db!.providers.getEncryptedKey('prov-1')).toBeNull()
  })

  it('removing a provider cascades its key row', () => {
    db!.providers.create(input)
    db!.providers.setKeyRow('prov-1', 'RU5DUllQVEVE', 'sk-…4f2a')
    db!.providers.remove('prov-1')
    expect(db!.providers.getEncryptedKey('prov-1')).toBeNull()
  })
})

describe('conversations + messages', () => {
  it('creates conversations and inserts messages with nextSeq, listed in seq order', () => {
    const conv = db!.conversations.create({ mode: 'chat', title: 'Test chat' })
    expect(db!.conversations.getById(conv.id)).toMatchObject({ title: 'Test chat', mode: 'chat' })

    expect(db!.messages.nextSeq(conv.id)).toBe(1)
    db!.messages.insert(msg(conv.id, { role: 'user', content: 'Question?', seq: 1 }))
    expect(db!.messages.nextSeq(conv.id)).toBe(2)
    db!.messages.insert(msg(conv.id, { role: 'assistant', content: 'Answer.', seq: 2 }))

    const listed = db!.messages.listByConversation(conv.id)
    expect(listed.map((m) => [m.seq, m.role, m.content])).toEqual([
      [1, 'user', 'Question?'],
      [2, 'assistant', 'Answer.'],
    ])
  })

  it('list orders by updatedAt desc and computes snippets from the latest message', () => {
    const a = db!.conversations.create({ mode: 'chat', title: 'Alpha' })
    const b = db!.conversations.create({ mode: 'chat', title: 'Beta' })
    const longContent = `  Hello\n\n world ${'x'.repeat(200)}`
    db!.messages.insert(msg(a.id, { role: 'user', content: longContent, seq: 1 }))
    db!.conversations.touch(a.id, 1000)
    db!.conversations.touch(b.id, 2000)

    let summaries = db!.conversations.list()
    expect(summaries.map((s) => s.id)).toEqual([b.id, a.id])
    const aSummary = summaries.find((s) => s.id === a.id)!
    // Whitespace collapsed, trimmed, capped at 100 chars.
    expect(aSummary.snippet!.startsWith('Hello world x')).toBe(true)
    expect(aSummary.snippet!.length).toBe(100)
    expect(summaries.find((s) => s.id === b.id)!.snippet).toBeNull()

    db!.conversations.touch(a.id, 3000)
    summaries = db!.conversations.list()
    expect(summaries.map((s) => s.id)).toEqual([a.id, b.id])
  })

  it('search matches message content as well as titles', () => {
    const a = db!.conversations.create({ mode: 'chat', title: 'Groceries' })
    const b = db!.conversations.create({ mode: 'chat', title: 'Work notes' })
    db!.messages.insert(msg(a.id, { role: 'user', content: 'the quantum banana is ripe', seq: 1 }))
    db!.messages.insert(msg(b.id, { role: 'user', content: 'quarterly report draft', seq: 1 }))

    expect(db!.conversations.list({ search: 'quantum banana' }).map((s) => s.id)).toEqual([a.id])
    expect(db!.conversations.list({ search: 'Work notes' }).map((s) => s.id)).toEqual([b.id])
    expect(db!.conversations.list({ search: 'no such thing' })).toHaveLength(0)
  })

  it('filters by mode and honors limit', () => {
    db!.conversations.create({ mode: 'chat', title: 'C1' })
    db!.conversations.create({ mode: 'chat', title: 'C2' })
    const cw = db!.conversations.create({ mode: 'cowork', title: 'W1' })
    expect(db!.conversations.list({ mode: 'cowork' }).map((s) => s.id)).toEqual([cw.id])
    expect(db!.conversations.list({ limit: 2 })).toHaveLength(2)
  })

  it('deleteAfterSeq removes only later messages (edit-and-rerun)', () => {
    const conv = db!.conversations.create({ mode: 'chat' })
    for (let seq = 1; seq <= 4; seq++) {
      db!.messages.insert(msg(conv.id, { role: seq % 2 ? 'user' : 'assistant', content: `m${seq}`, seq }))
    }
    const removed = db!.messages.deleteAfterSeq(conv.id, 2)
    expect(removed).toBe(2)
    expect(db!.messages.listByConversation(conv.id).map((m) => m.seq)).toEqual([1, 2])
  })

  it("markDanglingStreamingAsStopped flips 'streaming' to 'stopped'", () => {
    const conv = db!.conversations.create({ mode: 'chat' })
    db!.messages.insert(msg(conv.id, { role: 'user', content: 'q', seq: 1 }))
    db!.messages.insert(
      msg(conv.id, { role: 'assistant', content: 'partial', seq: 2, status: 'streaming' })
    )
    const fixed = db!.messages.markDanglingStreamingAsStopped()
    expect(fixed).toBe(1)
    const statuses = db!.messages.listByConversation(conv.id).map((m) => m.status)
    expect(statuses).toEqual(['complete', 'stopped'])
  })

  it('deleting a conversation cascades its messages', () => {
    const conv = db!.conversations.create({ mode: 'chat' })
    db!.messages.insert(msg(conv.id, { role: 'user', content: 'bye', seq: 1 }))
    db!.conversations.remove(conv.id)
    expect(db!.conversations.getById(conv.id)).toBeNull()
    expect(db!.messages.listByConversation(conv.id)).toHaveLength(0)
  })

  it('persists structured message fields (usage, error, toolCalls) as JSON', () => {
    const conv = db!.conversations.create({ mode: 'chat' })
    db!.messages.insert(
      msg(conv.id, {
        role: 'assistant',
        content: 'done',
        seq: 1,
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        toolCalls: [{ id: 'c1', name: 'f', arguments: '{}', status: 'done' }],
      })
    )
    const [stored] = db!.messages.listByConversation(conv.id)
    expect(stored.usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 })
    expect(stored.toolCalls).toEqual([{ id: 'c1', name: 'f', arguments: '{}', status: 'done' }])
  })
})

describe('settings repository', () => {
  it('returns DEFAULT_SETTINGS on an empty database', () => {
    expect(db!.settings.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('update persists a patch and merges it over defaults', () => {
    const updated = db!.settings.update({ theme: 'dark', defaultParams: { temperature: 0.5 } })
    expect(updated.theme).toBe('dark')
    expect(updated.defaultParams).toEqual({ temperature: 0.5 })
    // Untouched fields keep their defaults.
    expect(updated.fontSize).toBe(DEFAULT_SETTINGS.fontSize)
    expect(updated.telemetryEnabled).toBe(DEFAULT_SETTINGS.telemetryEnabled)

    // A later patch does not clobber earlier ones.
    const again = db!.settings.update({ fontSize: 'large' })
    expect(again.theme).toBe('dark')
    expect(again.fontSize).toBe('large')

    // Survives a reopen.
    const re = reopen()
    const persisted = re.settings.get()
    expect(persisted.theme).toBe('dark')
    expect(persisted.fontSize).toBe('large')
    expect(persisted.defaultParams).toEqual({ temperature: 0.5 })
  })
})
