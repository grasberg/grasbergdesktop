import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import { open } from '../../../src/main/db/driver'
import { MIGRATIONS } from '../../../src/main/db/migrations'
import { ToolRegistry } from '../../../src/main/tools/registry'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../src/main/tools/definitions'

let dir: string
let dbFile: string
let db: AppDatabase | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-tools-registry-'))
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

describe('ToolRegistry.listDefinitions', () => {
  it('lists all builtins enabled by default with the specified risk levels', () => {
    const registry = new ToolRegistry(db!)
    const definitions = registry.listDefinitions()

    // Shell execution/browser tools are off by default and no skills are
    // installed, so run_shell_command, browser, computer and use_skill are
    // not listed.
    expect(definitions.map((d) => d.id)).toEqual([
      'file_search',
      'repo_map',
      'read_file',
      'list_directory',
      'grep',
      'glob',
      'git',
      'fetch_url',
      'web_search',
      'git_write',
      'propose_shell_command',
      'edit_file',
      'write_file',
      'knowledge_search',
      'delegate',
      'task_output',
      'task_stop',
      'update_task_list',
      'ask_user_question',
      'schedule_task',
    ])
    for (const def of definitions) {
      expect(def.builtin).toBe(true)
      expect(def.enabled).toBe(true)
    }
    const byId = new Map(definitions.map((d) => [d.id, d]))
    expect(byId.get('repo_map')!.risk).toBe('sensitive')
    expect(byId.get('delegate')!.risk).toBe('safe')
    expect(byId.get('file_search')!.risk).toBe('sensitive')
    expect(byId.get('read_file')!.risk).toBe('sensitive')
    expect(byId.get('list_directory')!.risk).toBe('sensitive')
    expect(byId.get('fetch_url')!.risk).toBe('sensitive')
    expect(byId.get('propose_shell_command')!.risk).toBe('safe')
    // New tools: searches stay sensitive, project writes are dangerous
    // (per-call approval), pure app-state tools are safe.
    expect(byId.get('grep')!.risk).toBe('sensitive')
    expect(byId.get('git')!.risk).toBe('sensitive')
    expect(byId.get('web_search')!.risk).toBe('sensitive')
    expect(byId.get('edit_file')!.risk).toBe('dangerous')
    expect(byId.get('write_file')!.risk).toBe('dangerous')
    expect(byId.get('update_task_list')!.risk).toBe('safe')
    expect(byId.get('ask_user_question')!.risk).toBe('safe')
  })

  it('merges per-tool enabled flags from the database', () => {
    const registry = new ToolRegistry(db!)
    registry.setEnabled('fetch_url', false)

    const definitions = registry.listDefinitions()
    expect(definitions.find((d) => d.id === 'fetch_url')!.enabled).toBe(false)
    expect(definitions.find((d) => d.id === 'read_file')!.enabled).toBe(true)
    expect(registry.listEnabledDefinitions().map((d) => d.id)).not.toContain('fetch_url')

    registry.setEnabled('fetch_url', true)
    expect(registry.getById('fetch_url')!.enabled).toBe(true)
  })

  it('rejects enabling/permission-setting unknown tools', () => {
    const registry = new ToolRegistry(db!)
    expect(() => registry.setEnabled('nope', false)).toThrow(/unknown tool/i)
    expect(() => registry.setPermission('nope', 'deny')).toThrow(/unknown tool/i)
  })
})

describe('ToolRegistry permissions', () => {
  it("defaults to 'ask' for sensitive tools and 'always_allow' for safe tools", () => {
    // Enable shell/browser, seed a skill and point at an image provider so
    // every builtin is listed (run_shell_command, browser/computer, use_skill
    // and generate_image are hidden otherwise).
    db!.settings.update({
      shellExecutionEnabled: true,
      browserToolsEnabled: true,
      defaultImageProviderId: 'img-provider',
    })
    db!.skills.create({ name: 'demo', content: 'Demo instructions.' })
    const registry = new ToolRegistry(db!)
    const permissions = new Map(registry.listPermissions().map((p) => [p.toolId, p]))

    for (const def of BUILTIN_TOOL_DEFINITIONS) {
      const expected = def.risk === 'safe' ? 'always_allow' : 'ask'
      expect(permissions.get(def.id)!.decision).toBe(expected)
      // updatedAt 0 marks "default, not chosen by the user".
      expect(permissions.get(def.id)!.updatedAt).toBe(0)
    }
  })

  it('stored decisions override the risk-based default', () => {
    const registry = new ToolRegistry(db!)
    registry.setPermission('read_file', 'deny')
    registry.setPermission('propose_shell_command', 'ask')

    const permissions = new Map(registry.listPermissions().map((p) => [p.toolId, p]))
    expect(permissions.get('read_file')!.decision).toBe('deny')
    expect(permissions.get('read_file')!.updatedAt).toBeGreaterThan(0)
    expect(permissions.get('propose_shell_command')!.decision).toBe('ask')

    expect(registry.getPermission(registry.getById('read_file')!)).toBe('deny')
    expect(registry.getPermission(registry.getById('fetch_url')!)).toBe('ask')
  })
})

