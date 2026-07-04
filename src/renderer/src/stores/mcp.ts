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
import { toNormalized, unwrap } from '@/api/uld'
import { useUiStore } from './ui'

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

export const useMcpStore = create<McpStoreState>()((set, get) => ({
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
      useUiStore.getState().toast(`Failed to load MCP servers: ${toNormalized(e).message}`, 'error')
    }
  },

  async create(input) {
    const servers = await unwrap(window.uld.mcp.create(input))
    set({ servers })
    void get()
      .load()
      .catch(() => undefined)
  },

  async update(id, patch) {
    const servers = await unwrap(window.uld.mcp.update(id, patch))
    set({ servers })
    void get().load().catch(() => undefined)
  },

  async remove(id) {
    const servers = await unwrap(window.uld.mcp.delete(id))
    set({ servers })
    void get().load().catch(() => undefined)
  },

  async setEnabled(id, enabled) {
    const servers = await unwrap(window.uld.mcp.setEnabled(id, enabled))
    set({ servers })
    void get().load().catch(() => undefined)
  },

  async reconnect(id) {
    const runtime = await unwrap(window.uld.mcp.reconnect(id))
    set({ runtime: indexRuntime(runtime) })
  },

  setRuntime(runtime) {
    set({ runtime: indexRuntime(runtime) })
  },
}))
