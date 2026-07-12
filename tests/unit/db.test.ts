import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Message, type MessageStatus } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { open } from '../../src/main/db/driver'
import { MIGRATIONS } from '../../src/main/db/migrations'

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

/**
 * Hand-build a v24 database holding one chat conversation, its message and a
 * project, then drop `projects.name` — the column the v25 FK-safe rebuild copies.
 * v25 therefore fails mid-rebuild, AFTER `conversations` was dropped and renamed.
 */
function seedFailingV24Database(): string {
  db?.close()
  db = null
  rmSync(dbFile, { force: true })

  const v24 = open(dbFile)
  for (const migration of MIGRATIONS.filter((m) => m.version <= 24)) {
    for (const statement of migration.statements) v24.exec(statement)
  }
  const now = Date.now()
  const conversationId = randomUUID()
  v24.run(
    `INSERT INTO conversations (id, mode, title, params_json, created_at, updated_at)
     VALUES (?, 'chat', 'Kept', '{}', ?, ?)`,
    [conversationId, now, now]
  )
  v24.run(
    `INSERT INTO messages (id, conversation_id, role, content, seq, created_at)
     VALUES (?, ?, 'user', 'hello', 1, ?)`,
    [randomUUID(), conversationId, now]
  )
  v24.run(
    `INSERT INTO projects (id, mode, name, created_at, updated_at)
     VALUES ('proj-1', 'chat', 'Docs', ?, ?)`,
    [now, now]
  )
  v24.run("INSERT INTO meta (key, value) VALUES ('schema_version', '24')")
  v24.exec('ALTER TABLE projects DROP COLUMN name')
  v24.close()
  return conversationId
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

  it('rolls a failing FK-safe rebuild back atomically and re-runs it cleanly', () => {
    const conversationId = seedFailingV24Database()

    expect(() => openDatabase(dbFile)).toThrow()

    const broken = open(dbFile)
    // Nothing of the half-run rebuild survives: no *_new leftovers (which would
    // make every later launch fail with "table conversations_new already
    // exists"), the version is untouched and the children were never wiped.
    expect(
      broken.all("SELECT name FROM sqlite_master WHERE name IN ('conversations_new','projects_new')")
    ).toHaveLength(0)
    expect(
      broken.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")!.value
    ).toBe('24')
    expect(broken.all('SELECT id FROM conversations')).toHaveLength(1)
    expect(broken.all('SELECT id FROM messages')).toHaveLength(1)
    // The pre-migration snapshot is there as a last resort.
    expect(existsSync(`${dbFile}.pre-v24.bak`)).toBe(true)

    broken.run(`ALTER TABLE projects ADD COLUMN name TEXT NOT NULL DEFAULT 'Docs'`)
    broken.close()

    db = openDatabase(dbFile)
    const version = db.driver.get<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    )!.value
    expect(Number.parseInt(version, 10)).toBeGreaterThanOrEqual(25)
    expect(db.messages.listByConversation(conversationId)).toHaveLength(1)
    expect(db.projects.getById('proj-1')?.name).toBe('Docs')
    // Snapshot removed once the upgrade completed.
    expect(existsSync(`${dbFile}.pre-v24.bak`)).toBe(false)
  })

  it('never overwrites an existing pre-migration snapshot', () => {
    seedFailingV24Database()
    const snapshot = `${dbFile}.pre-v24.bak`
    // Stands in for the snapshot taken before an earlier, failed attempt at the
    // same upgrade — it must survive the retry untouched.
    writeFileSync(snapshot, 'SENTINEL')

    expect(() => openDatabase(dbFile)).toThrow()
    expect(readFileSync(snapshot, 'utf8')).toBe('SENTINEL')
  })
})

