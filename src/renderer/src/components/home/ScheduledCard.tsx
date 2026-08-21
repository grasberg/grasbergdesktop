/**
 * The Home "Scheduled" card — the schedule hub: every workflow with a
 * schedule, its next run and latest-run status, pause/resume, Run now, and an
 * expandable inline run history. Editing still happens in the builder (the
 * pencil deep-links there).
 */

import { useState } from 'react'
import type { ScheduledWorkflowStatus } from '@shared/types'
import { isWorkflowRunning, nextRunLabel, scheduleLabel } from '@shared/workflow-status'
import { useNow } from '@/hooks/useNow'
import { Switch } from '@/components/common/controls'
import { useUiStore } from '@/stores/ui'
import { useWorkflowsStore } from '@/stores/workflows'
import RunHistory from './RunHistory'

const PencilIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M11.3 1.7a1.7 1.7 0 0 1 2.4 2.4l-8.2 8.2-3.2.8.8-3.2 8.2-8.2Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  </svg>
)

function dotClass(entry: ScheduledWorkflowStatus, running: boolean): string {
  if (running) return 'running'
  if (!entry.latestRun) return 'never'
  return entry.latestRun.status
}

export default function ScheduledCard(): React.JSX.Element {
  const scheduled = useWorkflowsStore((s) => s.scheduled)
  const loaded = useWorkflowsStore((s) => s.loaded)
  const runningIds = useWorkflowsStore((s) => s.runningIds)
  const now = useNow()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <section className="card home-card home-card-scheduled" aria-label="Scheduled tasks">
      <div className="home-card-head">
        <h2 className="home-card-title">Scheduled</h2>
        <button
          type="button"
          className="btn btn-ghost home-card-action"
          onClick={() => useUiStore.getState().openWorkflows(true)}
        >
          Open workflows
        </button>
      </div>

      {!loaded ? (
        <div aria-hidden="true">
          <div className="home-skeleton" />
          <div className="home-skeleton" />
        </div>
      ) : scheduled.length === 0 ? (
        <div className="home-empty">
          <p>
            Nothing scheduled yet. Give a workflow a schedule and it shows up here with its next
            run and result.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => useUiStore.getState().openWorkflows(true)}
          >
            Schedule a workflow
          </button>
        </div>
      ) : (
        <ul className="home-list">
          {scheduled.map((entry) => {
            const w = entry.workflow
            const running =
              runningIds[w.id] === true || isWorkflowRunning(w, entry.latestRun, now)
            const expanded = expandedId === w.id
            return (
              <li key={w.id}>
                <div className="home-row">
                  <span className={`run-dot ${dotClass(entry, running)}`} aria-hidden="true" />
                  <button
                    type="button"
                    className="home-row-main"
                    aria-expanded={expanded}
                    title={expanded ? 'Hide run history' : 'Show run history'}
                    onClick={() => setExpandedId(expanded ? null : w.id)}
                  >
                    <span className="home-row-title">{w.name}</span>
                    <span className="home-row-meta">
                      {w.schedule ? scheduleLabel(w.schedule) : 'no schedule'}
                      {' · '}
                      {running ? 'running…' : nextRunLabel(w, now)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn home-run-now"
                    disabled={running}
                    onClick={() => void useWorkflowsStore.getState().runNow(w.id)}
                  >
                    {running ? 'Running…' : 'Run now'}
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    aria-label={`Edit workflow ${w.name}`}
                    title="Edit in the workflow builder"
                    onClick={() => useUiStore.getState().openWorkflows(true, w.id)}
                  >
                    {PencilIcon}
                  </button>
                  <Switch
                    checked={w.scheduleEnabled}
                    label={`Schedule "${w.name}" ${w.scheduleEnabled ? 'on — click to pause' : 'off — click to resume'}`}
                    onChange={(checked) =>
                      void useWorkflowsStore.getState().toggleSchedule(entry, checked)
                    }
                  />
                </div>
                {expanded ? (
                  <RunHistory workflowId={w.id} latestRunId={entry.latestRun?.id ?? null} />
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
