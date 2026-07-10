/**
 * Sidebar "Scheduled tasks" section: every workflow with an interval
 * schedule, with a pause/resume switch and a deep link into the Workflows
 * builder. The list re-syncs whenever the builder closes (the only surface
 * where schedules are created or edited) and after each toggle here.
 */

import { useCallback, useEffect, useState } from 'react'
import type { Workflow } from '@shared/types'
import { unwrap } from '@/api/uld'
import { relativeTime } from '@/lib/format'
import { Switch } from '@/components/common/controls'
import { toastError, useUiStore } from '@/stores/ui'

/** "every 90m" → "every 1.5h" style label for the schedule interval. */
function intervalLabel(everyMinutes: number): string {
  if (everyMinutes < 60) return `every ${everyMinutes}m`
  if (everyMinutes % 60 === 0) return `every ${everyMinutes / 60}h`
  return `every ${(everyMinutes / 60).toFixed(1)}h`
}

export default function ScheduledTasks(): React.JSX.Element {
  const workflowsOpen = useUiStore((s) => s.workflowsOpen)
  const [scheduled, setScheduled] = useState<Workflow[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const workflows = await unwrap(window.uld.workflows.list())
      setScheduled(workflows.filter((w) => w.schedule !== null))
    } catch {
      // The section is a convenience view — stay quiet on load failures.
    }
  }, [])

  // Initial load, and a re-sync each time the Workflows builder closes.
  useEffect(() => {
    if (!workflowsOpen) void load()
  }, [workflowsOpen, load])

  const toggle = async (workflow: Workflow, enabled: boolean): Promise<void> => {
    setBusyId(workflow.id)
    try {
      await unwrap(
        window.uld.workflows.update(workflow.id, {
          name: workflow.name,
          graph: workflow.graph,
          schedule: workflow.schedule,
          scheduleEnabled: enabled,
        })
      )
      await load()
    } catch (e) {
      toastError('Could not update the schedule', e)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="sched-section">
      <div className="sidebar-section-head">
        <span className="sidebar-section-title">Scheduled tasks</span>
        <button
          type="button"
          className="btn-icon"
          aria-label="Open workflows to schedule a task"
          title="Schedule a workflow"
          onClick={() => useUiStore.getState().openWorkflows(true)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {scheduled.length === 0 ? (
        <div className="sched-empty">
          None yet — open a workflow and turn on its schedule.
        </div>
      ) : (
        <ul className="sched-list">
          {scheduled.map((w) => (
            <li key={w.id} className={`sched-item${w.scheduleEnabled ? '' : ' sched-item-paused'}`}>
              <button
                type="button"
                className="sched-item-main"
                title={`Open "${w.name}" in the workflow builder`}
                onClick={() => useUiStore.getState().openWorkflows(true, w.id)}
              >
                <span className="sched-item-name">{w.name}</span>
                <span className="sched-item-meta">
                  {intervalLabel(w.schedule?.everyMinutes ?? 60)}
                  {w.scheduleEnabled
                    ? w.lastRunAt
                      ? ` · last run ${relativeTime(w.lastRunAt)}`
                      : ' · not run yet'
                    : ' · paused'}
                </span>
              </button>
              <Switch
                checked={w.scheduleEnabled}
                disabled={busyId === w.id}
                label={`Schedule "${w.name}" ${w.scheduleEnabled ? 'on — click to pause' : 'off — click to resume'}`}
                onChange={(checked) => void toggle(w, checked)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
