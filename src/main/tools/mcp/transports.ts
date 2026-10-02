/**
 * Real MCP connector: wraps the official @modelcontextprotocol/sdk Client +
 * transport behind the small `McpConnection` interface the manager uses, so the
 * manager's logic stays SDK-agnostic and testable (tests inject a fake
 * connector). stdio and Streamable HTTP (with header auth) are supported.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { McpServerConfig } from '@shared/types'

export { UnauthorizedError }

export interface McpDiscovered {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** MCP tool annotation readOnlyHint === true (the server says it only reads). */
  readOnly?: boolean
}

export interface McpConnection {
  listTools(): Promise<McpDiscovered[]>
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>
  close(): Promise<void>
}

/** Creates and connects a real MCP client for the given server config. */
export type McpConnector = (
  config: McpServerConfig,
  secrets: Record<string, string>,
  /** v53: OAuth for remote connectors (http only). */
  opts?: { authProvider?: OAuthClientProvider }
) => Promise<McpConnection>

const CLIENT_INFO = { name: 'grasberg', version: '0.1.0' }
const CONNECT_TIMEOUT_MS = 15_000

function flattenContent(result: unknown): { content: string; isError: boolean } {
  const r = (result ?? {}) as { content?: unknown; isError?: boolean }
  const parts: string[] = []
  if (Array.isArray(r.content)) {
    for (const part of r.content as Array<Record<string, unknown>>) {
      if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
      else if (part && typeof part.text === 'string') parts.push(part.text)
      else parts.push(JSON.stringify(part))
    }
  }
  return { content: parts.join('\n'), isError: r.isError === true }
}

/**
 * Connects over Streamable HTTP, falling back to the legacy HTTP+SSE
 * transport (many hosted connectors still expose /sse). An OAuth challenge
 * is never treated as a transport mismatch: UnauthorizedError propagates.
 */
async function connectHttp(
  config: McpServerConfig,
  secrets: Record<string, string>,
  authProvider: OAuthClientProvider | undefined
): Promise<{ client: Client; transport: StreamableHTTPClientTransport | SSEClientTransport }> {
  const url = new URL(config.url ?? '')
  const requestInit = { headers: { ...config.headers, ...secrets } }
  const auth = authProvider ? { authProvider } : {}
  const first = new Client(CLIENT_INFO)
  const streamable = new StreamableHTTPClientTransport(url, { requestInit, ...auth })
  try {
    await first.connect(streamable, { timeout: CONNECT_TIMEOUT_MS })
    return { client: first, transport: streamable }
  } catch (e) {
    if (e instanceof UnauthorizedError) throw Object.assign(e, { transport: streamable })
    await first.close().catch(() => undefined)
    const fallback = new Client(CLIENT_INFO)
    const sse = new SSEClientTransport(url, { requestInit, ...auth })
    try {
      await fallback.connect(sse, { timeout: CONNECT_TIMEOUT_MS })
      return { client: fallback, transport: sse }
    } catch (sseError) {
      if (sseError instanceof UnauthorizedError) throw Object.assign(sseError, { transport: sse })
      // Report the Streamable HTTP failure: it is the modern transport.
      throw e
    }
  }
}

/**
 * Interactive OAuth sign-in (v53): connects with an interactive provider.
 * Returns null when the server let us in without a sign-in; otherwise the
 * provider has opened the browser, and `finish(code)` exchanges the code the
 * loopback redirect delivered.
 */
export async function beginMcpOAuth(
  config: McpServerConfig,
  secrets: Record<string, string>,
  authProvider: OAuthClientProvider
): Promise<{ finish(code: string): Promise<void> } | null> {
  try {
    const { client } = await connectHttp(config, secrets, authProvider)
    await client.close().catch(() => undefined)
    return null
  } catch (e) {
    const transport = (e as { transport?: { finishAuth(code: string): Promise<void> } }).transport
    if (e instanceof UnauthorizedError && transport) {
      return { finish: (code) => transport.finishAuth(code) }
    }
    throw e
  }
}

export const defaultMcpConnector: McpConnector = async (config, secrets, opts) => {
  let client: Client
  if (config.transport === 'stdio') {
    client = new Client(CLIENT_INFO)
    const transport = new StdioClientTransport({
      command: config.command ?? '',
      args: config.args,
      // Secrets go in env, never argv.
      env: { ...config.env, ...secrets } as Record<string, string>,
      stderr: 'ignore',
    })
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
  } else {
    client = (await connectHttp(config, secrets, opts?.authProvider)).client
  }

  return {
    async listTools() {
      const out: McpDiscovered[] = []
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined)
        for (const tool of page.tools ?? []) {
          out.push({
            name: tool.name,
            description: typeof tool.description === 'string' ? tool.description : '',
            inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {
              type: 'object',
              properties: {},
            },
            readOnly:
              (tool as { annotations?: { readOnlyHint?: unknown } }).annotations?.readOnlyHint ===
              true,
          })
        }
        cursor = page.nextCursor
      } while (cursor)
      return out
    },
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args })
      return flattenContent(result)
    },
    async close() {
      await client.close()
    },
  }
}