describe('driver transactions', () => {
  const provider = {
    id: 'prov-1',
    type: 'deepseek' as const,
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModelId: 'deepseek-chat',
  }

  it('re-enters: a repository transaction runs inside a composed one', () => {
    db!.providers.create(provider)
    db!.settings.update({ defaultProviderId: 'prov-1', defaultModelId: 'deepseek-chat' })

    // The providersDelete composition: settings.update() opens its own transaction.
    db!.driver.transaction(() => {
      db!.settings.update({ defaultProviderId: null, defaultModelId: null })
      db!.conversations.clearProvider('prov-1')
      db!.providers.remove('prov-1')
    })

    expect(db!.providers.getById('prov-1')).toBeNull()
    expect(db!.settings.get().defaultProviderId).toBeNull()
  })

  it('rolls the whole composition back when it throws after a nested transaction', () => {
    db!.settings.update({ theme: 'light' })

    expect(() =>
      db!.driver.transaction(() => {
        db!.settings.update({ theme: 'dark' })
        db!.providers.create(provider)
        throw new Error('boom')
      })
    ).toThrow('boom')

    expect(db!.settings.get().theme).toBe('light')
    expect(db!.providers.getById('prov-1')).toBeNull()
  })

  it('undoes only the inner level when the outer catches a nested failure', () => {
    db!.driver.transaction(() => {
      db!.providers.create(provider)
      try {
        db!.driver.transaction(() => {
          db!.providers.create({ ...provider, id: 'prov-2', label: 'Doomed' })
          throw new Error('inner')
        })
      } catch {
        // swallowed on purpose — the outer transaction must still commit
      }
    })

    expect(db!.providers.getById('prov-1')?.label).toBe('DeepSeek')
    expect(db!.providers.getById('prov-2')).toBeNull()
  })
})

