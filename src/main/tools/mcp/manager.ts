/**
 * MCP manager: owns connections to user-configured MCP servers, exposes their
 * discovered tools to the shared tool registry (namespaced 'mcp__<key>__<tool>')
 * and routes tool calls back to the right server. Connections spawn only on
 * explicit enable and are torn down on quit. Secret env/headers are decrypted
 * here (main only) and never leave the process.
 */

import type {
  McpConnectionStatus,
  McpDiscoveredTool,
  McpServerConfig,
  McpServerInput,
  McpServerPatch,
  McpServerRuntime,
  ToolDefinition,
} from '@shared/types'
import type { AppDatabase } from '../../db/database'
import type { Keystore } from '../../keys/keystore'
import { redactKnownSecrets } from '../../providers/redact'
import { TOOL_RESULT_MAX_CHARS } from '../definitions'
import { namespaceMcpToolId } from './naming'
import { defaultMcpConnector, type McpConnection, type McpConnector } from './transports'

interface ServerState {
  status: McpConnectionStatus
  error: string | null
  connection: McpConnection | null
  /** Discovered tools with their namespaced ids. */
  tools: Array<{ toolId: string; name: string; description: string; schema: Record<string, unknown> }>
  /** Decrypted secret values for redacting results. */
  secretValues: string[]
}

export interface McpManagerDeps {
  db: AppDatabase
  keystore: Pick<Keystore, 'decryptKey' | 'encryptKey'>
  broadcast: (channel: string, payload: unknown) => void
  /** Fired (channel) whenever server runtime state changes. */
  changedChannel: string
  /** Injectable connector; defaults to the real SDK-backed one. */
  connector?: McpConnector
}

export class McpManager {
  private readonly states = new Map<string, ServerState>()
  /** toolId -> { serverId, originalName } (authoritative for execution). */
  private readonly reverse = new Map<string, { serverId: string; name: string }>()
  private readonly connector: McpConnector

  constructor(private readonly deps: McpManagerDeps) {
    this.connector = deps.connector ?? defaultMcpConnector
  }

  // -- secrets ---------------------------------------------------------------

