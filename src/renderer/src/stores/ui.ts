import { create } from 'zustand'
import { toNormalized } from '@/api/uld'
import type { UiStoreState } from './contracts'

let toastSeq = 0

export const useUiStore = create<UiStoreState>()((set) => ({
  resolvedTheme: 'dark',
  settingsOpen: false,
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
    set({ view })
  },

  // The Workflows builder replaces the main area when open; closing it returns
  // to the conversation surface (which falls back to Home when none is open).
  // An optional workflow id deep-links the builder to that workflow (and is
  // cleared by any call without one, so it is consumed exactly once).
  openWorkflows(open, workflowId) {
    set({ view: open ? 'workflows' : 'conversation', workflowsInitialId: workflowId ?? null })
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
