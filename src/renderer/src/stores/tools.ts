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
  ToolApprovalScope,
  ToolDefinition,
  ToolPermissionDecision,
  ToolRiskLevel,
  UserQuestionRequest,
} from '@shared/types'
import { unwrap } from '@/api/uld'
import { toastError } from './ui'

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
  /**
   * Answers the head request and dequeues it, revealing the next. Scope
   * 'conversation' also auto-approves the tool's future calls there.
   */
  respond(approved: boolean, scope?: ToolApprovalScope): Promise<void>
  /**
   * Drops a request that main settled on its own (timeout/abort/stopAll) so a
   * stale dialog auto-dismisses without the user having to answer it.
   */
  settleApproval(requestId: string): void
  /** FIFO queue of ask_user_question dialogs; the dialog renders the head. */
  questionQueue: UserQuestionRequest[]
  /** Enqueues a question pushed from main (deduped by requestId). */
  setPendingQuestion(req: UserQuestionRequest): void
  /** Answers the head question (null = dismissed) and dequeues it. */
  respondQuestion(answer: string | null): Promise<void>
  /** Drops a question main settled on its own (timeout/abort/stopAll). */
  settleQuestion(requestId: string): void
}

export const useToolsStore = create<ToolsStoreState>()((set, get) => {
  /** Applies a mutated custom-tool list, then re-syncs the registry. */
  const applyCustomInfos = async (infos: CustomToolInfo[]): Promise<void> => {
    set({ customInfos: infos })
    await get().load()
  }

  return {
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
        toastError('Failed to load tools', e)
      }
    },

    async customCreate(input) {
      await applyCustomInfos(await unwrap(window.uld.tools.customCreate(input)))
    },

    async customUpdate(toolId, patch) {
      await applyCustomInfos(await unwrap(window.uld.tools.customUpdate(toolId, patch)))
    },

    async customDelete(toolId) {
      await applyCustomInfos(await unwrap(window.uld.tools.customDelete(toolId)))
    },

    async setEnabled(id, enabled) {
      const before = get().tools
      // Optimistic flip; revert on failure.
      set((s) => ({ tools: s.tools.map((t) => (t.id === id ? { ...t, enabled } : t)) }))
      try {
        await unwrap(window.uld.tools.setEnabled(id, enabled))
      } catch (e) {
        set({ tools: before })
        toastError('Could not update tool', e)
      }
    },

    async setPermission(id, decision) {
      const before = get().permissions
      set((s) => ({ permissions: { ...s.permissions, [id]: decision } }))
      try {
        await unwrap(window.uld.tools.permissionSet(id, decision))
      } catch (e) {
        set({ permissions: before })
        toastError('Could not update permission', e)
      }
    },

    setPendingApproval(req) {
      set((s) =>
        s.approvalQueue.some((r) => r.requestId === req.requestId)
          ? s
          : { approvalQueue: [...s.approvalQueue, req] }
      )
    },

    async respond(approved, scope) {
      const pending = get().approvalQueue[0]
      if (!pending) return
      // Dequeue first so the dialog advances to the next request and cannot
      // double-submit; main treats an unknown requestId as already-answered.
      set((s) => ({
        approvalQueue: s.approvalQueue.filter((r) => r.requestId !== pending.requestId),
      }))
      try {
        await unwrap(window.uld.tools.approvalRespond(pending.requestId, approved, scope))
      } catch (e) {
        toastError('Could not deliver the approval response', e)
      }
    },

    settleApproval(requestId) {
      set((s) => {
        const next = s.approvalQueue.filter((r) => r.requestId !== requestId)
        return next.length === s.approvalQueue.length ? s : { approvalQueue: next }
      })
    },

    questionQueue: [],

    setPendingQuestion(req) {
      set((s) =>
        s.questionQueue.some((r) => r.requestId === req.requestId)
          ? s
          : { questionQueue: [...s.questionQueue, req] }
      )
    },

    async respondQuestion(answer) {
      const pending = get().questionQueue[0]
      if (!pending) return
      set((s) => ({
        questionQueue: s.questionQueue.filter((r) => r.requestId !== pending.requestId),
      }))
      try {
        await unwrap(window.uld.tools.questionRespond(pending.requestId, answer))
      } catch (e) {
        toastError('Could not deliver the answer', e)
      }
    },

    settleQuestion(requestId) {
      set((s) => {
        const next = s.questionQueue.filter((r) => r.requestId !== requestId)
        return next.length === s.questionQueue.length ? s : { questionQueue: next }
      })
    },
  }
})
