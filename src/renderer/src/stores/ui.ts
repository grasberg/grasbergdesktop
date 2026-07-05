import { create } from 'zustand'
import type { UiStoreState } from './contracts'

let toastSeq = 0

export const useUiStore = create<UiStoreState>()((set) => ({
  resolvedTheme: 'dark',
  settingsOpen: false,
  paletteOpen: false,
  shortcutsOpen: false,
  workflowsOpen: false,
  projectsOpen: false,
  toasts: [],

  setResolvedTheme(t) {
    set({ resolvedTheme: t })
  },

  // Workflows and Projects both replace the main area, so opening one
  // closes the other.
  openWorkflows(open) {
    set((s) => ({ workflowsOpen: open, projectsOpen: open ? false : s.projectsOpen }))
  },

  openProjects(open) {
    set((s) => ({ projectsOpen: open, workflowsOpen: open ? false : s.workflowsOpen }))
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
