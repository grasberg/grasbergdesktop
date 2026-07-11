/**
 * Shared "new conversation" behavior for the sidebar's New button/menu, the
 * global Ctrl/Cmd+N shortcut, and Home's quick actions. (CommandPalette
 * intentionally has its own variant — do not funnel it through here.)
 */

import type { ConversationMode } from '@shared/types'
import { useConversationsStore } from '@/stores/conversations'
import { toastError, useUiStore } from '@/stores/ui'

/**
 * Leaves the Workflows surface, switches the sidebar to `mode` (its own
 * projects + tasks), and creates+selects a fresh unfiled task there.
 */
export function newConversation(mode: ConversationMode): void {
  useUiStore.getState().openWorkflows(false)
  const convs = useConversationsStore.getState()
  // Switch the current mode first (also clears the previous mode's project
  // filter), then create the task unfiled in the target mode.
  convs.setModeFilter(mode)
  useConversationsStore
    .getState()
    .create(mode, null)
    .catch((e: unknown) => {
      toastError('Could not create conversation', e)
    })
}

/**
 * New standalone (unfiled) task in the current mode. To create a task inside a
 * project, the sidebar calls `create(mode, projectId)` directly from the
 * project's "+" button.
 */
export function newTaskInActiveMode(): void {
  useUiStore.getState().openWorkflows(false)
  const convs = useConversationsStore.getState()
  convs.create(convs.modeFilter, null).catch((e: unknown) => {
    toastError('Could not create conversation', e)
  })
}
