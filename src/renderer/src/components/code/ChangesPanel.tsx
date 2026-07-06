import { useState, type ReactElement } from 'react'
import type { CodeChange } from '@shared/types'
import { useCodeStore } from '@/stores/code'
import DiffView from './DiffView'
import './code.css'

const TYPE_LABEL: Record<CodeChange['changeType'], string> = {
  create: 'create',
  edit: 'edit',
  delete: 'delete',
}

function ChangeItem({ change }: { change: CodeChange }): ReactElement {
  const busyChangeId = useCodeStore((s) => s.busyChangeId)
  const applyChange = useCodeStore((s) => s.applyChange)
  const rejectChange = useCodeStore((s) => s.rejectChange)
  const revertChange = useCodeStore((s) => s.revertChange)

  const [expanded, setExpanded] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmingRevert, setConfirmingRevert] = useState(false)

  const busy = busyChangeId === change.id
  const proposed = change.status === 'proposed'
  const applied = change.status === 'applied'

  return (
    <div className={`code-change card ${proposed ? '' : 'code-change-past'}`}>
      <button
        type="button"
        className="code-change-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`code-change-chevron ${expanded ? 'open' : ''}`} aria-hidden>
          ▸
        </span>
        <span className="code-change-path" title={change.filePath}>
          {change.filePath}
        </span>
        <span className={`badge code-change-type code-change-type-${change.changeType}`}>
          {TYPE_LABEL[change.changeType]}
        </span>
        {!proposed && <span className="badge">{change.status}</span>}
      </button>

      {expanded && (
        <div className="code-change-body">
          {change.diff.trim() ? (
            <DiffView diff={change.diff} />
          ) : (
            <div className="code-change-nodiff">No diff available for this change.</div>
          )}
        </div>
      )}

      {proposed && !confirming && (
        <div className="code-change-actions">
          <button
            type="button"
            className="btn btn-primary code-change-btn"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Apply
          </button>
          <button
            type="button"
            className="btn btn-ghost code-change-btn"
            disabled={busy}
            onClick={() => void rejectChange(change.id)}
          >
            {busy ? 'Working…' : 'Reject'}
          </button>
        </div>
      )}

      {proposed && confirming && (
        <div className="code-change-confirm" role="alertdialog" aria-label="Confirm apply">
          <span className="code-change-confirm-text">
            {change.changeType === 'delete' ? 'Delete' : 'Write to'}{' '}
            <strong>{change.filePath}</strong>?
          </span>
          <div className="code-change-actions">
            <button
              type="button"
              className="btn btn-primary code-change-btn"
              disabled={busy}
              onClick={() => {
                setConfirming(false)
                void applyChange(change.id)
              }}
            >
              {busy ? 'Applying…' : 'Yes, apply'}
            </button>
            <button
              type="button"
              className="btn btn-ghost code-change-btn"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {applied && !confirmingRevert && (
        <div className="code-change-actions">
          <button
            type="button"
            className="btn btn-ghost code-change-btn"
            title="Restore the file to its pre-change content (refused if the file changed since)"
            disabled={busy}
            onClick={() => setConfirmingRevert(true)}
          >
            Revert
          </button>
        </div>
      )}

      {applied && confirmingRevert && (
        <div className="code-change-confirm" role="alertdialog" aria-label="Confirm revert">
          <span className="code-change-confirm-text">
            Restore <strong>{change.filePath}</strong> to its pre-change content?
          </span>
          <div className="code-change-actions">
            <button
              type="button"
              className="btn btn-primary code-change-btn"
              disabled={busy}
              onClick={() => {
                setConfirmingRevert(false)
                void revertChange(change.id)
              }}
            >
              {busy ? 'Reverting…' : 'Yes, revert'}
            </button>
            <button
              type="button"
              className="btn btn-ghost code-change-btn"
              disabled={busy}
              onClick={() => setConfirmingRevert(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Right-hand pane: proposed changes first, applied/rejected collapsed under
 * "History". Nothing is written to disk except through the Apply confirm here.
 */
export default function ChangesPanel(): ReactElement {
  const changes = useCodeStore((s) => s.changes)
  const loading = useCodeStore((s) => s.loadingChanges)
  const [historyOpen, setHistoryOpen] = useState(false)

  const proposed = changes.filter((c) => c.status === 'proposed')
  const history = changes.filter((c) => c.status !== 'proposed')

  return (
    <div className="code-changes">
      <div className="code-changes-header">
        <h2 className="code-changes-title">Proposed changes</h2>
        {loading && <span className="code-changes-loading">Refreshing…</span>}
      </div>

      <div className="code-changes-scroll">
        {proposed.length === 0 && (
          <div className="code-changes-empty">
            Ask the assistant to propose changes — they appear here as diffs and are written only
            when you click Apply.
          </div>
        )}
        {proposed.map((c) => (
          <ChangeItem key={c.id} change={c} />
        ))}

        {history.length > 0 && (
          <div className="code-changes-history">
            <button
              type="button"
              className="code-changes-history-toggle"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((v) => !v)}
            >
              <span className={`code-change-chevron ${historyOpen ? 'open' : ''}`} aria-hidden>
                ▸
              </span>
              History ({history.length})
            </button>
            {historyOpen && history.map((c) => <ChangeItem key={c.id} change={c} />)}
          </div>
        )}
      </div>
    </div>
  )
}
