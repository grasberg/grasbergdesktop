/**
 * Cowork workspace store: the workspace bound to the open cowork conversation
 * plus its items (plans, tasks, checklists, notes, docs). All mutations go
 * through window.uld.workspaces; failures surface as UI toasts.
 */

import { create } from 'zustand'
import type { ConvUpdateRequest } from '@shared/ipc'
import type { Conversation, Workspace, WorkspaceItem, WorkspaceItemKind } from '@shared/types'
import { toNormalized, unwrap } from '@/api/uld'
import { useChatStore } from './chat'
import { useUiStore } from './ui'

/**
 * The conversation-update patch does not (yet) carry workspaceId in the shared
 * contract; the main-side handler accepts it. Widening locally keeps the
 * shared files untouched while staying type-safe at the call site.
 */
type ConvPatchWithWorkspace = ConvUpdateRequest['patch'] & { workspaceId?: string | null }

export type WorkspaceItemPatch = Partial<
  Pick<WorkspaceItem, 'title' | 'content' | 'status' | 'sort' | 'kind'>
>

export interface CoworkStoreState {
  workspace: Workspace | null
  items: WorkspaceItem[]
  loading: boolean
  /**
   * Binds the store to the given cowork conversation: loads its workspace, or
   * creates one (named after the conversation) and links it back onto the
   * conversation when it has none yet.
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
  renameWorkspace(name: string): Promise<void>
  /** Re-fetches the current workspace and its items. */
  refresh(): Promise<void>
}

/** Guards ensure/refresh against out-of-order responses when switching fast. */
let ensureToken = 0

/** In-flight ensure per conversation, so StrictMode double-invokes and rapid
 * re-renders never create two workspaces for the same conversation. */
const ensureInFlight = new Map<string, Promise<void>>()

function toastError(e: unknown, prefix: string): void {
  useUiStore.getState().toast(`${prefix}: ${toNormalized(e).message}`, 'error')
}

const CHECKBOX_UNCHECKED = /^(\s*[-*]\s*)\[ \]/
const CHECKBOX_CHECKED = /^(\s*[-*]\s*)\[[xX]\]/

export const useCoworkStore = create<CoworkStoreState>()((set, get) => {
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
            const name = conversation.title.trim() || 'New workspace'
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
          toastError(e, 'Could not open the workspace')
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
        toastError(e, 'Could not load workspace items')
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
        toastError(e, 'Could not add the item')
      }
    },

    async updateItem(id, patch) {
      try {
        const item = await unwrap(window.uld.workspaces.itemUpdate(id, patch))
        putItem(item)
      } catch (e) {
        toastError(e, 'Could not update the item')
      }
    },

    async deleteItem(id) {
      try {
        await unwrap(window.uld.workspaces.itemDelete(id))
        set((s) => ({ items: s.items.filter((x) => x.id !== id) }))
      } catch (e) {
        toastError(e, 'Could not delete the item')
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
        toastError(e, 'Could not save the goal')
      }
    },

    async renameWorkspace(name) {
      const { workspace } = get()
      if (!workspace) return
      const trimmed = name.trim()
      if (!trimmed || trimmed === workspace.name) return
      try {
        const updated = await unwrap(window.uld.workspaces.update(workspace.id, { name: trimmed }))
        if (get().workspace?.id === workspace.id) set({ workspace: updated })
      } catch (e) {
        toastError(e, 'Could not rename the workspace')
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
        toastError(e, 'Could not refresh the workspace')
      }
    },
  }
})
