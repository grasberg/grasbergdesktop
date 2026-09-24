import { create } from 'zustand'
import type { ConversationSummary } from '@shared/types'
import { unwrap } from '@/api/uld'
import type { ConversationsStoreState } from './contracts'
import { useChatStore } from './chat'
import { useSpacesStore } from './spaces'
import { toastError, useUiStore } from './ui'
import { navigateGuarded } from '@/hooks/useUnsavedChanges'

/**
 * Upper bound on the sidebar list so the (unindexed, leading-wildcard) search
 * scan and snippet subquery can never run across an unbounded history. Far more
 * than fits on screen; older tasks surface via search.
 */
const SIDEBAR_LIMIT = 300

/** Renderer-side snippet: a short, single-line preview of a message. */
function toSnippet(content: string | null): string | null {
  if (!content) return null
  const trimmed = content.replace(/\s+/g, ' ').trim()
  if (!trimmed) return null
  return trimmed.length > 140 ? `${trimmed.slice(0, 140)}…` : trimmed
}

/**
 * One app-wide subscription to the conversation push channel: messages main
 * writes outside a renderer stream (IM-bridge replies, mid-stream compaction)
 * refresh the open conversation and its sidebar row. Installed on the first
 * list load, which App runs at boot.
 */
let pushSubscribed = false
function ensureConversationsSubscription(): void {
  if (pushSubscribed) return
  pushSubscribed = true
  window.uld.conversations.onConversationsChanged(({ conversationId }) => {
    useChatStore.getState().handleConversationsChanged(conversationId)
    // Full reload: the new message also changes the row's snippet, which
    // syncSummary can only carry when the caller already knows the text.
    void useConversationsStore.getState().load()
  })
}

export const useConversationsStore = create<ConversationsStoreState>()((set, get) => ({
  summaries: [],
  activeId: null,
  search: '',
  modeFilter: 'chat',
  loaded: false,

  async load() {
    ensureConversationsSubscription()
    const { search, modeFilter } = get()
    try {
      // Load the mode's most-recent tasks (bounded); the sidebar groups them
      // under their projects (and a standalone "Tasks" group) client-side.
      const summaries = await unwrap(
        window.uld.conversations.list({
          search: search.trim() ? search.trim() : undefined,
          mode: modeFilter,
          limit: SIDEBAR_LIMIT,
          // Scope to the active space; omitted = the default space.
          spaceId: useSpacesStore.getState().activeSpaceId ?? undefined,
        })
      )
      set({ summaries, loaded: true })
    } catch (e) {
      set({ loaded: true })
      toastError('Failed to load conversations', e)
    }
  },

  async syncSummary(id, snippet) {
    // While a search is active the result set must be re-evaluated server-side,
    // so fall back to a full (bounded) reload; otherwise update just this row in
    // place and float it to the top, avoiding the full list scan after every
    // generation.
    if (get().search.trim()) {
      await get().load()
      return
    }
    try {
      const conv = await unwrap(window.uld.conversations.get(id))
      // Canonical bot chats are excluded by conversations.list as well. A
      // completed renderer stream must not add one back through this shortcut.
      if (conv.agentId) {
        set((s) => ({ summaries: s.summaries.filter((x) => x.id !== id) }))
        return
      }
      if (conv.mode !== get().modeFilter) return
      // A push about another space must never inject a row into this list.
      if ((conv.spaceId ?? null) !== useSpacesStore.getState().activeSpaceId) return
      set((s) => {
        const existing = s.summaries.find((x) => x.id === id)
        const summary: ConversationSummary = {
          id: conv.id,
          mode: conv.mode,
          title: conv.title,
          updatedAt: conv.updatedAt,
          projectRef: conv.projectRef,
          snippet: snippet !== undefined ? toSnippet(snippet) : (existing?.snippet ?? null),
        }
        return { summaries: [summary, ...s.summaries.filter((x) => x.id !== id)] }
      })
    } catch {
      // Non-fatal: a failed point refresh just leaves the stale row in place.
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
      window.uld.conversations.create({
        mode,
        projectRef: projectRef ?? null,
        // New conversations belong to the active space (v45).
        spaceId: useSpacesStore.getState().activeSpaceId,
      })
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

  async fork(id, messageId) {
    try {
      const conversation = await unwrap(window.uld.conversations.fork(id, messageId))
      const summary: ConversationSummary = {
        id: conversation.id,
        mode: conversation.mode,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        projectRef: conversation.projectRef,
        snippet: null,
      }
      // Mirror syncSummary's guard: a fork of a conversation in another space
      // (opened via an inbox item) must not inject its row into this list.
      if (
        conversation.mode === get().modeFilter &&
        (conversation.spaceId ?? null) === useSpacesStore.getState().activeSpaceId
      ) {
        set((s) => ({ summaries: [summary, ...s.summaries.filter((x) => x.id !== summary.id)] }))
      }
      get().select(conversation.id)
    } catch (e) {
      toastError('Failed to fork conversation', e)
    }
  },

  select(id) {
    // Selecting is also navigation: leave Home/Workflows for the conversation
    // surface, or land back on Home when the selection is cleared.
    navigateGuarded(() => {
      useUiStore.getState().setView(id ? 'conversation' : 'home')
      set({ activeId: id })
      void useChatStore.getState().openConversation(id)
    }, 'page')
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
