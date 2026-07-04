import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, ToolCallRecord } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import {
  createToolSystem,
  USER_DECLINED_RESULT,
  type ToolCodeService,
} from '../../../src/main/tools'

let dir: string
let db: AppDatabase
let projectDir: string
let projectId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-tools-executor-'))
  db = openDatabase(join(dir, 'app.db'))

  // A granted project folder with a couple of files...
  projectDir = join(dir, 'project')
  mkdirSync(join(projectDir, 'src'), { recursive: true })
  writeFileSync(join(projectDir, 'alpha.txt'), 'hello world\nthe needle is here\n')
  writeFileSync(join(projectDir, 'src', 'beta.ts'), 'export const value = 42\n')
  projectId = db.code.projectUpsertByPath(projectDir, 'project').id

  // ...and a file OUTSIDE the granted root that must stay unreachable.
  writeFileSync(join(dir, 'outside-secret.txt'), 'TOP SECRET')
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
})

function conv(withProject: boolean): Conversation {
  return {
    id: 'conv-1',
    mode: 'code',
    title: 'Test',
    providerId: null,
    modelId: null,
    systemPrompt: null,
    params: {},
    workspaceId: null,
    projectId: withProject ? projectId : null,
    createdAt: 0,
    updatedAt: 0,
  }
}

function call(name: string, args: unknown = {}): ToolCallRecord {
  return {
    id: 'tc-1',
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
    status: 'proposed',
  }
}

const approveAll = vi.fn(async () => true)

describe('ToolExecutor — resolution and validation', () => {
  it('returns an error string (never throws) for unknown tools', async () => {
    const { executor } = createToolSystem(db)
    const result = await executor.execute(call('does_not_exist'), {
      conversation: conv(true),
      approval: approveAll,
    })
    expect(result).toMatch(/unknown tool 'does_not_exist'/i)
  })

  it('returns an error string for malformed JSON arguments', async () => {
    const { executor } = createToolSystem(db)
    const result = await executor.execute(call('read_file', '{not json'), {
      conversation: conv(true),
      approval: approveAll,
    })
    expect(result).toMatch(/not valid JSON/i)
  })

  it('returns an error string when required arguments are missing', async () => {
    const { executor } = createToolSystem(db)
    const result = await executor.execute(call('file_search', {}), {
      conversation: conv(true),
      approval: approveAll,
    })
    expect(result).toMatch(/missing required argument/i)
    expect(result).toContain('query')
  })

  it('refuses disabled tools', async () => {
    const { registry, executor } = createToolSystem(db)
    registry.setEnabled('fetch_url', false)
    const result = await executor.execute(call('fetch_url', { url: 'https://example.com' }), {
      conversation: conv(true),
      approval: approveAll,
    })
    expect(result).toMatch(/disabled/i)
  })
})

describe('ToolExecutor — permissions', () => {
  it("'deny' short-circuits without asking or running", async () => {
    const { registry, executor } = createToolSystem(db)
    registry.setPermission('file_search', 'deny')
    const approval = vi.fn(async () => true)
    const result = await executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv(true),
      approval,
    })
    expect(result).toMatch(/denied/i)
    expect(result).not.toContain('needle is here')
    expect(approval).not.toHaveBeenCalled()
  })

  it("'ask' + declined returns the standard decline note", async () => {
    const { executor } = createToolSystem(db)
    const approval = vi.fn(async () => false)
    const result = await executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv(true),
      approval,
    })
    expect(result).toBe(USER_DECLINED_RESULT)
    expect(approval).toHaveBeenCalledTimes(1)
  })

  it("'ask' + approved runs the tool and passes risk/conversation to the approval request", async () => {
    const { executor } = createToolSystem(db)
    const approval = vi.fn(async () => true)
    const result = await executor.execute(call('file_search', { query: 'needle' }), {
      conversation: conv(true),
      streamId: 'stream-9',
      approval,
    })
    expect(result).toContain('alpha.txt:2: the needle is here')
    expect(approval).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        streamId: 'stream-9',
        risk: 'sensitive',
        toolCall: expect.objectContaining({ name: 'file_search' }),
      })
    )
  })
})

