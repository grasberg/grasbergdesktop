import { useEffect } from 'react'
import { newTaskInActiveMode } from '@/lib/new-conversation'
import { useChatStore } from '@/stores/chat'
import { useUiStore } from '@/stores/ui'

/**
 * The Ctrl/Cmd single-key combos owned by the global handler below
 * (lower-cased e.key values). App.tsx swallows exactly these while
 * onboarding is showing.
 */
export const GLOBAL_SHORTCUT_KEYS: readonly string[] = ['n', 'k', ',']

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
 *   Escape      close palette/settings/shortcuts, else stop generation
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
          newTaskInActiveMode()
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
        const chat = useChatStore.getState()
        if (chat.streaming) void chat.stop()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
