/**
 * Zustand store for assistant memories: durable facts the assistant saves
 * across conversations, reviewed and managed in Settings → Memory.
 */

import { create } from 'zustand'
import type { DreamResult, Memory, MemoryInput, MemoryPatch } from '@shared/types'
import { unwrap } from '@/api/uld'
import { createSimpleListActions, type SimpleListActions } from './simple-list'

export interface MemoriesStoreState extends SimpleListActions<MemoryInput, MemoryPatch> {
  memories: Memory[]
  loaded: boolean
  /** Manual consolidation ("dreaming"); rejects with a NormalizedError. */
  dream(): Promise<DreamResult>
}

export const useMemoriesStore = create<MemoriesStoreState>()((set, get) => ({
  memories: [],
  loaded: false,

  ...createSimpleListActions<Memory, MemoryInput, MemoryPatch>({
    label: 'memories',
    api: window.uld.memories,
    onLoaded: (memories) => set({ memories, loaded: true }),
    onLoadFailed: () => set({ loaded: true }),
  }),

  async dream() {
    const result = await unwrap(window.uld.memories.dream())
    await get().load()
    return result
  },
}))