describe('propose_shell_command — never executes anything', () => {
  it("runs without approval (risk 'safe') and only returns a suggestion note", async () => {
    const { executor } = createToolSystem(db)
    const approval = vi.fn(async () => true)
    const result = await executor.execute(
      call('propose_shell_command', { command: 'rm -rf build', explanation: 'clean build dir' }),
      { conversation: conv(false), approval }
    )
    expect(result).toBe('Command suggested to the user (not executed): rm -rf build')
    // Safe tools default to always_allow — no approval round-trip.
    expect(approval).not.toHaveBeenCalled()
  })

  it('the executor module has no shell-execution import at all', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/main/tools/executor.ts', import.meta.url)),
      'utf8'
    )
    // No import/require of child_process (or any exec/spawn API) exists.
    expect(source).not.toMatch(/(?:from\s*|require\s*\(\s*)['"](?:node:)?child_process['"]/)
    expect(source).not.toMatch(/\b(?:execSync|spawnSync|execFile|spawn)\s*\(/)
  })
})

describe('fetch_url', () => {
  it('rejects non-https URLs without touching the network', async () => {
    const fetchImpl = vi.fn()
    const { executor } = createToolSystem(db, null, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await executor.execute(call('fetch_url', { url: 'http://example.com' }), {
      conversation: conv(false),
      approval: approveAll,
    })
    expect(result).toMatch(/only allows https/i)
    expect(fetchImpl).not.toHaveBeenCalled()

    const garbage = await executor.execute(call('fetch_url', { url: 'not a url' }), {
      conversation: conv(false),
      approval: approveAll,
    })
    expect(garbage).toMatch(/not a valid absolute URL/i)
  })

  it('refuses non-textual content types', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
    )
    const { executor } = createToolSystem(db, null, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await executor.execute(call('fetch_url', { url: 'https://example.com/x.png' }), {
      conversation: conv(false),
      approval: approveAll,
    })
    expect(result).toMatch(/non-textual/i)
    expect(result).toContain('image/png')
  })

  it('returns status plus body for textual responses, capped with a marker', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('a'.repeat(10_000), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
    )
    const { executor } = createToolSystem(db, null, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await executor.execute(call('fetch_url', { url: 'https://example.com' }), {
      conversation: conv(false),
      approval: approveAll,
    })
    expect(result.startsWith('HTTP 200')).toBe(true)
    expect(result.length).toBeLessThanOrEqual(8000 + '\n…[truncated]'.length)
    expect(result.endsWith('…[truncated]')).toBe(true)
    // GET only, no credentials attached.
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe('GET')
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/authorization|cookie/i)
  })
})

describe('project-file tools — root confinement', () => {
  it('file_search and read_file refuse to run without a granted project root', async () => {
    const { executor } = createToolSystem(db)
    for (const toolCall of [
      call('file_search', { query: 'x' }),
      call('read_file', { path: 'alpha.txt' }),
      call('list_directory', {}),
    ]) {
      const result = await executor.execute(toolCall, {
        conversation: conv(false),
        approval: approveAll,
      })
      expect(result).toMatch(/no project folder/i)
    }
  })

  it('rejects path traversal and absolute paths, never reaching the code service', async () => {
    const readFile = vi.fn()
    const codeService: ToolCodeService = {
      readFile: readFile as unknown as ToolCodeService['readFile'],
      fileTree: vi.fn(),
    }
    const { executor } = createToolSystem(db, codeService)

    for (const badPath of ['../outside-secret.txt', '..', join(dir, 'outside-secret.txt')]) {
      const result = await executor.execute(call('read_file', { path: badPath }), {
        conversation: conv(true),
        approval: approveAll,
      })
      expect(result).toMatch(/outside the granted project folder/i)
      expect(result).not.toContain('TOP SECRET')
    }
    expect(readFile).not.toHaveBeenCalled()

    const listing = await executor.execute(call('list_directory', { path: '../..' }), {
      conversation: conv(true),
      approval: approveAll,
    })
    expect(listing).toMatch(/outside the granted project folder/i)
  })

  it('read_file goes through the code service when one is provided', async () => {
    const readFile = vi.fn((_projectId: string, relPath: string) => ({
      relPath,
      content: 'FROM CODE SERVICE',
      truncated: false,
      sizeBytes: 17,
    }))
    const { executor } = createToolSystem(db, { readFile, fileTree: vi.fn() })
    const result = await executor.execute(call('read_file', { path: 'src/beta.ts' }), {
      conversation: conv(true),
      approval: approveAll,
    })
    expect(result).toBe('FROM CODE SERVICE')
    expect(readFile).toHaveBeenCalledWith(projectId, 'src/beta.ts')
  })

  it('read_file falls back to a confined read-only fs read without a code service', async () => {
    const { executor } = createToolSystem(db)
    const result = await executor.execute(call('read_file', { path: 'src/beta.ts' }), {
      conversation: conv(true),
      approval: approveAll,
    })
    expect(result).toBe('export const value = 42\n')
  })

  it('list_directory lists immediate children only, directories marked with /', async () => {
    const { executor } = createToolSystem(db)
    const result = await executor.execute(call('list_directory', {}), {
      conversation: conv(true),
      approval: approveAll,
    })
    const lines = result.split('\n')
    expect(lines[0]).toBe('src/')
    expect(lines[1]).toMatch(/^alpha\.txt \(\d+ bytes\)$/)
    expect(lines).toHaveLength(2)
  })

  it('file_search matches paths as well as content and honors maxResults', async () => {
    const { executor } = createToolSystem(db)
    const byPath = await executor.execute(call('file_search', { query: 'beta' }), {
      conversation: conv(true),
      approval: approveAll,
    })
    expect(byPath.split('\n')).toContain('src/beta.ts')

    const capped = await executor.execute(
      call('file_search', { query: 'e', maxResults: 1 }),
      { conversation: conv(true), approval: approveAll }
    )
    expect(capped.split('\n')).toHaveLength(1)
  })
})

describe('custom HTTP tools', () => {
  it('runs a GET custom tool with args as query params and asks for approval', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    const { registry, executor } = createToolSystem(db, null, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    registry.addCustomTool({
      name: 'echo_tool',
      baseUrl: 'https://api.example.com/echo',
      method: 'GET',
      headers: { 'x-api-key': 'supersecretvalue1234' },
      paramsSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    })

    const approval = vi.fn(async () => true)
    const result = await executor.execute(call('echo_tool', { q: 'hi there' }), {
      conversation: conv(false),
      approval,
    })
    expect(approval).toHaveBeenCalledTimes(1) // sensitive -> ask by default
    expect(result).toContain('HTTP 200')
    expect(result).toContain('{"ok":true}')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.example.com/echo?q=hi+there')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('supersecretvalue1234')
  })

  it('redacts configured header secrets from error results', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom: token supersecretvalue1234 leaked')
    })
    const { registry, executor } = createToolSystem(db, null, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    registry.addCustomTool({
      name: 'leaky_tool',
      baseUrl: 'https://api.example.com/leak',
      headers: { authorization: 'supersecretvalue1234' },
    })
    const result = await executor.execute(call('leaky_tool', {}), {
      conversation: conv(false),
      approval: approveAll,
    })
    expect(result).toMatch(/error calling custom tool/i)
    expect(result).not.toContain('supersecretvalue1234')
    expect(result).toContain('[redacted]')
  })

  it('merges resolved secret headers into the request and redacts them from results', async () => {
    // The response body echoes the secret value back — it must be redacted.
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"seen":"topsecrettoken0001"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    const resolveSecretHeaders = vi.fn(() => ({ authorization: 'topsecrettoken0001' }))
    const { registry, executor } = createToolSystem(db, null, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveSecretHeaders,
    })
    const def = registry.addCustomTool({
      name: 'secret_tool',
      baseUrl: 'https://api.example.com/secret',
      method: 'GET',
      headers: { accept: 'application/json' },
    })

    const result = await executor.execute(call('secret_tool', {}), {
      conversation: conv(false),
      approval: approveAll,
    })

    // The secret header was sent on the wire...
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const sentHeaders = init.headers as Record<string, string>
    expect(sentHeaders.authorization).toBe('topsecrettoken0001')
    expect(sentHeaders.accept).toBe('application/json')
    expect(resolveSecretHeaders).toHaveBeenCalledWith(def.id)
    // ...but never surfaces in the result shown to the model.
    expect(result).toContain('HTTP 200')
    expect(result).not.toContain('topsecrettoken0001')
    expect(result).toContain('[redacted]')
  })
})