  private decryptSecrets(serverId: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const cipher of this.deps.db.secrets.listCiphers('mcp_server', serverId)) {
      try {
        out[cipher.name] = this.deps.keystore.decryptKey(cipher.encryptedValue)
      } catch {
        // skip an undecryptable secret rather than failing the connection
      }
    }
    return out
  }

  private configWithSecretNames(config: McpServerConfig): McpServerConfig {
    return {
      ...config,
      secretNames: this.deps.db.secrets.listNames('mcp_server', config.id).map((s) => s.name),
    }
  }

  // -- connection lifecycle --------------------------------------------------

  private clearServerTools(serverId: string): void {
    const state = this.states.get(serverId)
    if (!state) return
    for (const tool of state.tools) this.reverse.delete(tool.toolId)
    state.tools = []
  }

  private async disconnect(serverId: string): Promise<void> {
    const state = this.states.get(serverId)
    if (!state) return
    this.clearServerTools(serverId)
    const conn = state.connection
    state.connection = null
    state.status = 'disconnected'
    state.error = null
    if (conn) {
      try {
        await conn.close()
      } catch {
        // best-effort teardown
      }
    }
  }

  private async connect(config: McpServerConfig): Promise<void> {
    // Reset any prior state for this server.
    await this.disconnect(config.id)
    const secrets = this.decryptSecrets(config.id)
    const state: ServerState = {
      status: 'connecting',
      error: null,
      connection: null,
      tools: [],
      secretValues: Object.values(secrets),
    }
    this.states.set(config.id, state)

    try {
      const connection = await this.connector(config, secrets)
      // Track the connection BEFORE listTools so that if discovery fails, the
      // catch (and disconnect/stopAll) can still close the already-spawned
      // transport/stdio child — otherwise it leaks as a zombie process that
      // multiplies on every reconnect.
      state.connection = connection
      const discovered = await connection.listTools()
      state.tools = discovered.map((tool) => {
        const toolId = namespaceMcpToolId(config.key, tool.name)
        this.reverse.set(toolId, { serverId: config.id, name: tool.name })
        return { toolId, name: tool.name, description: tool.description, schema: tool.inputSchema }
      })
      state.status = 'connected'
      state.error = null
    } catch (e) {
      // Close the transport if it came up before the failure (see above).
      if (state.connection) {
        try {
          await state.connection.close()
        } catch {
          // best-effort teardown
        }
        state.connection = null
      }
      state.status = 'error'
      // Redact: the message may echo the request URL or an auth header value,
      // and this string is broadcast to the renderer via getRuntime().
      state.error = redactKnownSecrets(e instanceof Error ? e.message : String(e), state.secretValues)
    }
  }

  // -- registry + executor surface -------------------------------------------

  /** ToolDefinitions for every connected server's tools (for the registry). */
  listToolDefinitions(isEnabled: (toolId: string) => boolean): ToolDefinition[] {
    const defs: ToolDefinition[] = []
    for (const state of this.states.values()) {
      if (state.status !== 'connected') continue
      for (const tool of state.tools) {
        defs.push({
          id: tool.toolId,
          name: tool.toolId,
          description: tool.description || `MCP tool ${tool.name}`,
          parameters:
            typeof tool.schema === 'object' && tool.schema
              ? tool.schema
              : { type: 'object', properties: {} },
          risk: 'sensitive',
          builtin: false,
          enabled: isEnabled(tool.toolId),
          source: 'mcp',
        })
      }
    }
    return defs
  }

  /** Executes an MCP tool call and returns a capped, redacted string result. */
  async callTool(toolId: string, args: Record<string, unknown>): Promise<string> {
    const ref = this.reverse.get(toolId)
    if (!ref) return `Error: MCP tool '${toolId}' is no longer available.`
    const state = this.states.get(ref.serverId)
    if (!state || state.status !== 'connected' || !state.connection) {
      return `Error: the MCP server for '${toolId}' is not connected.`
    }
    let raw: { content: string; isError: boolean }
    try {
      raw = await state.connection.callTool(ref.name, args)
    } catch (e) {
      return redactKnownSecrets(
        `Error calling MCP tool '${ref.name}': ${e instanceof Error ? e.message : String(e)}`,
        state.secretValues
      )
    }
    const body = raw.isError ? `Tool reported an error:\n${raw.content}` : raw.content
    const capped =
      body.length > TOOL_RESULT_MAX_CHARS ? `${body.slice(0, TOOL_RESULT_MAX_CHARS)}\n…[truncated]` : body
    return redactKnownSecrets(capped, state.secretValues)
  }

  // -- runtime + config queries ----------------------------------------------

  getRuntime(): McpServerRuntime[] {
    return this.deps.db.mcpServers.list().map((config) => {
      const state = this.states.get(config.id)
      const tools: McpDiscoveredTool[] = (state?.tools ?? []).map((t) => ({
        toolId: t.toolId,
        name: t.name,
        description: t.description,
      }))
      return {
        id: config.id,
        status: state?.status ?? 'disconnected',
        error: state?.error ?? null,
        toolCount: tools.length,
        tools,
      }
    })
  }

  list(): McpServerConfig[] {
    return this.deps.db.mcpServers.list().map((c) => this.configWithSecretNames(c))
  }

  private storeSecrets(serverId: string, secrets: Record<string, string> | undefined): void {
    if (!secrets) return
    for (const [name, value] of Object.entries(secrets)) {
      if (value.length === 0) continue
      const { encryptedBase64, preview } = this.deps.keystore.encryptKey(value)
      this.deps.db.secrets.set('mcp_server', serverId, name, encryptedBase64, preview)
    }
  }

  private notifyChanged(): void {
    try {
      this.deps.broadcast(this.deps.changedChannel, this.getRuntime())
    } catch {
      // a window may be gone; ignore
    }
  }

  // -- CRUD ------------------------------------------------------------------

  async create(input: McpServerInput): Promise<McpServerConfig[]> {
    const config = this.deps.db.mcpServers.create({
      name: input.name.trim(),
      transport: input.transport,
      command: input.command ?? null,
      args: input.args ?? [],
      env: input.env ?? {},
      url: input.url ?? null,
      headers: input.headers ?? {},
      enabled: input.enabled ?? true,
    })
    this.storeSecrets(config.id, input.setSecrets)
    if (config.enabled) await this.connect(this.configWithSecretNames(config))
    this.notifyChanged()
    return this.list()
  }

  async update(id: string, patch: McpServerPatch): Promise<McpServerConfig[]> {
    const updated = this.deps.db.mcpServers.update(id, {
      name: patch.name,
      command: patch.command,
      args: patch.args,
      env: patch.env,
      url: patch.url,
      headers: patch.headers,
      enabled: patch.enabled,
    })
    if (!updated) throw new Error('MCP server not found.')
    for (const name of patch.deleteSecrets ?? []) {
      this.deps.db.secrets.remove('mcp_server', id, name)
    }
    this.storeSecrets(id, patch.setSecrets)
    if (updated.enabled) await this.connect(this.configWithSecretNames(updated))
    else await this.disconnect(id)
    this.notifyChanged()
    return this.list()
  }

  async remove(id: string): Promise<McpServerConfig[]> {
    await this.disconnect(id)
    this.states.delete(id)
    this.deps.db.secrets.deleteAllFor('mcp_server', id)
    this.deps.db.mcpServers.remove(id)
    this.notifyChanged()
    return this.list()
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServerConfig[]> {
    this.deps.db.mcpServers.setEnabled(id, enabled)
    const config = this.deps.db.mcpServers.getById(id)
    if (config && enabled) await this.connect(this.configWithSecretNames(config))
    else await this.disconnect(id)
    this.notifyChanged()
    return this.list()
  }

  async reconnect(id: string): Promise<McpServerRuntime[]> {
    const config = this.deps.db.mcpServers.getById(id)
    if (config && config.enabled) await this.connect(this.configWithSecretNames(config))
    this.notifyChanged()
    return this.getRuntime()
  }

  // -- lifecycle -------------------------------------------------------------

  /** Connect all enabled servers in parallel. Skipped under SMOKE_TEST. */
  async start(): Promise<void> {
    if (process.env.SMOKE_TEST === '1') return
    const enabled = this.deps.db.mcpServers.list().filter((c) => c.enabled)
    await Promise.allSettled(enabled.map((c) => this.connect(this.configWithSecretNames(c))))
    this.notifyChanged()
  }

  /** Close every connection (kills stdio children). Called on quit. */
  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.states.keys()].map((id) => this.disconnect(id)))
  }
}
