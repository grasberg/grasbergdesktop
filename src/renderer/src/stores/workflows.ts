/**
 * Scheduled-workflow overview shared by the Home view, the sidebar Scheduled
 * section, and the failure indicator. Loaded from workflows:overview and kept
 * live by the workflowRunFinished push event (wired once in App.tsx).
 */

import { create } from 'zustand'
import { unwrap } from '@/api/uld'
import type { WorkflowsStoreState } from './contracts'
import { toastError, useUiStore } from './ui'

/** Kept in sync with the overview IPC's recent-runs bound. */
const RECENT_RUNS_MAX = 20

export const useWorkflowsStore = create<WorkflowsStoreState>()((set, get) => ({
  scheduled: [],
  recentRuns: [],
  loaded: false,
  runningIds: {},

  async load() {
    try {
      const overview = await unwrap(window.uld.workflows.overview())
      set({ scheduled: overview.scheduled, recentRuns: overview.recentRuns, loaded: true })
    } catch (e) {
      // One failure note, not one per surface refresh.
      if (!get().loaded) toastError('Failed to load the workflow overview', e)
      set({ loaded: true })
    }
  },

  async runNow(id) {
    if (get().runningIds[id]) return
    const name = get().scheduled.find((s) => s.workflow.id === id)?.workflow.name ?? 'Workflow'
    set((s) => ({ runningIds: { ...s.runningIds, [id]: true } }))
    try {
      const result = await unwrap(window.uld.workflows.runById(id))
      if (result.ok) {
        useUiStore.getState().toast(`"${name}" finished.`, 'success')
      } else {
        useUiStore.getState().toast(`"${name}" failed: ${result.error ?? 'unknown error'}`, 'error')
      }
    } catch (e) {
      toastError(`Could not run "${name}"`, e)
    } finally {
      set((s) => {
        const runningIds = { ...s.runningIds }
        delete runningIds[id]
        return { runningIds }
      })
    }
    // The push event usually lands first; this reload is an idempotent
    // catch-all (it also drops workflows deleted while the run was in flight).
    await get().load()
  },

  async toggleSchedule(status, enabled) {
    const w = status.workflow
    try {
      // update is a patch: every key left out keeps whatever is stored, so
      // this (possibly stale) overview snapshot can never write back a name,
      // a graph, a schedule or the trigger opt-in. Pausing is one field.
      await unwrap(window.uld.workflows.update(w.id, { scheduleEnabled: enabled }))
    } catch (e) {
      toastError('Could not update the schedule', e)
    }
    await get().load()
  },

  handleRunFinished(evt) {
    const { run } = evt
    set((s) => {
      const recentRuns = [run, ...s.recentRuns.filter((r) => r.id !== run.id)].slice(
        0,
        RECENT_RUNS_MAX
      )
      const scheduled = s.scheduled.map((entry) =>
        entry.workflow.id === run.workflowId
          ? { workflow: { ...entry.workflow, lastRunAt: run.startedAt }, latestRun: run }
          : entry
      )
      const runningIds = { ...s.runningIds }
      delete runningIds[run.workflowId]
      return { recentRuns, scheduled, runningIds }
    })
    // Scheduled failures happen with no user action in flight — surface them.
    // Manual runs already toast from runNow, so no double toast here.
    if (run.trigger === 'schedule' && run.status === 'error') {
      useUiStore.getState().toast(`Scheduled workflow "${run.workflowName}" failed`, 'error')
    }
  },
}))

/** True when any enabled schedule's latest run failed (the sidebar red dot). */
export function hasScheduleFailure(s: Pick<WorkflowsStoreState, 'scheduled'>): boolean {
  return s.scheduled.some((e) => e.workflow.scheduleEnabled && e.latestRun?.status === 'error')
}
