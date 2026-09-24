import { create } from 'zustand'
import { toNormalized } from '@/api/uld'
import type { UiStoreState } from './contracts'
import { navigateGuarded } from '@/hooks/useUnsavedChanges'

let toastSeq = 0

export const useUiStore = create<UiStoreState>()((set, get) => ({
  resolvedTheme: 'dark',
  settingsOpen: false,
  settingsTab: 'providers',
  paletteOpen: false,
  shortcutsOpen: false,
  // Boot lands on the Home overview; selecting a conversation switches away.
  view: 'home',
  workflowsInitialId: null,
  artifactPreview: null,
  composerSeed: null,
  toasts: [],

  setResolvedTheme(t) {
    set({ resolvedTheme: t })
  },

  setView(view) {
    if (get().view !== view) navigateGuarded(() => set({ view }), 'page')
  },

  // The Workflows builder replaces the main area when open; closing it returns
  // to the conversation surface (which falls back to Home when none is open).
  // An optional workflow id deep-links the builder to that workflow (and is
  // cleared by any call without one, so it is consumed exactly once).
  openWorkflows(open, workflowId) {
    const change = (): void => set({ view: open ? 'workflows' : 'conversation', workflowsInitialId: workflowId ?? null })
    if (get().view === (open ? 'workflows' : 'conversation')) change()
    else navigateGuarded(change, 'page')
  },

  openSettings(open, tab) {
    const change = (): void => set({ settingsOpen: open, ...(tab ? { settingsTab: tab } : {}) })
    if (!open || (tab && tab !== get().settingsTab)) navigateGuarded(change, 'settings')
    else change()
  },

  openPalette(open) {
    set({ paletteOpen: open })
  },

  openShortcuts(open) {
    set({ shortcutsOpen: open })
  },

  openArtifactPreview(preview) {
    set({ artifactPreview: preview })
  },

  seedComposer(text) {
    set({ composerSeed: text })
  },

  clearComposerSeed() {
    set({ composerSeed: null })
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
