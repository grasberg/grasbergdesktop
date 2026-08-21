import { useMemo, useState, type ReactElement } from 'react'
import type { CheckpointLite, CodeChange } from '@shared/types'
import { unwrap } from '@/api/uld'
import { useUiStore } from '@/stores/ui'
import { useChatStore } from '@/stores/chat'
import { useCodeStore } from '@/stores/code'
import CommitBar from './CommitBar'
import DiffView from './DiffView'
import './code.css'

const TYPE_LABEL: Record<CodeChange['changeType'], string> = {
  create: 'create',
  edit: 'edit',
  delete: 'delete',
}

/** Stable empty list so the ownership guard doesn't churn memo identities. */
const NO_CHECKPOINTS: CheckpointLite[] = []

function ChangeItem({
  change,
  sourceTitle,
}: {
  change: CodeChange
  /** Conversation title shown in the "All chats" review-queue scope. */
  sourceTitle?: string | null
}): ReactElement {
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

      {sourceTitle !== undefined && (
        <div className="code-change-source" title="Conversation this change came from">
          from: {sourceTitle ?? 'a deleted conversation'}
        </div>
      )}

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
 * One assistant turn's checkpoints: the individual restore rows plus a
 * "Restore all from this turn" bulk undo (with the same two-step confirm
 * pattern the change items use).
 */
function CheckpointTurnGroup({
  conversationId,
  seq,
  checkpoints,
}: {
  conversationId: string
  seq: number
  checkpoints: CheckpointLite[]
}): ReactElement {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const files = [...new Set(checkpoints.flatMap((c) => c.filePaths))]

  return (
    <div className="code-change card code-change-past">
      <div className="code-change-head">
        <span className="code-change-path" title={files.join('\n')}>
          Turn {seq}
        </span>
        <span className="badge">
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
      </div>
      {checkpoints.map((checkpoint) => (
        <div className="code-change-head" key={checkpoint.id}>
          <span className="code-change-path" title={checkpoint.filePaths.join('\n')}>
            {checkpoint.label}
          </span>
          <button
            type="button"
            className="btn btn-ghost code-change-btn"
            disabled={busy}
            onClick={() => void unwrap(window.uld.code.checkpointRestore(checkpoint.id))
              .then(() => {
                void useCodeStore.getState().loadChanges()
                void useCodeStore.getState().loadCheckpoints(conversationId)
              })
              .catch((error: unknown) => useUiStore.getState().toast(
                error instanceof Error ? error.message : 'Could not restore checkpoint.',
                'error'
              ))}
          >
            Restore
          </button>
        </div>
      ))}
      {checkpoints.length > 1 && !confirming && (
        <div className="code-change-actions">
          <button
            type="button"
            className="btn btn-ghost code-change-btn"
            title="Revert every change applied during this turn (files changed since are skipped)"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Restore all from this turn
          </button>
        </div>
      )}
      {checkpoints.length > 1 && confirming && (
        <div className="code-change-confirm" role="alertdialog" aria-label="Confirm turn revert">
          <span className="code-change-confirm-text">
            Restore {files.length} file{files.length === 1 ? '' : 's'} (
            {files.join(', ')}) to their pre-turn content?
          </span>
          <div className="code-change-actions">
            <button
              type="button"
              className="btn btn-primary code-change-btn"
              disabled={busy}
              onClick={() => {
                setConfirming(false)
                setBusy(true)
                void useCodeStore
                  .getState()
                  .revertTurn(conversationId, seq)
                  .finally(() => setBusy(false))
              }}
            >
              {busy ? 'Reverting…' : 'Yes, restore all'}
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
    </div>
  )
}

/**
 * Right-hand pane: proposed changes first, applied/rejected collapsed under
 * "History", scoped to this conversation or the whole project ("All chats" —
 * the cross-conversation review queue), with the git commit bar at the
 * bottom. Nothing is written to disk except through the Apply confirm here.
 */
export default function ChangesPanel(): ReactElement {
  const changes = useCodeStore((s) => s.changes)
  const allChanges = useCodeStore((s) => s.allChanges)
  const scope = useCodeStore((s) => s.changesScope)
  const setScope = useCodeStore((s) => s.setChangesScope)
  const loading = useCodeStore((s) => s.loadingChanges)
  const conversationId = useChatStore((s) => s.conversation?.id ?? null)
  const storeCheckpoints = useCodeStore((s) => s.checkpoints)
  const checkpointsConversationId = useCodeStore((s) => s.checkpointsConversationId)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [checkpointsOpen, setCheckpointsOpen] = useState(false)

  // Only trust checkpoints loaded for THIS conversation — the singleton code
  // store can briefly hold another conversation's list around a switch.
  const checkpoints =
    conversationId !== null && checkpointsConversationId === conversationId
      ? storeCheckpoints
      : NO_CHECKPOINTS

  // Group the conversation's checkpoints by the assistant turn that applied
  // them (newest turn first — the list is already newest-checkpoint first).
  const checkpointTurns = useMemo(() => {
    const bySeq = new Map<number, CheckpointLite[]>()
    for (const checkpoint of checkpoints) {
      const group = bySeq.get(checkpoint.messageSeq)
      if (group) group.push(checkpoint)
      else bySeq.set(checkpoint.messageSeq, [checkpoint])
    }
    return [...bySeq.entries()]
  }, [checkpoints])

  const all = scope === 'all'
  const scoped = all
    ? allChanges
    : changes.filter((c) => c.conversationId === conversationId)
  const titleOf = (c: CodeChange): string | null | undefined =>
    all ? (allChanges.find((a) => a.id === c.id)?.conversationTitle ?? null) : undefined

  const proposed = scoped.filter((c) => c.status === 'proposed')
  const history = scoped.filter((c) => c.status !== 'proposed')

  return (
    <div className="code-changes">
      <div className="code-changes-header">
        <h2 className="code-changes-title">Proposed changes</h2>
        <div className="code-changes-scope" role="tablist" aria-label="Changes scope">
          <button
            type="button"
            role="tab"
            aria-selected={!all}
            className={`btn-link code-changes-scope-btn${all ? '' : ' active'}`}
            onClick={() => setScope('conversation')}
          >
            This chat
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={all}
            className={`btn-link code-changes-scope-btn${all ? ' active' : ''}`}
            onClick={() => setScope('all')}
          >
            All chats
          </button>
        </div>
        {loading && <span className="code-changes-loading">Refreshing…</span>}
      </div>

      <div className="code-changes-scroll">
        {checkpoints.length > 0 && conversationId ? (
          <div className="code-changes-history">
            <button
              type="button"
              className="code-changes-history-toggle"
              aria-expanded={checkpointsOpen}
              onClick={() => setCheckpointsOpen((value) => !value)}
            >
              <span className={`code-change-chevron ${checkpointsOpen ? 'open' : ''}`} aria-hidden>▸</span>
              Checkpoints ({checkpoints.length})
            </button>
            {checkpointsOpen ? checkpointTurns.map(([seq, group]) => (
              <CheckpointTurnGroup
                key={seq}
                conversationId={conversationId}
                seq={seq}
                checkpoints={group}
              />
            )) : null}
          </div>
        ) : null}
        {proposed.length === 0 && (
          <div className="code-changes-empty">
            {all
              ? 'No pending changes anywhere in this project.'
              : 'Ask the assistant to propose changes — they appear here as diffs and are written only when you click Apply.'}
          </div>
        )}
        {proposed.map((c) => (
          <ChangeItem key={c.id} change={c} sourceTitle={titleOf(c)} />
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
            {historyOpen &&
              history.map((c) => <ChangeItem key={c.id} change={c} sourceTitle={titleOf(c)} />)}
          </div>
        )}
      </div>

      <CommitBar />
    </div>
  )
}
