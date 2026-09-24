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
  ToolRule,
  ToolRuleInput,
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
  responding: Record<string, boolean>
  recoverPending(): Promise<void>
  /** Standing approval rules, newest first (Settings -> Tools). */
  rules: ToolRule[]
  loaded: boolean
  load(): Promise<void>
  setEnabled(id: string, enabled: boolean): Promise<void>
  setPermission(id: string, decision: ToolPermissionDecision): Promise<void>
  /** Create a custom HTTP tool (rejects with a NormalizedError on failure). */
  customCreate(input: CustomToolInput): Promise<void>
  customUpdate(toolId: string, patch: CustomToolPatch): Promise<void>
  customDelete(toolId: string): Promise<void>
  /** Refreshes the standing approval rules (an answer may have added one). */
  loadRules(): Promise<void>
  ruleCreate(input: ToolRuleInput): Promise<void>
  ruleDelete(ruleId: string): Promise<void>
  /** Enqueues an approval request pushed from main (deduped by requestId). */
  setPendingApproval(req: ToolApprovalRequest): void
  /**
   * Answers the request the dialog rendered (its requestId) and dequeues it,
   * revealing the next. Scope 'conversation' also auto-approves the tool's
   * future calls there. Ignored when that request is no longer the head — main
   * may have settled it under the click, and the next request's arguments have
   * not been seen by the user.
   */
  respond(requestId: string, approved: boolean, scope?: ToolApprovalScope): Promise<void>
  /**
   * Drops a request that main settled on its own (timeout/abort/stopAll) so a
   * stale dialog auto-dismisses without the user having to answer it.
   */
  settleApproval(requestId: string): void
  /** FIFO queue of ask_user_question dialogs; the dialog renders the head. */
  questionQueue: UserQuestionRequest[]
  /** Enqueues a question pushed from main (deduped by requestId). */
  setPendingQuestion(req: UserQuestionRequest): void
  /**
   * Answers the question the dialog rendered (null = dismissed) and dequeues
   * it. Ignored when that request is no longer the head (same settle race as
   * `respond`), so an answer never lands on an unseen question.
   */
  respondQuestion(requestId: string, answer: string | null): Promise<void>
  /** Drops a question main settled on its own (timeout/abort/stopAll). */
  settleQuestion(requestId: string): void
}

export const useToolsStore = create<ToolsStoreState>()((set, get) => {
  type Queues = Pick<ToolsStoreState, 'approvalQueue' | 'questionQueue'>
  let recovering: Promise<void> | null = null
  let changes: Array<(queues: Queues) => Queues> = []
  const changeQueues = (change: (queues: Queues) => Queues): void => {
    if (recovering) changes.push(change)
    set(change)
  }
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
    responding: {},
    recoverPending() {
      if (recovering) return recovering
      changes = []
      recovering = Promise.resolve().then(() => unwrap(window.uld.tools.pending())).then(snapshot => {
        set(changes.reduce((state, change) => change(state), { approvalQueue: snapshot.approvals, questionQueue: snapshot.questions }))
      }).catch(e => toastError('Could not restore pending requests', e)).finally(() => { recovering = null; changes = [] })
      return recovering
    },
    rules: [],
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
        void get().loadRules()
      } catch (e) {
        set({ loaded: true })
        toastError('Failed to load tools', e)
      }
    },

    async loadRules() {
      try {
        set({ rules: await unwrap(window.uld.tools.rulesList()) })
      } catch {
        // The rules list is supplementary; a failure must not blank the tab.
      }
    },

    async ruleCreate(input) {
      try {
        set({ rules: await unwrap(window.uld.tools.ruleCreate(input)) })
      } catch (e) {
        toastError('Could not save the approval rule', e)
      }
    },

    async ruleDelete(ruleId) {
      try {
        set({ rules: await unwrap(window.uld.tools.ruleDelete(ruleId)) })
      } catch (e) {
        toastError('Could not remove the approval rule', e)
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
      changeQueues((s) =>
        s.approvalQueue.some((r) => r.requestId === req.requestId)
          ? s
          : { ...s, approvalQueue: [...s.approvalQueue, req] }
      )
    },

    async respond(requestId, approved, scope) {
      const pending = get().approvalQueue[0]
      if (!pending || pending.requestId !== requestId || get().responding[requestId]) return
      // Dequeue first so the dialog advances to the next request and cannot
      // double-submit; main treats an unknown requestId as already-answered.
      set(s => ({ responding: { ...s.responding, [requestId]: true } }))
      try {
        await unwrap(window.uld.tools.approvalRespond(pending.requestId, approved, scope))
        get().settleApproval(requestId)
        // A wider scope persisted a rule main-side; keep the list in step.
        if (scope && scope !== 'once') void get().loadRules()
      } catch (e) {
        toastError('Could not deliver the approval response', e)
      } finally { set(s => ({ responding: { ...s.responding, [requestId]: false } })) }
    },

    settleApproval(requestId) {
      changeQueues((s) => {
        const next = s.approvalQueue.filter((r) => r.requestId !== requestId)
        return { ...s, approvalQueue: next }
      })
    },

    questionQueue: [],

    setPendingQuestion(req) {
      changeQueues((s) =>
        s.questionQueue.some((r) => r.requestId === req.requestId)
          ? s
          : { ...s, questionQueue: [...s.questionQueue, req] }
      )
    },

    async respondQuestion(requestId, answer) {
      const pending = get().questionQueue[0]
      if (!pending || pending.requestId !== requestId || get().responding[requestId]) return
      set(s => ({ responding: { ...s.responding, [requestId]: true } }))
      try {
        await unwrap(window.uld.tools.questionRespond(pending.requestId, answer))
        get().settleQuestion(requestId)
      } catch (e) {
        toastError('Could not deliver the answer', e)
      } finally { set(s => ({ responding: { ...s.responding, [requestId]: false } })) }
    },

    settleQuestion(requestId) {
      changeQueues((s) => {
        const next = s.questionQueue.filter((r) => r.requestId !== requestId)
        return { ...s, questionQueue: next }
      })
    },
  }
})