describe('ToolRegistry custom tools', () => {
  it('add/list/resolve/remove roundtrip with the fixed mapping', () => {
    db!.settings.update({
      shellExecutionEnabled: true,
      browserToolsEnabled: true,
      defaultImageProviderId: 'img-provider',
    })
    db!.skills.create({ name: 'demo', content: 'Demo instructions.' })
    const registry = new ToolRegistry(db!)
    const definition = registry.addCustomTool({
      name: 'weather_lookup',
      description: 'Look up the weather.',
      baseUrl: 'https://api.example.com/weather',
      method: 'get',
      headers: { 'x-api-key': 'secret-value-123' },
      paramsSchema: { type: 'object', properties: { city: { type: 'string' } } },
    })

    expect(definition.id.startsWith('custom:')).toBe(true)
    expect(definition).toMatchObject({
      name: 'weather_lookup',
      risk: 'sensitive',
      builtin: false,
      enabled: true,
    })

    const listed = registry.listDefinitions()
    expect(listed).toHaveLength(BUILTIN_TOOL_DEFINITIONS.length + 1)
    expect(listed.find((d) => d.id === definition.id)).toBeDefined()

    // Custom tools default to 'ask' (sensitive).
    const permission = registry.listPermissions().find((p) => p.toolId === definition.id)
    expect(permission!.decision).toBe('ask')

    // Model-issued calls resolve by name.
    expect(registry.resolveForCall('weather_lookup')!.id).toBe(definition.id)
    // The executor can retrieve the raw record.
    const record = registry.getCustomToolRecord(definition.id)!
    expect(record.method).toBe('GET')
    expect(record.baseUrl).toBe('https://api.example.com/weather')

    registry.removeCustomTool(definition.id)
    expect(registry.getById(definition.id)).toBeNull()
    expect(registry.listDefinitions()).toHaveLength(BUILTIN_TOOL_DEFINITIONS.length)
  })

  it('validates custom tool input', () => {
    const registry = new ToolRegistry(db!)
    expect(() =>
      registry.addCustomTool({ name: 'bad name!', baseUrl: 'https://example.com' })
    ).toThrow(/name/i)
    expect(() =>
      registry.addCustomTool({ name: 'ok_tool', baseUrl: 'http://example.com' })
    ).toThrow(/https/i)
    expect(() =>
      registry.addCustomTool({ name: 'ok_tool', baseUrl: 'https://example.com', method: 'TRACE' })
    ).toThrow(/method/i)
    // http is fine for localhost (local dev endpoints).
    const local = registry.addCustomTool({ name: 'local_tool', baseUrl: 'http://localhost:8080' })
    expect(local.risk).toBe('sensitive')
  })

  it('updates a custom tool and reports its details (secret headers excluded)', () => {
    const registry = new ToolRegistry(db!)
    const def = registry.addCustomTool({
      name: 'weather',
      baseUrl: 'https://api.example.com/v1',
      method: 'get',
      headers: { accept: 'application/json' },
    })
    // A stored secret header (encryption happens in the IPC layer; here we
    // insert an already-encrypted blob directly, as the DB tests do).
    db!.secrets.set('custom_tool', def.id.slice('custom:'.length), 'x-api-key', 'insecure:abc', 'sk-…key')

    const updated = registry.updateCustomTool(def.id, {
      description: 'Current weather.',
      method: 'POST',
      baseUrl: 'https://api.example.com/v2',
    })
    expect(updated).toMatchObject({ name: 'weather', description: 'Current weather.' })

    const infos = registry.listCustomToolInfos()
    expect(infos).toHaveLength(1)
    const info = infos[0]
    expect(info.id).toBe(def.id)
    expect(info.method).toBe('POST')
    expect(info.baseUrl).toBe('https://api.example.com/v2')
    expect(info.headers).toEqual({ accept: 'application/json' })
    // Secret header appears by NAME + preview only — never its value.
    expect(info.secretHeaders).toEqual([{ name: 'x-api-key', preview: 'sk-…key' }])
    expect(JSON.stringify(info)).not.toContain('insecure:abc')
  })

  it('rejects updating a non-custom tool', () => {
    const registry = new ToolRegistry(db!)
    expect(() => registry.updateCustomTool('read_file', { description: 'x' })).toThrow(/custom/i)
  })
})

