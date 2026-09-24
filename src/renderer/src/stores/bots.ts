/**
 * Bot Mode (v46) store: the Bots pane roster (bots + group rooms), the open
 * room's transcript, and roster actions. App.tsx loads it at boot and wires
 * the one push:botsChanged subscription to handleChanged — deliveries, group
 * turns, routine mirrors and seen-stamps all land as coarse "refetch" events.
 * Contract: BotsStoreState in ./contracts.
 */

import { create } from 'zustand'
import type { BotRoster } from '@shared/types'
import { unwrap } from '@/api/uld'
import type { BotsStoreState } from './contracts'
import { useConversationsStore } from './conversations'
import { toastError } from './ui'
import { getChatDraft, saveChatDraft } from '@/lib/chat-drafts'

/** Sidebar/badge summary of the roster (hidden bots excluded; rooms included). */
export function botsAttentionSummary(roster: BotRoster): {
  needsYou: number
  unread: number
  working: number
} {
  const summary = { needsYou: 0, unread: 0, working: 0 }
  const count = (attention: string): void => {
    if (attention === 'needs_you') summary.needsYou += 1
    else if (attention === 'unread') summary.unread += 1
    else if (attention === 'working') summary.working += 1
  }
  for (const row of roster.bots) if (!row.agent.hidden) count(row.attention)
  for (const row of roster.groups) count(row.attention)
  return summary
}

async function reloadGroupMessages(groupId: string): Promise<void> {
  const { roster, activeGroupId } = useBotsStore.getState()
  const group = roster?.groups.find((g) => g.group.id === groupId)?.group
  if (!group || activeGroupId !== groupId) return
  try {
    const messages = await unwrap(window.uld.conversations.messages(group.conversationId))
    if (useBotsStore.getState().activeGroupId === groupId) {
      useBotsStore.setState({ groupMessages: messages })
    }
  } catch {
    // Non-fatal: the next push event retries.
  }
}

export const useBotsStore = create<BotsStoreState>()((set, get) => ({
  roster: null,
  loaded: false,
  activeGroupId: null,
  groupMessages: [],
  showHidden: false,

  async load() {
    try {
      const roster = await unwrap(window.uld.bots.roster())
      set({ roster, loaded: true })
    } catch (e) {
      set({ loaded: true })
      toastError('Failed to load bots', e)
    }
  },

  handleChanged(event) {
    void get().load()
    if (event.groupId && event.groupId === get().activeGroupId) {
      void reloadGroupMessages(event.groupId)
    }
  },

  async openBotChat(agentId) {
    try {
      const { conversationId } = await unwrap(window.uld.bots.openChat(agentId))
      useConversationsStore.getState().select(conversationId)
      void get().markSeen(agentId)
    } catch (e) {
      toastError('Failed to open bot chat', e)
    }
  },

  async markSeen(agentId) {
    try {
      await unwrap(window.uld.bots.markSeen(agentId))
    } catch {
      // A missed stamp only leaves the unread chip on a little longer.
    }
  },

  selectGroup(groupId) {
    set({ activeGroupId: groupId, groupMessages: [] })
    if (groupId) {
      void reloadGroupMessages(groupId)
      // Opening the room clears its needs-you badge.
      void window.uld.bots.groupMarkSeen(groupId).then(
        () => get().load(),
        () => undefined
      )
    }
  },

  async createGroup(name, memberIds, activation, observerIds, mode, leadAgentId) {
    try {
      const group = await unwrap(
        window.uld.bots.createGroup({ name, memberIds, activation, observerIds, mode, leadAgentId })
      )
      await get().load()
      set({ activeGroupId: group.id, groupMessages: [] })
      return group
    } catch (e) {
      toastError('Failed to create group', e)
      return null
    }
  },

  async createGroupFromMoaPreset(presetId) {
    try {
      const group = await unwrap(window.uld.bots.createGroupFromMoaPreset(presetId))
      await get().load()
      set({ activeGroupId: group.id, groupMessages: [] })
      return group
    } catch (e) {
      toastError('Failed to create the ensemble room', e)
      return null
    }
  },

  async updateGroup(id, patch) {
    try {
      await unwrap(window.uld.bots.updateGroup(id, patch))
      await get().load()
      return true
    } catch (e) {
      toastError('Failed to update group', e)
      return false
    }
  },

  async deleteGroup(id) {
    try {
      await unwrap(window.uld.bots.deleteGroup(id))
      if (get().activeGroupId === id) set({ activeGroupId: null, groupMessages: [] })
      await get().load()
    } catch (e) {
      toastError('Failed to disband group', e)
    }
  },

  async sendToGroup(groupId, content) {
    try {
      const group = get().roster?.groups.find(g => g.group.id === groupId)?.group
      if (!group) return false
      const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`group:${content.trim()}`))), n => n.toString(16).padStart(2, '0')).join('')
      const pending = getChatDraft(group.conversationId).pendingSend
      const id = pending?.fingerprint === fingerprint ? pending.id : crypto.randomUUID()
      await saveChatDraft(group.conversationId, { text: content, pendingSend: { id, fingerprint } })
      await unwrap(window.uld.bots.groupSend(groupId, content, id))
      await saveChatDraft(group.conversationId, { pendingSend: undefined }).catch(e => toastError('Message accepted, but the local receipt could not be cleared', e))
      void reloadGroupMessages(groupId)
      return true
    } catch (e) {
      toastError('Failed to send', e)
      return false
    }
  },

  async stopGroup(groupId) {
    try {
      await unwrap(window.uld.bots.groupStop(groupId))
    } catch (e) {
      toastError('Failed to stop the room', e)
    }
  },

  async setHidden(agentId, hidden) {
    try {
      await unwrap(window.uld.agents.update(agentId, { hidden }))
      await get().load()
    } catch (e) {
      toastError('Failed to update bot', e)
    }
  },

  setShowHidden(show) {
    set({ showHidden: show })
  },
}))
