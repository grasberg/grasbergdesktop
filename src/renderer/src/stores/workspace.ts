/**
 * Workspace store for Work mode's Tasks panel: the workspace bound to the open
 * conversation plus its items (plans, tasks, checklists, notes, docs). Binding
 * is LAZY — a fresh Work task has no workspace until the assistant creates one
 * (update_task_list / uld-item) or the user adds a first item. All mutations
 * go through window.uld.workspaces; failures surface as UI toasts.
 */

import { create } from 'zustand'
import type { ConvUpdateRequest } from '@shared/ipc'
import type { Conversation, Workspace, WorkspaceItem, WorkspaceItemKind } from '@shared/types'
import { unwrap } from '@/api/uld'
import { useChatStore } from './chat'
import { toastError } from './ui'

/**
 * The conversation-update patch does not (yet) carry workspaceId in the shared
 * contract; the main-side handler accepts it. Widening locally keeps the
 * shared files untouched while staying type-safe at the call site.
 */
type ConvPatchWithWorkspace = ConvUpdateRequest['patch'] & { workspaceId?: string | null }

export type WorkspaceItemPatch = Partial<
  Pick<WorkspaceItem, 'title' | 'content' | 'status' | 'sort' | 'kind'>
>

export interface WorkspaceStoreState {
  workspace: Workspace | null
  items: WorkspaceItem[]
  loading: boolean
  /**
   * Binds the store to the conversation WITHOUT creating anything: loads the
   * linked workspace when one exists, otherwise clears to empty. Mount-safe.
   */
  bindConversation(conversation: Conversation | null): Promise<void>
  /**
   * Creates + links a workspace when the conversation has none (the explicit
   * "add the first item" path — never called on mount).
   */
  ensureWorkspaceForConversation(conversation: Conversation): Promise<void>
  loadItems(): Promise<void>
  createItem(
    kind: WorkspaceItemKind,
    title: string,
    content?: string,
    origin?: 'user' | 'assistant'
  ): Promise<void>
  updateItem(id: string, patch: WorkspaceItemPatch): Promise<void>
  deleteItem(id: string): Promise<void>
  /** Flips one '- [ ]' / '- [x]' line inside a checklist item's content. */
  toggleChecklistLine(itemId: string, lineIndex: number): Promise<void>
  setTaskStatus(id: string, status: 'todo' | 'doing' | 'done'): Promise<void>
  updateGoal(goal: string): Promise<void>
  /** Re-fetches the current workspace and its items. */
  refresh(): Promise<void>
}

/** Guards bind/ensure/refresh against out-of-order responses when switching fast. */
let ensureToken = 0

/** In-flight ensure per conversation, so StrictMode double-invokes and rapid
 * re-renders never create two workspaces for the same conversation. */
const ensureInFlight = new Map<string, Promise<void>>()

const CHECKBOX_UNCHECKED = /^(\s*[-*]\s*)\[ \]/
const CHECKBOX_CHECKED = /^(\s*[-*]\s*)\[[xX]\]/

