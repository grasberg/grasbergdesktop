import { create } from 'zustand'
import { toNormalized, unwrap } from '@/api/uld'
import type { SettingsStoreState } from './contracts'
import { useUiStore } from './ui'

export const useSettingsStore = create<SettingsStoreState>()((set, get) => ({
  settings: null,
  loaded: false,

  async load() {
    try {
      const settings = await unwrap(window.uld.settings.get())
      set({ settings, loaded: true })
    } catch (e) {
      set({ loaded: true })
      useUiStore.getState().toast(`Failed to load settings: ${toNormalized(e).message}`, 'error')
    }
  },

  async update(patch) {
    const prev = get().settings
    // Optimistic apply so theme/font-size changes feel instant.
    if (prev) set({ settings: { ...prev, ...patch } })
    try {
      const settings = await unwrap(window.uld.settings.update(patch))
      set({ settings })
    } catch (e) {
      if (prev) set({ settings: prev })
      useUiStore.getState().toast(`Failed to save settings: ${toNormalized(e).message}`, 'error')
    }
  },
}))
