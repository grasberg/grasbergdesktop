import { create } from 'zustand'
import { unwrap } from '@/api/uld'
import { toastError } from './ui'
import type { ScheduledTasksStoreState } from './contracts'

function sortTasks(tasks: ScheduledTasksStoreState['tasks']): ScheduledTasksStoreState['tasks'] {
  return [...tasks].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    if (a.nextRunAt === null && b.nextRunAt !== null) return 1
    if (a.nextRunAt !== null && b.nextRunAt === null) return -1
    if (a.nextRunAt !== b.nextRunAt) return (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0)
    return b.updatedAt - a.updatedAt
  })
}

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
      set((state) => ({
        tasks: sortTasks([task, ...state.tasks.filter((t) => t.id !== task.id)]),
      }))
      return task
    } catch (error) {
      toastError('Could not create scheduled task', error)
      return null
    }
  },

  async update(id, input) {
    try {
      const task = await unwrap(window.uld.scheduledTasks.update(id, input))
      set(state => ({ tasks: sortTasks([task, ...state.tasks.filter(t => t.id !== id)]) }))
      return task
    } catch (error) { toastError('Could not save scheduled task', error); return null }
  },

  async setEnabled(id, enabled) {
    try {
      const task = await unwrap(window.uld.scheduledTasks.setEnabled(id, enabled))
      set((state) => ({
        tasks: sortTasks([task, ...state.tasks.filter((t) => t.id !== id)]),
      }))
    } catch (error) {
      toastError(enabled ? 'Could not resume scheduled task' : 'Could not pause scheduled task', error)
    }
  },

  async runNow(id) {
    try {
      const task = await unwrap(window.uld.scheduledTasks.runNow(id))
      set((state) => ({
        tasks: sortTasks([task, ...state.tasks.filter((t) => t.id !== id)]),
      }))
    } catch (error) {
      toastError('Could not run the task', error)
    }
  },

  async remove(id) {
    try {
      await unwrap(window.uld.scheduledTasks.delete(id))
      set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) }))
    } catch (error) {
      toastError('Could not remove scheduled task', error)
    }
  },

  handleChanged(event) {
    if (event.type === 'delete') {
      set((state) => ({ tasks: state.tasks.filter((task) => task.id !== event.id) }))
      return
    }
    set((state) => ({
      tasks: sortTasks([event.task, ...state.tasks.filter((task) => task.id !== event.task.id)]),
    }))
  },
}))
