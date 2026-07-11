import { create } from 'zustand'
import { unwrap } from '@/api/uld'
import { toastError } from './ui'
import type { ScheduledTasksStoreState } from './contracts'

export const useScheduledTasksStore = create<ScheduledTasksStoreState>()((set, get) => ({
  tasks: [],
  loaded: false,

  async load() {
    try {
      set({ tasks: await unwrap(window.uld.scheduledTasks.list()), loaded: true })
    } catch (error) {
      if (!get().loaded) toastError('Could not load scheduled tasks', error)
      set({ loaded: true })
    }
  },

  async create(input) {
    try {
      const task = await unwrap(window.uld.scheduledTasks.create(input))
      await get().load()
      return task
    } catch (error) {
      toastError('Could not create scheduled task', error)
      return null
    }
  },

  async setEnabled(id, enabled) {
    try {
      await unwrap(window.uld.scheduledTasks.setEnabled(id, enabled))
    } catch (error) {
      toastError(enabled ? 'Could not resume scheduled task' : 'Could not pause scheduled task', error)
    }
    await get().load()
  },

  async remove(id) {
    try {
      await unwrap(window.uld.scheduledTasks.delete(id))
    } catch (error) {
      toastError('Could not remove scheduled task', error)
    }
    await get().load()
  },
}))