describe('MCP tools', () => {
  it('routes an mcp__ tool call to the injected MCP client', async () => {
    const mcpDef = {
      id: 'mcp__srv1__lookup',
      name: 'mcp__srv1__lookup',
      description: 'Look something up.',
      parameters: { type: 'object', properties: {} },
      risk: 'sensitive' as const,
      builtin: false,
      enabled: true,
      source: 'mcp' as const,
    }
    const callTool = vi.fn(async () => 'MCP RESULT')
    const { executor } = createToolSystem(db, null, {
      mcp: { listToolDefinitions: () => [mcpDef], callTool },
    })
    const approval = vi.fn(async () => true)
    const result = await executor.execute(call('mcp__srv1__lookup', { q: 'x' }), {
      conversation: conv(false),
      approval,
    })
    expect(approval).toHaveBeenCalledTimes(1) // sensitive -> ask
    expect(callTool).toHaveBeenCalledWith('mcp__srv1__lookup', { q: 'x' })
    expect(result).toBe('MCP RESULT')
  })
})

describe('repo_map tool', () => {
  it('ranks project files for a query and lists their symbols', async () => {
    const { executor } = createToolSystem(db)
    const result = await executor.execute(call('repo_map', { query: 'value beta' }), {
      conversation: conv(true),
      approval: approveAll,
    })
    expect(result).toContain('repo_map results')
    expect(result).toContain('src/beta.ts')
    expect(result).toContain('value')
  })

  it('refuses to run without a granted project root', async () => {
    const { executor } = createToolSystem(db)
    const result = await executor.execute(call('repo_map', { query: 'x' }), {
      conversation: conv(false),
      approval: approveAll,
    })
    expect(result).toMatch(/no project folder/i)
  })
})
