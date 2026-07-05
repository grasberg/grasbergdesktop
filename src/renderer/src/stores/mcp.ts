/**
 * Zustand store for MCP servers: configs + live connection runtime. Runtime
 * updates arrive both from explicit calls and from the push channel
 * (mcpServersChanged -> App.tsx -> setRuntime).
 */

import { create } from 'zustand'
import type {
  McpServerConfig,
  McpServerInput,
  McpServerPatch,
  McpServerRuntime,
} from '@shared/types'
import { unwrap } from '@/api/uld'
import { toastError } from './ui'

export interface McpStoreState {
  servers: McpServerConfig[]
  /** serverId -> runtime status. */
  runtime: Record<string, McpServerRuntime>
  loaded: boolean
  load(): Promise<void>
  create(input: McpServerInput): Promise<void>
  update(id: string, patch: McpServerPatch): Promise<void>
  remove(id: string): Promise<void>
  setEnabled(id: string, enabled: boolean): Promise<void>
  reconnect(id: string): Promise<void>
  /** Apply a runtime snapshot pushed from main. */
  setRuntime(runtime: McpServerRuntime[]): void
}

function indexRuntime(runtime: McpServerRuntime[]): Record<string, McpServerRuntime> {
  const out: Record<string, McpServerRuntime> = {}
  for (const r of runtime) out[r.id] = r
  return out
}

export const useMcpStore = create<McpStoreState>()((set, get) => {
  /** Applies a mutated config list, then re-syncs configs + runtime. */
  const applyServers = (servers: McpServerConfig[]): void => {
    set({ servers })
    void get().load()
  }

  return {
    servers: [],
    runtime: {},
    loaded: false,

    async load() {
      try {
        const [servers, runtime] = await Promise.all([
          unwrap(window.uld.mcp.list()),
          unwrap(window.uld.mcp.status()),
        ])
        set({ servers, runtime: indexRuntime(runtime), loaded: true })
      } catch (e) {
        set({ loaded: true })
        toastError('Failed to load MCP servers', e)
      }
    },

    async create(input) {
      applyServers(await unwrap(window.uld.mcp.create(input)))
    },

    async update(id, patch) {
      applyServers(await unwrap(window.uld.mcp.update(id, patch)))
    },

    async remove(id) {
      applyServers(await unwrap(window.uld.mcp.delete(id)))
    },

    async setEnabled(id, enabled) {
      applyServers(await unwrap(window.uld.mcp.setEnabled(id, enabled)))
    },

    async reconnect(id) {
      const runtime = await unwrap(window.uld.mcp.reconnect(id))
      set({ runtime: indexRuntime(runtime) })
    },

    setRuntime(runtime) {
      set({ runtime: indexRuntime(runtime) })
    },
  }
})
