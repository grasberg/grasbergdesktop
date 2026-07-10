import { useState, type ReactElement } from 'react'
import type { ResearchActivity, ResearchRunInfo } from '@shared/types'
import './chat.css'

/**
 * Deep Research transparency, modeled on the MoA advisors block: while the
 * run streams it shows the live activity list (planning / searching / reading
 * / synthesizing, upserted by id); afterwards it collapses to a summary line
 * with the plan topics and the numbered source list behind a toggle.
 */

function statusIcon(status: ResearchActivity['status']): string {
  if (status === 'running') return '◌'
  if (status === 'error') return '✕'
  return '✓'
}

function ActivityRow({ activity }: { activity: ResearchActivity }): ReactElement {
  return (
    <div className={`msg-research-activity msg-research-activity-${activity.status}`}>
      <span className="msg-research-activity-icon" aria-hidden>
        {statusIcon(activity.status)}
      </span>
      <span className="msg-research-activity-label">{activity.label}</span>
    </div>
  )
}

export default function ResearchProgress({
  research,
  streaming,
}: {
  research: ResearchRunInfo
  streaming: boolean
}): ReactElement {
  const [open, setOpen] = useState(false)
  const activities = research.activities ?? []
  // Live while the generation streams; the persisted message that replaces it
  // on 'done' has no activities, so the block collapses to the summary.
  const live = streaming && activities.length > 0
  const running = activities.filter((a) => a.status === 'running')
  const liveLabel = running.length > 0 ? running[running.length - 1].label : 'Researching…'
  const expanded = open || live

  const summaryParts: string[] = []
  if (research.searches > 0) {
    summaryParts.push(`${research.searches} ${research.searches === 1 ? 'search' : 'searches'}`)
  }
  if (research.pagesRead > 0) {
    summaryParts.push(`${research.pagesRead} ${research.pagesRead === 1 ? 'page' : 'pages'}`)
  }
  summaryParts.push(
    `${research.sources.length} ${research.sources.length === 1 ? 'source' : 'sources'}`
  )

  return (
    <div className="msg-moa msg-research">
      <button
        type="button"
        className="msg-moa-toggle"
        aria-expanded={expanded}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`msg-moa-chevron${expanded ? ' open' : ''}`} aria-hidden>
          ▸
        </span>
        Deep research · {research.depth}
        {live ? (
          <span className="msg-moa-live">{liveLabel}</span>
        ) : (
          <span className="msg-research-summary">{summaryParts.join(' · ')}</span>
        )}
      </button>
      {expanded && (
        <div className="msg-moa-body">
          {live ? (
            <div className="msg-research-activities">
              {activities.map((a) => (
                <ActivityRow key={a.id} activity={a} />
              ))}
            </div>
          ) : (
            <>
              {research.plan.length > 0 && (
                <div className="msg-research-plan">
                  <div className="msg-research-heading">Research topics</div>
                  <ul>
                    {research.plan.map((topic, i) => (
                      <li key={i}>{topic}</li>
                    ))}
                  </ul>
                </div>
              )}
              {research.sources.length > 0 ? (
                <div className="msg-research-sources">
                  <div className="msg-research-heading">Sources</div>
                  <ol>
                    {research.sources.map((source) => (
                      <li key={source.id} className="msg-research-source">
                        <a href={source.url} target="_blank" rel="noreferrer" title={source.url}>
                          {source.title}
                        </a>
                        {source.status === 'search-only' && (
                          <span className="msg-research-source-note"> (search result)</span>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : (
                <div className="msg-moa-ref-empty">
                  No sources were collected — web research was unavailable for this run.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