describe('migration v2 (custom_tools)', () => {
  it('applies on reopen of a v1 database and enables custom tool CRUD', () => {
    db!.close()
    db = null
    rmSync(dbFile, { force: true })

    // Build a genuine v1 database by hand: only migration 1, version '1'.
    const v1 = open(dbFile)
    const migrationV1 = MIGRATIONS.find((m) => m.version === 1)!
    for (const statement of migrationV1.statements) v1.exec(statement)
    v1.run("INSERT INTO meta (key, value) VALUES ('schema_version', '1')")
    expect(
      v1.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'custom_tools'"
      )
    ).toBeUndefined()
    v1.close()

    // Reopening through openDatabase must apply migration v2.
    db = openDatabase(dbFile)
    const version = db.driver.get<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    )!.value
    expect(Number.parseInt(version, 10)).toBeGreaterThanOrEqual(2)

    const created = db.customTools.create({
      name: 'ping',
      description: 'Ping a service.',
      baseUrl: 'https://example.com/ping',
      method: 'GET',
      headersJson: '{}',
      paramsSchemaJson: '{"type":"object","properties":{}}',
    })
    expect(db.customTools.getById(created.id)).toMatchObject({
      name: 'ping',
      baseUrl: 'https://example.com/ping',
    })

    // Survives a reopen without re-running migrations.
    db.close()
    db = openDatabase(dbFile)
    expect(db.customTools.list().map((t) => t.id)).toEqual([created.id])

    db.customTools.remove(created.id)
    expect(db.customTools.list()).toHaveLength(0)
  })
})

describe('migration v4 (tool_secrets)', () => {
  it('applies on reopen of a v3 database and enables secret CRUD', () => {
    db!.close()
    db = null
    rmSync(dbFile, { force: true })

    // Build a v3 database by hand (migrations 1..3), version '3'.
    const v3 = open(dbFile)
    for (const migration of MIGRATIONS.filter((m) => m.version <= 3)) {
      for (const statement of migration.statements) v3.exec(statement)
    }
    v3.run("INSERT INTO meta (key, value) VALUES ('schema_version', '3')")
    expect(
      v3.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tool_secrets'"
      )
    ).toBeUndefined()
    v3.close()

    db = openDatabase(dbFile)
    const version = db.driver.get<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    )!.value
    expect(Number.parseInt(version, 10)).toBeGreaterThanOrEqual(4)

    db.secrets.set('custom_tool', 'owner-1', 'authorization', 'insecure:dG9r', 'Bea…tok')
    db.secrets.set('mcp_server', 'srv-1', 'X-Key', 'insecure:aaa', 'sk-…aaa')

    // listNames never returns the ciphertext.
    const names = db.secrets.listNames('custom_tool', 'owner-1')
    expect(names).toEqual([{ name: 'authorization', preview: 'Bea…tok', updatedAt: expect.any(Number) }])

    // listCiphers exposes ciphertext for main-side decryption.
    expect(db.secrets.listCiphers('custom_tool', 'owner-1')).toEqual([
      { name: 'authorization', encryptedValue: 'insecure:dG9r' },
    ])
    // Scoping isolates owners.
    expect(db.secrets.listNames('mcp_server', 'srv-1').map((s) => s.name)).toEqual(['X-Key'])

    db.secrets.remove('custom_tool', 'owner-1', 'authorization')
    expect(db.secrets.listNames('custom_tool', 'owner-1')).toHaveLength(0)

    db.secrets.set('custom_tool', 'owner-2', 'a', 'insecure:1', 'p1')
    db.secrets.set('custom_tool', 'owner-2', 'b', 'insecure:2', 'p2')
    db.secrets.deleteAllFor('custom_tool', 'owner-2')
    expect(db.secrets.listNames('custom_tool', 'owner-2')).toHaveLength(0)
  })
})
