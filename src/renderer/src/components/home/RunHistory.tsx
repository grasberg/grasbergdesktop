/**
 * Inline run history for one workflow, lazy-loaded on expand: status dot,
 * trigger, when, duration, and a one-line output/error snippet. Re-fetches
 * when a new run lands (latestRunId changes) so an expanded list stays live.
 */

import { useEffect, useState } from 'react'
import type { WorkflowRun } from '@shared/types'
import { formatDuration } from '@shared/workflow-status'
import { unwrap } from '@/api/uld'
import { relativeTime } from '@/lib/format'

const HISTORY_LIMIT = 10

export default function RunHistory({
  workflowId,
  latestRunId,
}: {
  workflowId: string
  latestRunId: string | null
}): React.JSX.Element {
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void unwrap(window.uld.workflows.runs(workflowId))
      .then((all) => {
        if (!cancelled) setRuns(all.slice(0, HISTORY_LIMIT))
      })
      .catch(() => {
        if (!cancelled) setRuns([])
      })
    return () => {
      cancelled = true
    }
  }, [workflowId, latestRunId])

  if (runs === null) return <div className="home-history-empty">Loading…</div>
  if (runs.length === 0) return <div className="home-history-empty">No runs recorded yet.</div>
  return (
    <ul className="home-history" aria-label="Run history">
      {runs.map((r) => (
        <li key={r.id} className="home-history-row">
          <span className={`run-dot ${r.status === 'ok' ? 'ok' : 'error'}`} aria-hidden="true" />
          <span className="badge">{r.trigger}</span>
          <span className="home-history-when">{relativeTime(r.startedAt)}</span>
          <span className="home-history-duration">{formatDuration(r.finishedAt - r.startedAt)}</span>
          <span className="home-snippet">{r.error ?? (r.output || '—')}</span>
        </li>
      ))}
    </ul>
  )
}
