/**
 * Bot Mode (v46) store: the Bots pane roster (bots + group rooms), the open
 * room's transcript, and roster actions. One app-wide subscription to
 * push:botsChanged keeps everything live — deliveries, group turns and
 * routine mirrors all land as coarse "refetch" events.
 */

import { create } from 'zustand'
import type { BotGroup, BotGroupActivation, BotRoster, Message } from '@shared/types'
import { unwrap } from '@/api/uld'
import { useConversationsStore } from './conversations'
import { toastError } from './ui'

export interface BotsStoreState {
  roster: BotRoster | null
  loaded: boolean
  /** Room open in the Bots view, or null = roster/empty state. */
  activeGroupId: string | null
  /** Transcript of the open room (refetched on push events). */
  groupMessages: Message[]
  /** Show hidden bots (dimmed) in the roster. */
  showHidden: boolean

  load(): Promise<void>
  /** Opens the bot's canonical chat in the conversation surface. */
  openBotChat(agentId: string): Promise<void>
  selectGroup(groupId: string | null): void
  createGroup(
    name: string,
    memberIds: string[],
    activation?: BotGroupActivation,
    observerIds?: string[]
  ): Promise<BotGroup | null>
  updateGroup(
    id: string,
    patch: {
      name?: string
      memberIds?: string[]
      activation?: BotGroupActivation
      observerIds?: string[]
    }
  ): Promise<void>
  deleteGroup(id: string): Promise<void>
  sendToGroup(groupId: string, content: string): Promise<void>
  stopGroup(groupId: string): Promise<void>
  setHidden(agentId: string, hidden: boolean): Promise<void>
  setShowHidden(show: boolean): void
}

let pushSubscribed = false
function ensureBotsSubscription(): void {
  if (pushSubscribed) return
  pushSubscribed = true
  window.uld.bots.onChanged((event) => {
    const state = useBotsStore.getState()
    void state.load()
    if (event.groupId && event.groupId === state.activeGroupId) {
      void reloadGroupMessages(event.groupId)
    }
  })
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
    ensureBotsSubscription()
    try {
      const roster = await unwrap(window.uld.bots.roster())
      set({ roster, loaded: true })
    } catch (e) {
      set({ loaded: true })
      toastError('Failed to load bots', e)
    }
  },

  async openBotChat(agentId) {
    try {
      const { conversationId } = await unwrap(window.uld.bots.openChat(agentId))
      useConversationsStore.getState().select(conversationId)
    } catch (e) {
      toastError('Failed to open bot chat', e)
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

  async createGroup(name, memberIds, activation, observerIds) {
    try {
      const group = await unwrap(
        window.uld.bots.createGroup({ name, memberIds, activation, observerIds })
      )
      await get().load()
      set({ activeGroupId: group.id, groupMessages: [] })
      return group
    } catch (e) {
      toastError('Failed to create group', e)
      return null
    }
  },

  async updateGroup(id, patch) {
    try {
      await unwrap(window.uld.bots.updateGroup(id, patch))
      await get().load()
    } catch (e) {
      toastError('Failed to update group', e)
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
      await unwrap(window.uld.bots.groupSend(groupId, content))
      void reloadGroupMessages(groupId)
    } catch (e) {
      toastError('Failed to send', e)
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
