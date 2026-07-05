/**
 * Zustand store for assistant memories: durable facts the assistant saves
 * across conversations, reviewed and managed in Settings → Memory.
 */

import { create } from 'zustand'
import type { Memory, MemoryInput, MemoryPatch } from '@shared/types'
import { createSimpleListActions, type SimpleListActions } from './simple-list'

export interface MemoriesStoreState extends SimpleListActions<MemoryInput, MemoryPatch> {
  memories: Memory[]
  loaded: boolean
}

export const useMemoriesStore = create<MemoriesStoreState>()((set) => ({
  memories: [],
  loaded: false,

  ...createSimpleListActions<Memory, MemoryInput, MemoryPatch>({
    label: 'memories',
    api: window.uld.memories,
    onLoaded: (memories) => set({ memories, loaded: true }),
    onLoadFailed: () => set({ loaded: true }),
  }),
}))
