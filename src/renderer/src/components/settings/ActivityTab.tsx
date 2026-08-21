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

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { ActivityCursor, ActivityDecision, ActivityEntry } from '@shared/types'
import { ConfirmButton } from '@/components/common/controls'
import { RiskBadge } from '@/components/ToolApprovalDialog'
import { dateTime, prettyJson } from '@/lib/format'
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

/** Only the settled search term reaches the DB — every keystroke would
 * otherwise run four leading-wildcard LIKE predicates over the whole log. */
const SEARCH_DEBOUNCE_MS = 250

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
        <span className="activity-time">{dateTime(entry.at)}</span>
        <span className="mono activity-tool">{entry.toolName}</span>
        <RiskBadge risk={entry.risk} />
        <span className={`badge activity-decision-${entry.decision}`}>
          {DECISION_LABEL[entry.decision]}
        </span>
        {entry.agentName ? <span className="activity-agent">{entry.agentName}</span> : null}
        <span className="activity-detail">{entry.detail}</span>
      </button>
      {open ? (
        <div className="activity-body">
          <span className="activity-label">Arguments</span>
          <pre className="mono activity-pre" tabIndex={0}>
            {entry.arguments ? prettyJson(entry.arguments) : '(none)'}
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
  const [cursor, setCursor] = useState<ActivityCursor | null>(null)
  const [total, setTotal] = useState(0)
  const [decision, setDecision] = useState<ActivityDecision | 'all'>('all')
  const [search, setSearch] = useState('')
  const [settledSearch, setSettledSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Requests are answered out of order: a "Load older" still in flight when the
  // filter changes would otherwise append the previous filter's rows AND store
  // its cursor, so the next page would be keyed off a row the new WHERE clause
  // never selected — silently skipping entries. Only the newest request may
  // touch state; a superseded one leaves `loading` alone too, since the request
  // that replaced it owns clearing it.
  const requestId = useRef(0)

  useEffect(() => {
    const timer = setTimeout(() => setSettledSearch(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  const load = useCallback(
    async (before?: ActivityCursor) => {
      const id = (requestId.current += 1)
      setLoading(true)
      setError(null)

      // A load that returned no rows must not leave a keyset behind: a cursor
      // means something only paired with the entries it came from. A failed
      // FIRST page has none of its own, and what is on screen belongs to the
      // query the user just replaced — keeping that cursor would arm "Load
      // older" with a keyset from a row the new WHERE clause never selects, and
      // paging on it would splice an arbitrary slice under the old page. So
      // clear the page instead and say why. A failed OLDER page is the other
      // case: its rows and its cursor both still belong to the current query (a
      // filter change would have superseded this request), so they stay put and
      // the button simply becomes a retry.
      const fail = (message: string): void => {
        setLoading(false)
        setError(message)
        if (before) return
        setEntries([])
        setCursor(null)
        // Nothing was read, so there is no honest count to keep either.
        setTotal(0)
      }

      const res = await window.uld.activity
        .list({
          limit: PAGE_SIZE,
          ...(before ? { before } : {}),
          ...(decision === 'all' ? {} : { decision }),
          ...(settledSearch ? { search: settledSearch } : {}),
        })
        // The handler normalizes its own errors, so a rejection means the
        // channel itself is gone; without catching it the flag would never come
        // back down and the view would say "Loading…" forever.
        .catch(() => null)
      if (requestId.current !== id) return
      if (!res) {
        fail('Could not read the activity log.')
        return
      }
      if (!res.ok) {
        fail(res.error.message)
        return
      }
      setLoading(false)
      setTotal(res.data.total)
      // Null once the log has been paged to its end, which is what hides the
      // button — a full page is not the same thing as there being more.
      setCursor(res.data.cursor)
      // `before` means "older than the last row I have": append rather than
      // replace, so paging back does not lose what is already on screen.
      setEntries((current) => (before ? [...current, ...res.data.entries] : res.data.entries))
    },
    [decision, settledSearch]
  )

  useEffect(() => {
    void load()
  }, [load])

  // Shown next to whatever the failure left behind — beside the empty state
  // when the first page failed, beside the list when an older page did — so the
  // reason sits where the user was looking rather than at the top of a long
  // scroll.
  const errorNote = error ? (
    <p className="form-error" role="alert">
      {error}
    </p>
  ) : null

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
                // Same reason: a page still in flight would repopulate the log
                // we just deleted, so retire it here and release its flag.
                requestId.current += 1
                setEntries([])
                setCursor(null)
                setTotal(0)
                setLoading(false)
                setError(null)
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
          {errorNote}
          <p>
            {error
              ? 'The log could not be read, so nothing is listed. What was recorded is still there — try again.'
              : total === 0
                ? 'Nothing recorded yet. Tool calls show up here as the assistant makes them.'
                : 'No entries match this filter.'}
          </p>
          {error ? (
            // Only ever rendered with `loading` false: a retry in flight takes
            // the "Loading…" branch above, card and all.
            <button type="button" className="btn" onClick={() => void load()}>
              Try again
            </button>
          ) : null}
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
          {errorNote}
          {cursor !== null ? (
            <button
              type="button"
              className="btn"
              disabled={loading}
              onClick={() => void load(cursor)}
            >
              {loading ? 'Loading…' : 'Load older'}
            </button>
          ) : null}
        </>
      )}
    </section>
  )
}
