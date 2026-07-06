/**
 * Real MCP connector: wraps the official @modelcontextprotocol/sdk Client +
 * transport behind the small `McpConnection` interface the manager uses, so the
 * manager's logic stays SDK-agnostic and testable (tests inject a fake
 * connector). stdio and Streamable HTTP (with header auth) are supported.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig } from '@shared/types'

export interface McpDiscovered {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpConnection {
  listTools(): Promise<McpDiscovered[]>
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>
  close(): Promise<void>
}

/** Creates and connects a real MCP client for the given server config. */
export type McpConnector = (
  config: McpServerConfig,
  secrets: Record<string, string>
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

export const defaultMcpConnector: McpConnector = async (config, secrets) => {
  const client = new Client(CLIENT_INFO)

  const transport =
    config.transport === 'stdio'
      ? new StdioClientTransport({
          command: config.command ?? '',
          args: config.args,
          // Secrets go in env, never argv.
          env: { ...config.env, ...secrets } as Record<string, string>,
          stderr: 'ignore',
        })
      : new StreamableHTTPClientTransport(new URL(config.url ?? ''), {
          requestInit: { headers: { ...config.headers, ...secrets } },
        })

  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })

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
