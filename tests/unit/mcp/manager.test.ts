import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import { McpManager } from '../../../src/main/tools/mcp/manager'
import type { McpConnection, McpConnector } from '../../../src/main/tools/mcp/transports'

let dir: string
let db: AppDatabase

// A fake keystore (real one imports electron.safeStorage, unavailable here).
const keystore = {
  encryptKey: (v: string) => ({ encryptedBase64: `x:${Buffer.from(v).toString('base64')}`, preview: '…' }),
  decryptKey: (s: string) => Buffer.from(s.slice(2), 'base64').toString('utf8'),
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-mcp-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A connector that hangs (as a real stdio spawn does) until `release()` is called. */
function slowConnector(): {
  connector: McpConnector
  close: ReturnType<typeof vi.fn>
  started: Promise<void>
  release: () => void
} {
  const close = vi.fn(async () => undefined)
  let release = (): void => undefined
  let markStarted = (): void => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const connector: McpConnector = async () => {
    markStarted()
    await gate
    return {
      listTools: async () => [{ name: 'echo', description: '', inputSchema: {} }],
      callTool: async () => ({ content: 'ok', isError: false }),
      close,
    }
  }
  return { connector, close, started, release }
}

function makeManager(connector: McpConnector): McpManager {
  return new McpManager({
    db,
    keystore,
    broadcast: () => undefined,
    changedChannel: 'push:mcpServersChanged',
    connector,
  })
}

describe('McpManager', () => {
  it('connects, exposes namespaced tools, and routes calls (redacting secrets)', async () => {
    const receivedSecrets: Record<string, string>[] = []
    const callTool = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
      // Echo the secret back — the manager must redact it from the result.
      content: 'result contains topsecret9999',
      isError: false,
    }))
    const connector: McpConnector = async (_config, secrets) => {
      receivedSecrets.push(secrets)
      const conn: McpConnection = {
        listTools: async () => [
          { name: 'echo', description: 'Echo a message.', inputSchema: { type: 'object', properties: {} } },
        ],
        callTool,
        close: async () => undefined,
      }
      return conn
    }
    const manager = makeManager(connector)

    const servers = await manager.create({
      name: 'Test',
      transport: 'stdio',
      command: 'echo',
      args: ['hi'],
      enabled: true,
      setSecrets: { TOKEN: 'topsecret9999' },
    })
    expect(servers).toHaveLength(1)
    expect(servers[0].secretNames).toEqual(['TOKEN']) // name only, no value

    // The decrypted secret reached the connector as an env value.
    expect(receivedSecrets[0]).toEqual({ TOKEN: 'topsecret9999' })

    // A namespaced, enabled tool definition is offered.
    const defs = manager.listToolDefinitions(() => true)
    expect(defs).toHaveLength(1)
    expect(defs[0].id).toMatch(/^mcp__[a-z0-9]+__echo$/)
    expect(defs[0].source).toBe('mcp')
    expect(defs[0].risk).toBe('sensitive')

    // Calling routes to the connection with the ORIGINAL tool name...
    const result = await manager.callTool(defs[0].id, { msg: 'hi' })
    expect(callTool).toHaveBeenCalledWith('echo', { msg: 'hi' })
    // ...and the secret never surfaces in the result.
    expect(result).not.toContain('topsecret9999')
    expect(result).toContain('[redacted]')

    // Runtime reports the connection.
    const runtime = manager.getRuntime()
    expect(runtime[0]).toMatchObject({ status: 'connected', toolCount: 1 })

    await manager.stopAll()
  })

  it('disconnecting a disabled server removes its tools', async () => {
    const connector: McpConnector = async () => ({
      listTools: async () => [{ name: 'echo', description: '', inputSchema: {} }],
      callTool: async () => ({ content: 'ok', isError: false }),
      close: async () => undefined,
    })
    const manager = makeManager(connector)
    const [server] = await manager.create({ name: 'S', transport: 'stdio', command: 'x', enabled: true })
    expect(manager.listToolDefinitions(() => true)).toHaveLength(1)

    await manager.setEnabled(server.id, false)
    expect(manager.listToolDefinitions(() => true)).toHaveLength(0)
    expect(manager.getRuntime()[0].status).toBe('disconnected')
  })

  it('surfaces a connection error without throwing', async () => {
    const connector: McpConnector = async () => {
      throw new Error('spawn failed')
    }
    const manager = makeManager(connector)
    await manager.create({ name: 'Broken', transport: 'stdio', command: 'nope', enabled: true })
    const runtime = manager.getRuntime()
    expect(runtime[0].status).toBe('error')
    expect(runtime[0].error).toContain('spawn failed')
    expect(manager.listToolDefinitions(() => true)).toHaveLength(0)
  })

  it('closes a connection whose server was removed while it was coming up', async () => {
    // remove() lands while the connector is still spawning the child: the
    // resulting connection belongs to no tracked state, so connect() must close
    // it — otherwise the stdio child outlives the app as a zombie.
    const { connector, close, started, release } = slowConnector()
    const manager = makeManager(connector)

    const created = manager.create({ name: 'Slow', transport: 'stdio', command: 'x', enabled: true })
    await started
    const removed = manager.remove(db.mcpServers.list()[0].id)
    release()
    await Promise.all([created, removed])

    expect(close).toHaveBeenCalledTimes(1)
    expect(manager.listToolDefinitions(() => true)).toHaveLength(0)
  })

  it('closes a connection whose server was disabled while it was coming up', async () => {
    const { connector, close, started, release } = slowConnector()
    const manager = makeManager(connector)

    const created = manager.create({ name: 'Slow', transport: 'stdio', command: 'x', enabled: true })
    await started
    const disabled = manager.setEnabled(db.mcpServers.list()[0].id, false)
    release()
    await Promise.all([created, disabled])

    expect(close).toHaveBeenCalledTimes(1)
    expect(manager.getRuntime()[0].status).toBe('disconnected')
    expect(manager.listToolDefinitions(() => true)).toHaveLength(0)
  })

  it('created the mcp_servers table (migration v7)', () => {
    expect(
      db.driver.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_servers'"
      )
    ).toBeDefined()
  })
})
