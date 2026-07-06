import { create } from 'zustand'
import type { ConversationSummary } from '@shared/types'
import { unwrap } from '@/api/uld'
import type { ConversationsStoreState } from './contracts'
import { useChatStore } from './chat'
import { toastError } from './ui'

export const useConversationsStore = create<ConversationsStoreState>()((set, get) => ({
  summaries: [],
  activeId: null,
  search: '',
  modeFilter: 'chat',
  loaded: false,

  async load() {
    const { search, modeFilter } = get()
    try {
      // Load every task in the mode; the sidebar groups them under their
      // projects (and a "No project" group) client-side.
      const summaries = await unwrap(
        window.uld.conversations.list({
          search: search.trim() ? search.trim() : undefined,
          mode: modeFilter,
        })
      )
      set({ summaries, loaded: true })
    } catch (e) {
      set({ loaded: true })
      toastError('Failed to load conversations', e)
    }
  },

  setSearch(q) {
    set({ search: q })
  },

  setModeFilter(mode) {
    if (get().modeFilter === mode) return
    // The Sidebar reloads the project list off `modeFilter` via an effect.
    set({ modeFilter: mode })
    void get().load()
  },

  async create(mode, projectRef) {
    const conversation = await unwrap(
      window.uld.conversations.create({ mode, projectRef: projectRef ?? null })
    )
    const summary: ConversationSummary = {
      id: conversation.id,
      mode: conversation.mode,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      projectRef: conversation.projectRef,
      snippet: null,
    }
    // Show it in the list when it belongs to the mode on screen; the tree places
    // it under the right project group by its projectRef.
    if (conversation.mode === get().modeFilter) {
      set((s) => ({ summaries: [summary, ...s.summaries.filter((x) => x.id !== summary.id)] }))
    }
    get().select(conversation.id)
    return conversation
  },

  select(id) {
    set({ activeId: id })
    void useChatStore.getState().openConversation(id)
  },

  async rename(id, title) {
    const updated = await unwrap(window.uld.conversations.update({ id, patch: { title } }))
    set((s) => ({
      summaries: s.summaries.map((x) =>
        x.id === id ? { ...x, title: updated.title, updatedAt: updated.updatedAt } : x
      ),
    }))
    const chat = useChatStore.getState()
    if (chat.conversation?.id === id) {
      useChatStore.setState({ conversation: updated })
    }
  },

  async setProject(id, projectRef) {
    const updated = await unwrap(window.uld.conversations.update({ id, patch: { projectRef } }))
    const chat = useChatStore.getState()
    if (chat.conversation?.id === id) {
      useChatStore.setState({ conversation: updated })
    }
    // Update the projectRef in place; the tree re-groups the row automatically.
    set((s) => ({
      summaries: s.summaries.map((x) =>
        x.id === id ? { ...x, projectRef: updated.projectRef } : x
      ),
    }))
  },

  async remove(id) {
    await unwrap(window.uld.conversations.delete(id))
    set((s) => ({ summaries: s.summaries.filter((x) => x.id !== id) }))
    if (get().activeId === id) {
      get().select(null)
    }
  },
}))
