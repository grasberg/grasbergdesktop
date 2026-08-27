/**
 * Optimizer runs (autonomous optimize-evaluate-commit loops per project).
 * Mirrors the scheduled-tasks store: list + push upserts, lazy version loads
 * for expanded rows.
 */

import { create } from 'zustand'
import type { OptimizerRun, OptimizerStartInput, OptimizerVersion } from '@shared/types'
import { unwrap } from '@/api/uld'
import { toastError } from './ui'
import type { OptimizerStoreState } from './contracts'

export const useOptimizerStore = create<OptimizerStoreState>()((set) => ({
  runs: [],
  loaded: false,
  versions: {},

  async load() {
    try {
      set({ runs: await unwrap(window.uld.optimizer.list()), loaded: true })
    } catch (error) {
      if (!useOptimizerStore.getState().loaded) toastError('Could not load optimizer runs', error)
      set({ loaded: true })
    }
  },

  async loadVersions(runId) {
    try {
      const versions = await unwrap(window.uld.optimizer.versions(runId))
      set((state) => ({ versions: { ...state.versions, [runId]: versions } }))
    } catch (error) {
      toastError('Could not load run history', error)
    }
  },

  async start(input) {
    try {
      const run = await unwrap(window.uld.optimizer.start(input))
      set((state) => ({ runs: [run, ...state.runs.filter((r) => r.id !== run.id)] }))
      return run
    } catch (error) {
      toastError('Could not start the optimizer', error)
      return null
    }
  },

  async stop(runId) {
    try {
      await unwrap(window.uld.optimizer.stop(runId))
    } catch (error) {
      toastError('Could not stop the optimizer', error)
    }
  },

  handleChanged(event) {
    set((state) => ({
      runs: [event.run, ...state.runs.filter((r) => r.id !== event.run.id)],
    }))
  },
}))

/** Re-exported so components can name the type without reaching into @shared. */
export type { OptimizerVersion }
