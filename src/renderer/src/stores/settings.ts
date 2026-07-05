import { create } from 'zustand'
import { unwrap } from '@/api/uld'
import type { SettingsStoreState } from './contracts'
import { toastError } from './ui'

export const useSettingsStore = create<SettingsStoreState>()((set, get) => ({
  settings: null,
  loaded: false,

  async load() {
    try {
      const settings = await unwrap(window.uld.settings.get())
      set({ settings, loaded: true })
    } catch (e) {
      set({ loaded: true })
      toastError('Failed to load settings', e)
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
      toastError('Failed to save settings', e)
    }
  },
}))
