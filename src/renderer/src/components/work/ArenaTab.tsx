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
  const providers = useProvidersStore((s) => s.providers)
  const modelsByProvider = useProvidersStore((s) => s.modelsByProvider)
  const loadModels = useProvidersStore((s) => s.loadModels)
  const enabled = providers.filter((p) => p.enabled)
  const models = modelsByProvider[value.providerId] ?? []

  useEffect(() => {
    if (value.providerId) void loadModels(value.providerId).catch(() => undefined)
  }, [value.providerId, loadModels])

  return (
    <div className="arena-candidate-row">
      <select
        className="select arena-select"
        aria-label="Provider"
        value={value.providerId}
        onChange={(e) => onChange({ providerId: e.target.value, modelId: '' })}
      >
        <option value="">Provider…</option>
        {enabled.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      {models.length > 0 ? (
        <select
          className="select arena-select"
          aria-label="Model"
          value={value.modelId}
          onChange={(e) => onChange({ ...value, modelId: e.target.value })}
        >
          <option value="">Model…</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label ?? m.id}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="input arena-select mono"
          aria-label="Model id"
          placeholder="model id"
          value={value.modelId}
          onChange={(e) => onChange({ ...value, modelId: e.target.value })}
        />
      )}
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
  const [rows, setRows] = useState<MoaModelRef[]>([
    { providerId: '', modelId: '' },
    { providerId: '', modelId: '' },
  ])
  const [busy, setBusy] = useState(false)

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
        window.uld.arena.start({ conversationId, task: task.trim(), candidates: rows })
      )
      setArena(state)
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
      <div className="arena-setup">
        <p className="field-hint">
          Race the same task on several models — each in an isolated copy of this folder — then
          compare the diffs and apply one. The folder must be a git repository.
        </p>
        <textarea
          className="textarea arena-task"
          rows={4}
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
        {arena.candidates.map((candidate) => (
          <article key={candidate.runId} className="arena-card">
            <header className="arena-card-head">
              <span
                className={`run-dot ${
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
