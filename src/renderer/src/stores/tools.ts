/**
 * Zustand store for the tool system UI: the registry of tool definitions,
 * per-tool permission decisions, and a FIFO queue of approval requests pushed
 * from main (push:toolApprovalRequest -> App.tsx subscription). The dialog
 * renders the head of the queue; concurrent requests wait their turn instead
 * of clobbering one another.
 *
 * Permission defaults mirror the main-side registry (safe -> always allow,
 * sensitive/dangerous -> ask); the permissions map only contains decisions the
 * user explicitly stored — use `effectivePermission` for display.
 */

import { create } from 'zustand'
import type {
  CustomToolInfo,
  CustomToolInput,
  CustomToolPatch,
  ToolApprovalRequest,
  ToolDefinition,
  ToolPermissionDecision,
  ToolRiskLevel,
} from '@shared/types'
import { toNormalized, unwrap } from '@/api/uld'
import { useUiStore } from './ui'

/** Mirrors DEFAULT_PERMISSION_BY_RISK in src/main/tools/definitions.ts. */
const DEFAULT_PERMISSION_BY_RISK: Record<ToolRiskLevel, ToolPermissionDecision> = {
  safe: 'always_allow',
  sensitive: 'ask',
  dangerous: 'ask',
}

/** Stored decision if the user made one, otherwise the risk-based default. */
export function effectivePermission(
  permissions: Record<string, ToolPermissionDecision>,
  tool: ToolDefinition
): ToolPermissionDecision {
  return permissions[tool.id] ?? DEFAULT_PERMISSION_BY_RISK[tool.risk]
}

export interface ToolsStoreState {
  tools: ToolDefinition[]
  /** Full details of user-defined custom HTTP tools (for the edit form). */
  customInfos: CustomToolInfo[]
  /** toolId -> decision, for decisions the user explicitly stored. */
  permissions: Record<string, ToolPermissionDecision>
  /** FIFO queue of pending requests; the dialog renders the head. */
  approvalQueue: ToolApprovalRequest[]
  loaded: boolean
  load(): Promise<void>
  setEnabled(id: string, enabled: boolean): Promise<void>
  setPermission(id: string, decision: ToolPermissionDecision): Promise<void>
  /** Create a custom HTTP tool (rejects with a NormalizedError on failure). */
  customCreate(input: CustomToolInput): Promise<void>
  customUpdate(toolId: string, patch: CustomToolPatch): Promise<void>
  customDelete(toolId: string): Promise<void>
  /** Enqueues an approval request pushed from main (deduped by requestId). */
  setPendingApproval(req: ToolApprovalRequest): void
  /** Answers the head request and dequeues it, revealing the next. */
  respond(approved: boolean): Promise<void>
  /**
   * Drops a request that main settled on its own (timeout/abort/stopAll) so a
   * stale dialog auto-dismisses without the user having to answer it.
   */
  settleApproval(requestId: string): void
}

export const useToolsStore = create<ToolsStoreState>()((set, get) => ({
  tools: [],
  customInfos: [],
  permissions: {},
  approvalQueue: [],
  loaded: false,

  async load() {
    try {
      const [tools, permissionList, customInfos] = await Promise.all([
        unwrap(window.uld.tools.list()),
        unwrap(window.uld.tools.permissionsList()),
        unwrap(window.uld.tools.customList()),
      ])
      const permissions: Record<string, ToolPermissionDecision> = {}
      for (const p of permissionList) permissions[p.toolId] = p.decision
      set({ tools, permissions, customInfos, loaded: true })
    } catch (e) {
      set({ loaded: true })
      useUiStore.getState().toast(`Failed to load tools: ${toNormalized(e).message}`, 'error')
    }
  },

  async customCreate(input) {
    const infos = await unwrap(window.uld.tools.customCreate(input))
    set({ customInfos: infos })
    await get().load()
  },

  async customUpdate(toolId, patch) {
    const infos = await unwrap(window.uld.tools.customUpdate(toolId, patch))
    set({ customInfos: infos })
    await get().load()
  },

  async customDelete(toolId) {
    const infos = await unwrap(window.uld.tools.customDelete(toolId))
    set({ customInfos: infos })
    await get().load()
  },

  async setEnabled(id, enabled) {
    const before = get().tools
    // Optimistic flip; revert on failure.
    set((s) => ({ tools: s.tools.map((t) => (t.id === id ? { ...t, enabled } : t)) }))
    try {
      await unwrap(window.uld.tools.setEnabled(id, enabled))
    } catch (e) {
      set({ tools: before })
      useUiStore.getState().toast(`Could not update tool: ${toNormalized(e).message}`, 'error')
    }
  },

  async setPermission(id, decision) {
    const before = get().permissions
    set((s) => ({ permissions: { ...s.permissions, [id]: decision } }))
    try {
      await unwrap(window.uld.tools.permissionSet(id, decision))
    } catch (e) {
      set({ permissions: before })
      useUiStore
        .getState()
        .toast(`Could not update permission: ${toNormalized(e).message}`, 'error')
    }
  },

  setPendingApproval(req) {
    set((s) =>
      s.approvalQueue.some((r) => r.requestId === req.requestId)
        ? s
        : { approvalQueue: [...s.approvalQueue, req] }
    )
  },

  async respond(approved) {
    const pending = get().approvalQueue[0]
    if (!pending) return
    // Dequeue first so the dialog advances to the next request and cannot
    // double-submit; main treats an unknown requestId as already-answered.
    set((s) => ({
      approvalQueue: s.approvalQueue.filter((r) => r.requestId !== pending.requestId),
    }))
    try {
      await unwrap(window.uld.tools.approvalRespond(pending.requestId, approved))
    } catch (e) {
      useUiStore
        .getState()
        .toast(`Could not deliver the approval response: ${toNormalized(e).message}`, 'error')
    }
  },

  settleApproval(requestId) {
    set((s) => {
      const next = s.approvalQueue.filter((r) => r.requestId !== requestId)
      return next.length === s.approvalQueue.length ? s : { approvalQueue: next }
    })
  },
}))
