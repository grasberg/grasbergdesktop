/**
 * Settings → Activity: every tool call the app made, newest first, with the
 * reason it was allowed to run.
 *
 * This is the answer to "what did it do while I was away, and who let it?" —
 * so the design leans on being scannable rather than pretty: one row per call,
 * the decision as a colour-coded chip, and arguments/result folded away until
 * asked for. Filters narrow by decision (e.g. only what a human approved) and
 * by free text over the tool, reason, arguments and result.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { ActivityDecision, ActivityEntry } from '@shared/types'
import { ConfirmButton } from '@/components/common/controls'
import { RiskBadge } from '@/components/ToolApprovalDialog'
import { useUiStore } from '@/stores/ui'
import './settings.css'

const DECISION_LABEL: Record<ActivityDecision, string> = {
  auto: 'Ran automatically',
  rule: 'Allowed by a rule',
  approved: 'You approved it',
  declined: 'Declined',
  blocked: 'Blocked',
}

const FILTERS: ReadonlyArray<{ value: ActivityDecision | 'all'; label: string }> = [
  { value: 'all', label: 'Everything' },
  { value: 'approved', label: 'You approved' },
  { value: 'auto', label: 'Automatic' },
  { value: 'rule', label: 'By a rule' },
  { value: 'declined', label: 'Declined' },
  { value: 'blocked', label: 'Blocked' },
]

const PAGE_SIZE = 100

function formatTime(at: number): string {
  return new Date(at).toLocaleString()
}

function ActivityRow({ entry }: { entry: ActivityEntry }): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <li className={`activity-row activity-${entry.decision}`}>
      <button
        type="button"
        className="activity-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="activity-time">{formatTime(entry.at)}</span>
        <span className="mono activity-tool">{entry.toolName}</span>
        <RiskBadge risk={entry.risk} />
        <span className={`badge activity-decision activity-decision-${entry.decision}`}>
          {DECISION_LABEL[entry.decision]}
        </span>
        {entry.agentName ? <span className="activity-agent">{entry.agentName}</span> : null}
        <span className="activity-detail">{entry.detail}</span>
      </button>
      {open ? (
        <div className="activity-body">
          <span className="activity-label">Arguments</span>
          <pre className="mono activity-pre" tabIndex={0}>
            {entry.arguments || '(none)'}
          </pre>
          <span className="activity-label">Result</span>
          <pre className="mono activity-pre" tabIndex={0}>
            {entry.result || '(none)'}
          </pre>
          {entry.changeId ? (
            <p className="field-hint">
              This call proposed a file change — open it in the Changes panel of its conversation to
              see the diff.
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

export default function ActivityTab(): ReactElement {
  const toast = useUiStore((s) => s.toast)
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [total, setTotal] = useState(0)
  const [decision, setDecision] = useState<ActivityDecision | 'all'>('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(
    async (before?: number) => {
      setLoading(true)
      const res = await window.uld.activity.list({
        limit: PAGE_SIZE,
        ...(before ? { before } : {}),
        ...(decision === 'all' ? {} : { decision }),
        ...(search.trim() ? { search: search.trim() } : {}),
      })
      setLoading(false)
      if (!res.ok) return
      setTotal(res.data.total)
      // `before` means "older than the last row I have": append rather than
      // replace, so paging back does not lose what is already on screen.
      setEntries((current) => (before ? [...current, ...res.data.entries] : res.data.entries))
    },
    [decision, search]
  )

  useEffect(() => {
    void load()
  }, [load])

  const oldest = entries.length > 0 ? entries[entries.length - 1].at : null
  const canLoadMore = entries.length > 0 && entries.length % PAGE_SIZE === 0

  return (
    <section aria-label="Activity">
      <header className="tab-header">
        <div>
          <h3>Activity</h3>
          <p className="field-hint">
            Every tool call this app made, and why it was allowed to. Recorded locally as it
            happens — including the calls that were refused. Arguments and results are redacted of
            anything key-shaped before they are stored.
          </p>
        </div>
        {total > 0 ? (
          <div className="prompt-form-actions">
            <ConfirmButton
              label="Clear log"
              prompt="Delete the whole activity log?"
              onConfirm={async () => {
                const res = await window.uld.activity.clear()
                if (!res.ok) {
                  toast('Could not clear the activity log.', 'error')
                  return
                }
                setEntries([])
                setTotal(0)
              }}
            />
          </div>
        ) : null}
      </header>

      <div className="activity-filters">
        <select
          className="select"
          value={decision}
          aria-label="Filter by decision"
          onChange={(e) => setDecision(e.target.value as ActivityDecision | 'all')}
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <input
          className="input"
          value={search}
          placeholder="Search tool, reason, arguments or result…"
          aria-label="Search the activity log"
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading && entries.length === 0 ? (
        <p className="field-hint">Loading…</p>
      ) : entries.length === 0 ? (
        <div className="empty-state card">
          <p>
            {total === 0
              ? 'Nothing recorded yet. Tool calls show up here as the assistant makes them.'
              : 'No entries match this filter.'}
          </p>
        </div>
      ) : (
        <>
          <ul className="activity-list">
            {entries.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}
          </ul>
          <p className="field-hint">
            Showing {entries.length} of {total} recorded calls.
          </p>
          {canLoadMore && oldest !== null ? (
            <button
              type="button"
              className="btn"
              disabled={loading}
              onClick={() => void load(oldest)}
            >
              {loading ? 'Loading…' : 'Load older'}
            </button>
          ) : null}
        </>
      )}
    </section>
  )
}
