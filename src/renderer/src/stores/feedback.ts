/**
 * Feedback on replies (v53): thumbs up/down (+ optional comment) per
 * assistant message, loaded once per conversation. Main stores it and — with
 * memory on — turns it into a memory for the agent that wrote the reply, so
 * the agent learns from it.
 */

import { create } from 'zustand'
import type { MessageFeedback } from '@shared/types'
import { unwrap } from '@/api/uld'
import { toastError } from './ui'

interface FeedbackState {
  conversationId: string | null
  byMessage: Record<string, MessageFeedback>
  load(conversationId: string): Promise<void>
  rate(messageId: string, rating: 1 | -1 | 0, comment?: string): Promise<void>
}

export const useFeedbackStore = create<FeedbackState>()((set, get) => ({
  conversationId: null,
  byMessage: {},

  async load(conversationId) {
    if (get().conversationId === conversationId) return
    set({ conversationId, byMessage: {} })
    try {
      const rows = await unwrap(window.uld.feedback.list(conversationId))
      if (get().conversationId !== conversationId) return
      set({ byMessage: Object.fromEntries(rows.map((row) => [row.messageId, row])) })
    } catch {
      // Feedback state is a convenience; the buttons still work.
    }
  },

  async rate(messageId, rating, comment) {
    try {
      const saved = await unwrap(window.uld.feedback.set(messageId, rating, comment))
      set((state) => {
        const next = { ...state.byMessage }
        if (saved) next[messageId] = saved
        else delete next[messageId]
        return { byMessage: next }
      })
    } catch (e) {
      toastError('Could not save feedback', e)
    }
  },
}))
