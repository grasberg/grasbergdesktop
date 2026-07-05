/**
 * Shared "new conversation" behavior for the sidebar's New button/menu and the
 * global Ctrl/Cmd+N shortcut. (ProjectsView, EmptyState and CommandPalette
 * intentionally have their own variants — do not funnel them through here.)
 */

import type { ConversationMode } from '@shared/types'
import { useConversationsStore } from '@/stores/conversations'
import { toastError, useUiStore } from '@/stores/ui'

/**
 * Leaves the Workflows/Projects surface so the new conversation shows, then
 * creates and selects a conversation in the given mode, toasting on failure.
 */
export function newConversation(mode: ConversationMode): void {
  const ui = useUiStore.getState()
  ui.openWorkflows(false)
  ui.openProjects(false)
  useConversationsStore
    .getState()
    .create(mode)
    .catch((e: unknown) => {
      toastError('Could not create conversation', e)
    })
}

/** New conversation in the active mode tab ('All' falls back to chat). */
export function newTaskInActiveMode(): void {
  const filter = useConversationsStore.getState().modeFilter
  newConversation(filter === 'all' ? 'chat' : filter)
}
