import { create } from 'zustand'
import { unwrap } from '@/api/uld'
import type { SpacesStoreState } from './contracts'
import { useConversationsStore } from './conversations'
import { toastError } from './ui'

/**
 * Private spaces (v45). `activeSpaceId` is renderer-session state only: every
 * launch lands in the default space, so a shared screen never boots into a
 * private one.
 */
export const useSpacesStore = create<SpacesStoreState>()((set, get) => ({
  spaces: [],
  activeSpaceId: null,
  loaded: false,

  async load() {
    try {
      const spaces = await unwrap(window.uld.spaces.list())
      set({ spaces, loaded: true })
    } catch (e) {
      set({ loaded: true })
      toastError('Failed to load spaces', e)
    }
  },

  setActive(id) {
    if (get().activeSpaceId === id) return
    set({ activeSpaceId: id })
    // Leave any open conversation (it may belong to the space just left).
    const conversations = useConversationsStore.getState()
    conversations.select(null)
    void conversations.load()
  },

  async create(name) {
    try {
      await unwrap(window.uld.spaces.create(name))
      await get().load()
    } catch (e) {
      toastError('Could not create the space', e)
    }
  },

  async rename(id, name) {
    try {
      await unwrap(window.uld.spaces.update(id, { name }))
      await get().load()
    } catch (e) {
      toastError('Could not rename the space', e)
    }
  },

  async setAllowlist(id, providerIds) {
    try {
      await unwrap(window.uld.spaces.update(id, { providerAllowlist: providerIds }))
      await get().load()
    } catch (e) {
      toastError('Could not update the allowlist', e)
    }
  },

  async remove(id) {
    try {
      await unwrap(window.uld.spaces.delete(id))
      if (get().activeSpaceId === id) get().setActive(null)
      await get().load()
    } catch (e) {
      // Surfaces the "space can only be deleted when empty" refusal.
      toastError('Could not delete the space', e)
    }
  },
}))
