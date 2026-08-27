/**
 * The Work panel's Optimizer tab: an AVO-style autonomous loop per project.
 * The agent edits the working tree; main runs the eval command after every
 * round and only accepts versions that pass correctness AND match-or-beat the
 * best score so far (accepted rounds become git commits; rejected ones are
 * rolled back and logged in the experiment log).
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { ExperimentEntry, OptimizerRun } from '@shared/types'
import { unwrap } from '@/api/uld'
import { useOptimizerStore } from '@/stores/optimizer'

function statusBadge(run: OptimizerRun): ReactElement {
  const cls =
    run.status === 'running'
      ? 'badge opt-badge running'
      : run.status === 'done'
        ? 'badge opt-badge done'
        : run.status === 'failed'
          ? 'badge opt-badge failed'
          : 'badge opt-badge stopped'
  return <span className={cls}>{run.status}</span>
}

function RunRow({ run }: { run: OptimizerRun }): ReactElement {
  const versions = useOptimizerStore((s) => s.versions[run.id])
  const loadVersions = useOptimizerStore((s) => s.loadVersions)
  const stop = useOptimizerStore((s) => s.stop)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (open && !versions) void loadVersions(run.id)
  }, [open, versions, run.id, loadVersions])

  return (
    <div className="opt-run">
      <div className="opt-run-head">
        <button
          type="button"
          className="opt-run-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className={`opt-chevron${open ? ' open' : ''}`} aria-hidden>
            ▸
          </span>
          {run.goal.length > 60 ? `${run.goal.slice(0, 60)}…` : run.goal}
        </button>
        {statusBadge(run)}
        <span className="opt-score mono" title="Best accepted score">
          {run.bestScore !== null ? `${run.bestScore}` : '—'}
        </span>
        <span className="opt-rounds">
          {run.roundsDone}/{run.maxRounds}
        </span>
        {run.status === 'running' ? (
          <button
            type="button"
            className="btn-icon"
            aria-label="Stop optimizer run"
            title="Stop"
            onClick={() => void stop(run.id)}
          >
            ■
          </button>
        ) : null}
      </div>
      {run.lastError ? <div className="opt-run-error">{run.lastError}</div> : null}
      {open ? (
        <div className="opt-versions">
          {(versions ?? []).map((v) => (
            <div key={v.seq} className={`opt-version${v.accepted ? ' accepted' : ''}`}>
              <span className="mono">v{v.seq}</span>
              {v.accepted ? (
                <span className="badge opt-badge accepted" title={v.commitSha ?? undefined}>
                  accepted
                </span>
              ) : (
                <span className="badge opt-badge rejected">rejected</span>
              )}
              <span className="mono">{v.score !== null ? `score ${v.score}` : 'no score'}</span>
              <span className="opt-version-summary">{v.summary}</span>
            </div>
          ))}
          {versions !== undefined && versions.length === 0 ? (
            <div className="opt-empty-hint">No evaluated rounds yet.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default function OptimizerTab({ projectId }: { projectId: string | null }): ReactElement {
  const runs = useOptimizerStore((s) => s.runs)
  const loaded = useOptimizerStore((s) => s.loaded)
  const load = useOptimizerStore((s) => s.load)
  const start = useOptimizerStore((s) => s.start)

  const [goal, setGoal] = useState('')
  const [evalCommand, setEvalCommand] = useState('')
  const [testCommand, setTestCommand] = useState('')
  const [maxRounds, setMaxRounds] = useState(6)
  const [allowShell, setAllowShell] = useState(false)
  const [busy, setBusy] = useState(false)
  const [experiments, setExperiments] = useState<ExperimentEntry[]>([])

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  useEffect(() => {
    if (!projectId) {
      setExperiments([])
      return
    }
    let stale = false
    void unwrap(window.uld.experiments.list(projectId))
      .then((entries) => {
        if (!stale) setExperiments(entries)
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [projectId, loaded])

  if (!projectId) {
    return (
      <div className="opt-wrap">
        <p className="opt-empty-hint">Connect a folder to this task to optimize it.</p>
      </div>
    )
  }

  const projectRuns = runs.filter((r) => r.projectId === projectId)
  const anyRunning = projectRuns.some((r) => r.status === 'running')

  const submit = (): void => {
    if (goal.trim().length === 0 || evalCommand.trim().length === 0 || busy) return
    setBusy(true)
    void start({
      projectId,
      goal,
      evalCommand,
      ...(testCommand.trim() ? { testCommand } : {}),
      maxRounds,
      allowShell,
    })
      .finally(() => setBusy(false))
  }

  return (
    <div className="opt-wrap">
      <section className="opt-form" aria-label="Start optimizer">
        <label className="opt-label" htmlFor="opt-goal">
          Goal
        </label>
        <textarea
          id="opt-goal"
          className="textarea opt-input"
          rows={2}
          placeholder="What should the loop optimize? e.g. make the parser faster without changing behavior"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
        <label className="opt-label" htmlFor="opt-eval">
          Evaluation command — its exit code gates correctness; the last printed number is the score
        </label>
        <input
          id="opt-eval"
          className="input opt-input mono"
          placeholder="npm run bench"
          value={evalCommand}
          onChange={(e) => setEvalCommand(e.target.value)}
        />
        <label className="opt-label" htmlFor="opt-test">
          Optional test gate (must also pass for a version to be kept)
        </label>
        <input
          id="opt-test"
          className="input opt-input mono"
          placeholder="npm test"
          value={testCommand}
          onChange={(e) => setTestCommand(e.target.value)}
        />
        <div className="opt-row">
          <label className="opt-label" htmlFor="opt-rounds">
            Rounds
          </label>
          <select
            id="opt-rounds"
            className="select opt-select"
            value={maxRounds}
            onChange={(e) => setMaxRounds(Number(e.target.value))}
          >
            {[3, 6, 10, 15, 20].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <label className="opt-check">
            <input
              type="checkbox"
              checked={allowShell}
              onChange={(e) => setAllowShell(e.target.checked)}
            />
            let the agent run shell commands
          </label>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || anyRunning || goal.trim().length === 0 || evalCommand.trim().length === 0}
          onClick={() => void submit()}
        >
          {anyRunning ? 'A run is active' : busy ? 'Starting…' : 'Start optimizing'}
        </button>
      </section>

      {projectRuns.length > 0 ? (
        <section aria-label="Runs">
          {projectRuns.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </section>
      ) : (
        <p className="opt-empty-hint">
          No runs yet. The optimizer needs a clean git tree and a benchmark command that prints one
          number.
        </p>
      )}

      {experiments.length > 0 ? (
        <section className="opt-experiments" aria-label="Experiment log">
          <h3 className="opt-heading">Experiment log</h3>
          {experiments.slice(0, 12).map((entry) => (
            <div key={entry.id} className={`opt-experiment ${entry.outcome}`}>
              <span className="badge opt-badge outcome">{entry.outcome}</span>
              <span className="opt-experiment-title">{entry.title}</span>
            </div>
          ))}
          <p className="opt-empty-hint">
            Injected into future sessions in this folder, so the agent builds on what worked.
          </p>
        </section>
      ) : null}
    </div>
  )
}