export const useWorkspaceStore = create<WorkspaceStoreState>()((set, get) => {
  /** Replaces one item in place (or appends it if unknown). */
  const putItem = (item: WorkspaceItem): void => {
    set((s) => {
      const exists = s.items.some((x) => x.id === item.id)
      return { items: exists ? s.items.map((x) => (x.id === item.id ? item : x)) : [...s.items, item] }
    })
  }

  return {
    workspace: null,
    items: [],
    loading: false,

    async bindConversation(conversation) {
      const token = ++ensureToken
      if (!conversation?.workspaceId) {
        set({ workspace: null, items: [], loading: false })
        return
      }
      set({ loading: true })
      try {
        const workspace = await unwrap(window.uld.workspaces.get(conversation.workspaceId))
        const items = await unwrap(window.uld.workspaces.itemsList(workspace.id))
        if (token !== ensureToken) return
        set({ workspace, items, loading: false })
      } catch (e) {
        if (token === ensureToken) set({ workspace: null, items: [], loading: false })
        toastError('Could not open the workspace', e)
      }
    },

    async ensureWorkspaceForConversation(conversation) {
      const existing = ensureInFlight.get(conversation.id)
      if (existing) return existing

      const token = ++ensureToken
      const run = (async (): Promise<void> => {
        set({ loading: true })
        try {
          let workspace: Workspace
          if (conversation.workspaceId) {
            workspace = await unwrap(window.uld.workspaces.get(conversation.workspaceId))
          } else {
            const name = conversation.title.trim() || 'Tasks'
            workspace = await unwrap(window.uld.workspaces.create({ name }))
            // Link the conversation to its new workspace.
            const patch: ConvPatchWithWorkspace = { workspaceId: workspace.id }
            const updated = await unwrap(
              window.uld.conversations.update({ id: conversation.id, patch })
            )
            // Reload the chat store's copy so it carries the workspaceId.
            const chat = useChatStore.getState()
            if (chat.conversation?.id === conversation.id) {
              useChatStore.setState({ conversation: updated })
            }
          }
          const items = await unwrap(window.uld.workspaces.itemsList(workspace.id))
          if (token !== ensureToken) return
          set({ workspace, items, loading: false })
        } catch (e) {
          if (token === ensureToken) set({ workspace: null, items: [], loading: false })
          toastError('Could not open the workspace', e)
        }
      })()

      ensureInFlight.set(conversation.id, run)
      try {
        await run
      } finally {
        ensureInFlight.delete(conversation.id)
      }
    },

    async loadItems() {
      const { workspace } = get()
      if (!workspace) return
      try {
        const items = await unwrap(window.uld.workspaces.itemsList(workspace.id))
        if (get().workspace?.id === workspace.id) set({ items })
      } catch (e) {
        toastError('Could not load workspace items', e)
      }
    },

    async createItem(kind, title, content = '', origin = 'user') {
      const { workspace } = get()
      if (!workspace) return
      try {
        const item = await unwrap(
          window.uld.workspaces.itemCreate({ workspaceId: workspace.id, kind, title, content, origin })
        )
        if (get().workspace?.id === workspace.id) putItem(item)
      } catch (e) {
        toastError('Could not add the item', e)
      }
    },

    async updateItem(id, patch) {
      try {
        const item = await unwrap(window.uld.workspaces.itemUpdate(id, patch))
        putItem(item)
      } catch (e) {
        toastError('Could not update the item', e)
      }
    },

    async deleteItem(id) {
      try {
        await unwrap(window.uld.workspaces.itemDelete(id))
        set((s) => ({ items: s.items.filter((x) => x.id !== id) }))
      } catch (e) {
        toastError('Could not delete the item', e)
      }
    },

    async toggleChecklistLine(itemId, lineIndex) {
      const item = get().items.find((x) => x.id === itemId)
      if (!item) return
      const lines = item.content.split('\n')
      const line = lines[lineIndex]
      if (line === undefined) return
      if (CHECKBOX_UNCHECKED.test(line)) {
        lines[lineIndex] = line.replace(CHECKBOX_UNCHECKED, '$1[x]')
      } else if (CHECKBOX_CHECKED.test(line)) {
        lines[lineIndex] = line.replace(CHECKBOX_CHECKED, '$1[ ]')
      } else {
        return
      }
      await get().updateItem(itemId, { content: lines.join('\n') })
    },

    async setTaskStatus(id, status) {
      await get().updateItem(id, { status })
    },

    async updateGoal(goal) {
      const { workspace } = get()
      if (!workspace) return
      try {
        const updated = await unwrap(
          window.uld.workspaces.update(workspace.id, { goal: goal.trim() ? goal : null })
        )
        if (get().workspace?.id === workspace.id) set({ workspace: updated })
      } catch (e) {
        toastError('Could not save the goal', e)
      }
    },

    async refresh() {
      const { workspace } = get()
      if (!workspace) return
      try {
        const [fresh, items] = await Promise.all([
          unwrap(window.uld.workspaces.get(workspace.id)),
          unwrap(window.uld.workspaces.itemsList(workspace.id)),
        ])
        if (get().workspace?.id === workspace.id) set({ workspace: fresh, items })
      } catch (e) {
        toastError('Could not refresh the workspace', e)
      }
    },
  }
})
