/**
 * Cross-workflow feed of the latest persisted runs — what the app did
 * recently, including scheduled runs that happened in the background.
 * A row opens its workflow in the builder (where the full output lives).
 */

import { relativeTime } from '@/lib/format'
import { useUiStore } from '@/stores/ui'
import { useWorkflowsStore } from '@/stores/workflows'

const SHOWN = 8

export default function RecentRunsCard(): React.JSX.Element {
  const recentRuns = useWorkflowsStore((s) => s.recentRuns)
  const loaded = useWorkflowsStore((s) => s.loaded)

  return (
    <section className="card home-card" aria-label="Recent runs">
      <div className="home-card-head">
        <h2 className="home-card-title">Recent runs</h2>
      </div>
      {!loaded ? (
        <div aria-hidden="true">
          <div className="home-skeleton" />
          <div className="home-skeleton" />
        </div>
      ) : recentRuns.length === 0 ? (
        <div className="home-empty">
          <p>Runs will appear here once a workflow executes.</p>
        </div>
      ) : (
        <ul className="home-list">
          {recentRuns.slice(0, SHOWN).map((run) => (
            <li key={run.id}>
              <button
                type="button"
                className="home-row-btn"
                title={`Open "${run.workflowName}" in the workflow builder`}
                onClick={() => useUiStore.getState().openWorkflows(true, run.workflowId)}
              >
                <span
                  className={`run-dot ${run.status === 'ok' ? 'ok' : 'error'}`}
                  aria-hidden="true"
                />
                <span className="home-row-main">
                  <span className="home-row-title">{run.workflowName}</span>
                  <span className="home-row-meta">{run.error ?? (run.output || '—')}</span>
                </span>
                {run.trigger === 'schedule' ? <span className="badge">schedule</span> : null}
                <span className="home-row-time">{relativeTime(run.startedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
