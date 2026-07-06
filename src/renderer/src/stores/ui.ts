import { create } from 'zustand'
import { toNormalized } from '@/api/uld'
import type { UiStoreState } from './contracts'

let toastSeq = 0

export const useUiStore = create<UiStoreState>()((set) => ({
  resolvedTheme: 'dark',
  settingsOpen: false,
  paletteOpen: false,
  shortcutsOpen: false,
  workflowsOpen: false,
  toasts: [],

  setResolvedTheme(t) {
    set({ resolvedTheme: t })
  },

  // The Workflows builder replaces the main area when open.
  openWorkflows(open) {
    set({ workflowsOpen: open })
  },

  openSettings(open) {
    set({ settingsOpen: open })
  },

  openPalette(open) {
    set({ paletteOpen: open })
  },

  openShortcuts(open) {
    set({ shortcutsOpen: open })
  },

  toast(message, kind = 'info') {
    toastSeq += 1
    set((s) => ({ toasts: [...s.toasts, { id: `toast-${toastSeq}`, kind, message }] }))
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))

/** Toasts a store/IPC failure as `${prefix}: ${message}`. */
export function toastError(prefix: string, e: unknown): void {
  useUiStore.getState().toast(`${prefix}: ${toNormalized(e).message}`, 'error')
}