describe('agent platform repository', () => {
  it('persists agent runs and checkpoints across reopen', () => {
    const conversation = db!.conversations.create({ mode: 'work', title: 'Agent task' })
    const run = db!.agentPlatform.runStart({
      conversationId: conversation.id,
      projectId: null,
      agentName: 'reviewer',
      task: 'Review the patch',
      worktreePath: null,
      providerId: null,
      modelId: null,
    })
    db!.agentPlatform.runFinish(run.id, 'done', 'Looks good')
    const checkpoint = db!.agentPlatform.checkpointCreate({
      conversationId: conversation.id,
      projectId: 'project-1',
      changeId: 'change-1',
      label: 'Before edit',
      messageSeq: 4,
      files: [{ relPath: 'src/app.ts', content: 'old' }],
    })

    const re = reopen()
    expect(re.agentPlatform.runsList(conversation.id)[0]).toMatchObject({
      id: run.id,
      status: 'done',
      result: 'Looks good',
    })
    expect(re.agentPlatform.checkpointGet(checkpoint.id)).toMatchObject({
      messageSeq: 4,
      files: [{ relPath: 'src/app.ts', content: 'old' }],
    })
  })

  it('checkpointsListLite returns file paths without the snapshots', () => {
    const conversation = db!.conversations.create({ mode: 'work', title: 'Agent task' })
    db!.agentPlatform.checkpointCreate({
      conversationId: conversation.id,
      projectId: 'project-1',
      changeId: null,
      label: 'Before edit',
      messageSeq: 2,
      files: [
        { relPath: 'src/app.ts', content: 'x'.repeat(5000) },
        { relPath: 'README.md', content: null },
      ],
    })

    const listed = db!.agentPlatform.checkpointsListLite(conversation.id)
    expect(listed).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        label: 'Before edit',
        filePaths: ['src/app.ts', 'README.md'],
      }),
    ])
    expect(JSON.stringify(listed)).not.toContain('xxxx')
  })

  it("markDanglingRunsAsStopped finishes runs left 'running' by a crash", () => {
    const conversation = db!.conversations.create({ mode: 'work', title: 'Agent task' })
    const start = (task: string) =>
      db!.agentPlatform.runStart({
        conversationId: conversation.id,
        projectId: null,
        agentName: null,
        task,
        worktreePath: null,
        providerId: null,
        modelId: null,
      })
    const done = start('finished')
    db!.agentPlatform.runFinish(done.id, 'done', 'ok')
    start('interrupted')

    expect(db!.agentPlatform.markDanglingRunsAsStopped()).toBe(1)
    const runs = db!.agentPlatform.runsList(conversation.id)
    expect(runs.find((r) => r.task === 'interrupted')).toMatchObject({ status: 'stopped' })
    expect(runs.find((r) => r.task === 'interrupted')!.finishedAt).not.toBeNull()
    expect(runs.find((r) => r.task === 'finished')).toMatchObject({ status: 'done', result: 'ok' })
    expect(db!.agentPlatform.markDanglingRunsAsStopped()).toBe(0)
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

  it('supports new provider types and an auth mode', () => {
    const oai = db!.providers.create({
      id: 'prov-oai',
      type: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      defaultModelId: 'gpt-4o',
      authMode: 'chatgpt_oauth',
    })
    expect(oai).toMatchObject({ type: 'openai', authMode: 'chatgpt_oauth', oauthConnected: false })

    const zai = db!.providers.create({
      id: 'prov-zai',
      type: 'zai-coding',
      label: 'Z.ai Coding',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      defaultModelId: 'glm-4.6',
    })
    // Auth mode defaults to api_key when omitted.
    expect(zai.authMode).toBe('api_key')
  })

  it('stores + clears an OAuth session (token-free status derived)', () => {
    db!.providers.create({
      id: 'prov-oai',
      type: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      defaultModelId: 'gpt-4o',
      authMode: 'chatgpt_oauth',
    })
    db!.providers.setOAuthRow({
      providerId: 'prov-oai',
      encryptedAccess: 'QUNDRVNT',
      encryptedRefresh: 'UkVGUkVTSA==',
      accountId: 'acct_123',
      accountLabel: 'user@example.com',
      expiresAt: 1234567890,
    })

    const withOauth = db!.providers.getById('prov-oai')!
    expect(withOauth.oauthConnected).toBe(true)
    expect(withOauth.oauthAccountLabel).toBe('user@example.com')

    const row = db!.providers.getOAuthRow('prov-oai')!
    expect(row).toMatchObject({ encryptedAccess: 'QUNDRVNT', accountId: 'acct_123', expiresAt: 1234567890 })

    db!.providers.deleteOAuthRow('prov-oai')
    expect(db!.providers.getOAuthRow('prov-oai')).toBeNull()
    expect(db!.providers.getById('prov-oai')!.oauthConnected).toBe(false)
  })

  it('migration v11 rebuilds providers FK-safely, preserving keys', () => {
    db!.close()
    db = null
    rmSync(dbFile, { force: true })

    // Build a v10 database by hand, then seed a provider + its key row.
    const v10 = open(dbFile)
    for (const migration of MIGRATIONS.filter((m) => m.version <= 10)) {
      for (const statement of migration.statements) v10.exec(statement)
    }
    v10.run("INSERT INTO meta (key, value) VALUES ('schema_version', '10')")
    const now = Date.now()
    v10.run(
      `INSERT INTO providers (id, type, label, base_url, default_model_id, enabled, extra_json, created_at, updated_at)
       VALUES ('p1', 'deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', 'deepseek-chat', 1, '{}', ?, ?)`,
      [now, now]
    )
    v10.run(
      `INSERT INTO provider_keys (provider_id, encrypted_key, key_preview, updated_at)
       VALUES ('p1', 'RU5DUllQVEVE', 'sk-…4f2a', ?)`,
      [now]
    )
    v10.close()

    // Reopen: applies v11 (rebuild) + v12. The key row must survive the rebuild.
    db = openDatabase(dbFile)
    const version = db.driver.get<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    )!.value
    expect(Number.parseInt(version, 10)).toBeGreaterThanOrEqual(12)

    const p1 = db.providers.getById('p1')!
    expect(p1).toMatchObject({ type: 'deepseek', authMode: 'api_key', hasKey: true, keyPreview: 'sk-…4f2a' })
    expect(db.providers.getEncryptedKey('p1')).toBe('RU5DUllQVEVE')
  })

  it('migration v13 rebuilds providers, preserving keys AND oauth; adds preset_id', () => {
    db!.close()
    db = null
    rmSync(dbFile, { force: true })

    // Build a v12 database by hand with a provider that has BOTH a key row and
    // an oauth row (both cascade), to prove the FK-safe rebuild preserves both.
    const v12 = open(dbFile)
    for (const migration of MIGRATIONS.filter((m) => m.version <= 12)) {
      for (const statement of migration.statements) v12.exec(statement)
    }
    v12.run("INSERT INTO meta (key, value) VALUES ('schema_version', '12')")
    const now = Date.now()
    v12.run(
      `INSERT INTO providers (id, type, label, base_url, default_model_id, enabled, extra_json, auth_mode, created_at, updated_at)
       VALUES ('p1', 'openai', 'OpenAI', 'https://api.openai.com/v1', 'gpt-4o', 1, '{}', 'chatgpt_oauth', ?, ?)`,
      [now, now]
    )
    v12.run(
      `INSERT INTO provider_keys (provider_id, encrypted_key, key_preview, updated_at) VALUES ('p1', 'RU5DUllQVEVE', 'sk-…4f2a', ?)`,
      [now]
    )
    v12.run(
      `INSERT INTO provider_oauth (provider_id, encrypted_access, encrypted_refresh, account_id, account_label, expires_at, updated_at)
       VALUES ('p1', 'QUND', 'UkVG', 'acct_1', 'a@b.com', 123, ?)`,
      [now]
    )
    v12.close()

    db = openDatabase(dbFile)
    const version = db.driver.get<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    )!.value
    expect(Number.parseInt(version, 10)).toBeGreaterThanOrEqual(13)

    // Both cascading rows survived the rebuild; preset_id defaults to null.
    const p1 = db.providers.getById('p1')!
    expect(p1).toMatchObject({ type: 'openai', authMode: 'chatgpt_oauth', presetId: null, hasKey: true })
    expect(db.providers.getEncryptedKey('p1')).toBe('RU5DUllQVEVE')
    expect(db.providers.getOAuthRow('p1')).toMatchObject({ accountId: 'acct_1', accountLabel: 'a@b.com' })

    // A preset-backed provider round-trips (type openai-compatible + presetId).
    db.providers.create({
      id: 'p2',
      type: 'openai-compatible',
      label: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      defaultModelId: 'llama-3.3-70b-versatile',
      presetId: 'groq',
    })
    expect(db.providers.getById('p2')).toMatchObject({ type: 'openai-compatible', presetId: 'groq' })
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

  it('search folds non-ASCII case in both directions (titles and messages)', () => {
    const a = db!.conversations.create({ mode: 'chat', title: 'Örebro plan' })
    const b = db!.conversations.create({ mode: 'chat', title: 'Städa garaget' })
    const c = db!.conversations.create({ mode: 'chat', title: 'Notes' })
    db!.messages.insert(
      msg(c.id, { role: 'user', content: 'Åka till Ängelholm för Éclair', seq: 1 })
    )

    expect(db!.conversations.list({ search: 'Örebro' }).map((s) => s.id)).toEqual([a.id])
    expect(db!.conversations.list({ search: 'örebro' }).map((s) => s.id)).toEqual([a.id])
    expect(db!.conversations.list({ search: 'STÄDA' }).map((s) => s.id)).toEqual([b.id])
    expect(db!.conversations.list({ search: 'åka' }).map((s) => s.id)).toEqual([c.id])
    expect(db!.conversations.list({ search: 'ängelholm' }).map((s) => s.id)).toEqual([c.id])
    expect(db!.conversations.list({ search: 'éclair' }).map((s) => s.id)).toEqual([c.id])
  })

  it('search treats wildcard characters as literals', () => {
    const a = db!.conversations.create({ mode: 'chat', title: '100% done' })
    db!.conversations.create({ mode: 'chat', title: 'Nothing to see' })
    const b = db!.conversations.create({ mode: 'chat', title: 'star*name [x]' })

    expect(db!.conversations.list({ search: '100%' }).map((s) => s.id)).toEqual([a.id])
    expect(db!.conversations.list({ search: '*' }).map((s) => s.id)).toEqual([b.id])
    expect(db!.conversations.list({ search: '[x]' }).map((s) => s.id)).toEqual([b.id])
    expect(db!.conversations.list({ search: 'a_b' })).toHaveLength(0)
  })

  it('snippets stay capped at 100 chars for very long messages', () => {
    const conv = db!.conversations.create({ mode: 'chat', title: 'Long' })
    db!.messages.insert(msg(conv.id, { role: 'assistant', content: 'r'.repeat(50_000), seq: 1 }))
    const [summary] = db!.conversations.list()
    expect(summary.snippet).toBe('r'.repeat(100))
  })

  it('lastSeq returns the highest seq, or null for an empty conversation', () => {
    const conv = db!.conversations.create({ mode: 'chat' })
    expect(db!.messages.lastSeq(conv.id)).toBeNull()
    db!.messages.insert(msg(conv.id, { role: 'user', content: 'q', seq: 1 }))
    db!.messages.insert(msg(conv.id, { role: 'assistant', content: 'a', seq: 2 }))
    expect(db!.messages.lastSeq(conv.id)).toBe(2)
  })

  it('clearSummary drops the compaction summary', () => {
    const conv = db!.conversations.create({ mode: 'chat' })
    db!.conversations.setSummary(conv.id, 'so far...', 12)
    expect(db!.conversations.getById(conv.id)).toMatchObject({
      summaryText: 'so far...',
      summaryThroughSeq: 12,
    })
    db!.conversations.clearSummary(conv.id)
    expect(db!.conversations.getById(conv.id)).toMatchObject({
      summaryText: null,
      summaryThroughSeq: null,
    })
  })

  it('filters by mode and honors limit', () => {
    db!.conversations.create({ mode: 'chat', title: 'C1' })
    db!.conversations.create({ mode: 'chat', title: 'C2' })
    const cw = db!.conversations.create({ mode: 'work', title: 'W1' })
    expect(db!.conversations.list({ mode: 'work' }).map((s) => s.id)).toEqual([cw.id])
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

describe('code repository', () => {
  function change(projectId: string, filePath: string) {
    return db!.code.changeCreate({
      projectId,
      conversationId: null,
      filePath,
      changeType: 'edit',
      diff: `--- a/${filePath}`,
      newContent: 'n'.repeat(1000),
      oldContent: 'o'.repeat(1000),
    })
  }

  it('changesList omits file bodies but changeGet still returns them', () => {
    const project = db!.code.projectUpsertByPath('/tmp/proj', 'proj')
    const created = change(project.id, 'src/app.ts')

    const [listed] = db!.code.changesList(project.id)
    expect(listed).toMatchObject({
      id: created.id,
      filePath: 'src/app.ts',
      changeType: 'edit',
      status: 'proposed',
      diff: '--- a/src/app.ts',
      newContent: null,
      oldContent: null,
    })

    expect(db!.code.changeGet(created.id)).toMatchObject({
      newContent: 'n'.repeat(1000),
      oldContent: 'o'.repeat(1000),
    })
  })

  it('changesList caps the history at the most recent 200 changes', () => {
    const project = db!.code.projectUpsertByPath('/tmp/proj', 'proj')
    for (let i = 0; i < 205; i++) change(project.id, `src/f${i}.ts`)
    expect(db!.code.changesList(project.id)).toHaveLength(200)
  })
})
