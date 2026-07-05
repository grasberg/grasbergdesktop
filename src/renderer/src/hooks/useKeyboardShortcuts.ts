import { useEffect } from 'react'
import { toNormalized } from '@/api/uld'
import { useChatStore } from '@/stores/chat'
import { useConversationsStore } from '@/stores/conversations'
import { useUiStore } from '@/stores/ui'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/**
 * Global shortcuts:
 *   Ctrl/Cmd+N  new task in the active mode tab ('All' falls back to chat)
 *   Ctrl/Cmd+K  toggle command palette
 *   Ctrl/Cmd+,  toggle settings
 *   Escape      close palette/settings/shortcuts/projects, else stop generation
 * Plain keys are ignored while typing in an input/textarea; Escape and
 * Ctrl/Cmd combos always work.
 */
export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (isEditableTarget(e.target) && !mod && e.key !== 'Escape') return

      if (mod && !e.shiftKey && !e.altKey) {
        const key = e.key.toLowerCase()
        if (key === 'n') {
          e.preventDefault()
          const ui = useUiStore.getState()
          ui.openWorkflows(false)
          ui.openProjects(false)
          const filter = useConversationsStore.getState().modeFilter
          useConversationsStore
            .getState()
            .create(filter === 'all' ? 'chat' : filter)
            .catch((err: unknown) => {
              useUiStore
                .getState()
                .toast(`Could not create conversation: ${toNormalized(err).message}`, 'error')
            })
          return
        }
        if (key === 'k') {
          e.preventDefault()
          const ui = useUiStore.getState()
          ui.openPalette(!ui.paletteOpen)
          return
        }
        if (e.key === ',') {
          e.preventDefault()
          const ui = useUiStore.getState()
          ui.openSettings(!ui.settingsOpen)
          return
        }
      }

      if (e.key === 'Escape' && !mod && !e.shiftKey && !e.altKey) {
        const ui = useUiStore.getState()
        if (ui.paletteOpen) {
          ui.openPalette(false)
          return
        }
        if (ui.settingsOpen) {
          ui.openSettings(false)
          return
        }
        if (ui.shortcutsOpen) {
          ui.openShortcuts(false)
          return
        }
        if (ui.projectsOpen) {
          ui.openProjects(false)
          return
        }
        const chat = useChatStore.getState()
        if (chat.streaming) void chat.stop()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
