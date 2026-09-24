/**
 * The Work panel's Arena tab: race 2–4 models on the SAME task in isolated
 * git worktrees, watch them finish, compare the diffs side by side and apply
 * ONE winner — whose files land in the ordinary Changes pipeline (review,
 * revert per file). Unique to a multi-provider client: the candidates can be
 * different vendors entirely.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { ArenaState, MoaModelRef } from '@shared/types'
import { toNormalized, unwrap } from '@/api/uld'
import { useUiStore } from '@/stores/ui'
import { useChatStore } from '@/stores/chat'
import { useProvidersStore } from '@/stores/providers'
import ModelField from '@/components/chat/ModelField'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'

const MAX_CANDIDATES = 4

function CandidateRow({
  value,
  onChange,
  onRemove,
  removable,
}: {
  value: MoaModelRef
  onChange: (next: MoaModelRef) => void
  onRemove: () => void
  removable: boolean
}): ReactElement {
  return (
    <div className="arena-candidate-row">
      <ModelField label="Candidate model" providerId={value.providerId || null} modelId={value.modelId || null} allowDefault={false} onChange={(providerId, modelId) => onChange({ providerId: providerId ?? '', modelId: modelId ?? '' })} />
      {removable ? (
        <button type="button" className="btn-icon" aria-label="Remove candidate" onClick={onRemove}>
          ×
        </button>
      ) : null}
    </div>
  )
}

function statusLabel(status: string): string {
  switch (status) {
    case 'running':
      return 'Running…'
    case 'done':
      return 'Finished'
    case 'stopped':
      return 'Stopped'
    default:
      return 'Failed'
  }
}

export default function ArenaTab(): ReactElement {
  const conversation = useChatStore((s) => s.conversation)
  const conversationId = conversation?.id ?? null

  const [arena, setArena] = useState<ArenaState | null>(null)
  const [task, setTask] = useState('')
  const [rounds, setRounds] = useState(1)
  const [rows, setRows] = useState<MoaModelRef[]>([
    { providerId: '', modelId: '' },
    { providerId: '', modelId: '' },
  ])
  const [busy, setBusy] = useState(false)
  const snapshot = JSON.stringify({ task, rounds, rows })
  const [baseline, setBaseline] = useState(snapshot)
  const guard = useUnsavedChanges(!arena && snapshot !== baseline)

  useEffect(() => {
    if (!conversationId) return
    let stale = false
    void unwrap(window.uld.arena.status(conversationId))
      .then((state) => {
        if (!stale) setArena(state)
      })
      .catch(() => undefined)
    const off = window.uld.arena.onChanged(({ arena: next }) => {
      if (next.conversationId === conversationId) setArena({ ...next })
    })
    return () => {
      stale = true
      off()
    }
  }, [conversationId])

  const ready = useMemo(
    () =>
      task.trim().length > 0 &&
      rows.length >= 2 &&
      rows.every((r) => r.providerId && r.modelId.trim()),
    [task, rows]
  )

  if (!conversationId) return <div className="terminal-empty">Open a task to use the arena.</div>

  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      const state = await unwrap(
        window.uld.arena.start({
          conversationId,
          task: task.trim(),
          candidates: rows,
          ...(rounds > 1 ? { rounds } : {}),
        })
      )
      setArena(state)
      setBaseline(snapshot); guard.markSaved()
    } catch (e) {
      useUiStore.getState().toast(`Could not start the arena: ${toNormalized(e).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const apply = async (runId: string): Promise<void> => {
    setBusy(true)
    try {
      const state = await unwrap(window.uld.arena.apply(conversationId, runId))
      setArena(state)
      useUiStore.getState().toast('Winner applied — every file is in the Changes tab (revertable).', 'success')
    } catch (e) {
      useUiStore.getState().toast(`Could not apply the candidate: ${toNormalized(e).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const stop = (): void => {
    void unwrap(window.uld.arena.stop(conversationId)).catch((e: unknown) =>
      useUiStore.getState().toast(`Could not stop: ${toNormalized(e).message}`, 'error')
    )
  }

  const discard = async (): Promise<void> => {
    setBusy(true)
    try {
      await unwrap(window.uld.arena.discard(conversationId))
      setArena(null)
    } catch (e) {
      useUiStore.getState().toast(`Could not discard: ${toNormalized(e).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  if (!arena || arena.status === 'discarded') {
    return (
      <div className="arena-setup" inert={busy} aria-busy={busy}>
        <p className="field-hint">
          Race the same task on several models — each in an isolated copy of this folder — then
          compare the diffs and apply one. The folder must be a git repository.
        </p>
        <textarea
          className="textarea arena-task"
          rows={4}
          aria-label="Arena task"
          placeholder="Describe the task, e.g. 'Fix the race condition in the retry queue and add a regression test.'"
          value={task}
          onChange={(e) => setTask(e.target.value)}
        />
        {rows.map((row, index) => (
          <CandidateRow
            key={index}
            value={row}
            removable={rows.length > 2}
            onChange={(next) => setRows((prev) => prev.map((r, i) => (i === index ? next : r)))}
            onRemove={() => setRows((prev) => prev.filter((_, i) => i !== index))}
          />
        ))}
        <div className="arena-rounds-row">
          <label className="field-hint" htmlFor="arena-rounds">
            Evolutionary rounds — after each round an LLM judge picks the winning diff and every
            candidate of the next round starts from it:
          </label>
          <select
            id="arena-rounds"
            className="select arena-select"
            value={rounds}
            onChange={(e) => setRounds(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="arena-actions">
          {rows.length < MAX_CANDIDATES ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setRows((prev) => [...prev, { providerId: '', modelId: '' }])}
            >
              + Add model
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ready || busy}
            onClick={() => void start()}
          >
            {busy ? 'Starting…' : `Race ${rows.length} models`}
          </button>
        </div>
      </div>
    )
  }

  const running = arena.status === 'running'
  return (
    <div className="arena-board">
      <header className="arena-board-head">
        <span className="arena-board-task" title={arena.task}>
          {arena.task}
        </span>
        {arena.totalRounds > 1 ? (
          <span className="badge" title="Evolutionary round / total rounds">
            round {Math.min(arena.round, arena.totalRounds)}/{arena.totalRounds}
          </span>
        ) : null}
        {running ? (
          <button type="button" className="btn btn-ghost" onClick={stop}>
            Stop
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void discard()}>
          Discard
        </button>
      </header>
      <div className="arena-candidates">
        {[...arena.candidates].reverse().map((candidate) => (
          <article
            key={candidate.runId}
            className={`arena-card${candidate.runId === arena.winnerRunId ? ' winner' : ''}`}
          >
            <header className="arena-card-head">
              <span className={`run-dot ${
                  candidate.status === 'done'
                    ? 'ok'
                    : candidate.status === 'running'
                      ? 'busy'
                      : 'error'
                }`}
                aria-hidden="true"
              />
              <span className="arena-card-model mono" title={candidate.modelId}>
                {candidate.providerLabel} · {candidate.modelId}
              </span>
              {arena.totalRounds > 1 ? (
                <span className="badge">r{candidate.round}</span>
              ) : null}
              <span className="arena-card-status">{statusLabel(candidate.status)}</span>
            </header>
            {candidate.diffStat ? (
              <pre className="arena-diffstat mono">{candidate.diffStat}</pre>
            ) : null}
            {candidate.summary ? <p className="arena-summary">{candidate.summary}</p> : null}
            {candidate.diff ? (
              <details className="arena-diff">
                <summary>Diff</summary>
                <pre className="mono">{candidate.diff}</pre>
              </details>
            ) : null}
            <footer className="arena-card-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  busy ||
                  candidate.status !== 'done' ||
                  arena.appliedRunId !== null ||
                  candidate.changedFiles.length === 0
                }
                onClick={() => void apply(candidate.runId)}
              >
                {arena.appliedRunId === candidate.runId ? 'Applied ✓' : 'Apply this'}
              </button>
            </footer>
          </article>
        ))}
      </div>
    </div>
  )
}
