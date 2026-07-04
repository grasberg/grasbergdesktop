/**
 * Zustand store for assistant memories: durable facts the assistant saves
 * across conversations, reviewed and managed in Settings → Memory.
 */

import { create } from 'zustand'
import type { Memory, MemoryInput, MemoryPatch } from '@shared/types'
import { toNormalized, unwrap } from '@/api/uld'
import { useUiStore } from './ui'

export interface MemoriesStoreState {
  memories: Memory[]
  loaded: boolean
  load(): Promise<void>
  /** Mutations reject with a NormalizedError on failure (callers toast). */
  create(input: MemoryInput): Promise<void>
  update(id: string, patch: MemoryPatch): Promise<void>
  remove(id: string): Promise<void>
}

export const useMemoriesStore = create<MemoriesStoreState>()((set, get) => ({
  memories: [],
  loaded: false,

  async load() {
    try {
      const memories = await unwrap(window.uld.memories.list())
      set({ memories, loaded: true })
    } catch (e) {
      set({ loaded: true })
      useUiStore.getState().toast(`Failed to load memories: ${toNormalized(e).message}`, 'error')
    }
  },

  async create(input) {
    await unwrap(window.uld.memories.create(input))
    await get().load()
  },

  async update(id, patch) {
    await unwrap(window.uld.memories.update(id, patch))
    await get().load()
  },

  async remove(id) {
    await unwrap(window.uld.memories.delete(id))
    await get().load()
  },
}))
