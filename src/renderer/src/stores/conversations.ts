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
  modeFilter: 'all',
  loaded: false,

  async load() {
    const { search, modeFilter } = get()
    try {
      const summaries = await unwrap(
        window.uld.conversations.list({
          search: search.trim() ? search.trim() : undefined,
          mode: modeFilter === 'all' ? undefined : modeFilter,
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
    set({ modeFilter: mode })
    void get().load()
  },

  async create(mode) {
    const conversation = await unwrap(window.uld.conversations.create({ mode }))
    const summary: ConversationSummary = {
      id: conversation.id,
      mode: conversation.mode,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      snippet: null,
    }
    set((s) => ({ summaries: [summary, ...s.summaries.filter((x) => x.id !== summary.id)] }))
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

  async remove(id) {
    await unwrap(window.uld.conversations.delete(id))
    set((s) => ({ summaries: s.summaries.filter((x) => x.id !== id) }))
    if (get().activeId === id) {
      get().select(null)
    }
  },
}))
