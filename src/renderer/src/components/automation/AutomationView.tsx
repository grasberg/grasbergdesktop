import { useEffect, useState } from 'react'
import type { ScheduledTask, ScheduledTaskRun, Workflow } from '@shared/types'
import { scheduleLabel } from '@shared/workflow-status'
import { unwrap, toNormalized } from '@/api/uld'
import { useScheduledTasksStore } from '@/stores/scheduled-tasks'
import { useWorkflowsStore } from '@/stores/workflows'
import { useBotsStore } from '@/stores/bots'
import { useUiStore } from '@/stores/ui'
import { confirmAction } from '@/components/common/ConfirmDialog'
import ScheduledTaskCreateForm from '@/components/scheduled/ScheduledTaskCreateForm'
import RunHistory from '@/components/home/RunHistory'
import { navigateGuarded } from '@/hooks/useUnsavedChanges'
import './automation.css'

const when = (time: number | null): string => time ? new Date(time).toLocaleString() : 'Not scheduled'
type Filter = 'all' | 'prompts' | 'bots' | 'workflows'

export default function AutomationView() {
  const tasks = useScheduledTasksStore(s => s.tasks)
  const overview = useWorkflowsStore(s => s.scheduled)
  const roster = useBotsStore(s => s.roster)
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<ScheduledTask | undefined>()
  const [busy, setBusy] = useState<string | null>(null)
  const [history, setHistory] = useState<Record<string, ScheduledTaskRun[]>>({})
  const [error, setError] = useState<string | null>(null)
  const load = async () => {
    try { setWorkflows(await unwrap(window.uld.workflows.list())); setError(null) }
    catch (e) { setError(toNormalized(e).message) }
  }
  useEffect(() => {
    void load()
    void useScheduledTasksStore.getState().load()
    void useWorkflowsStore.getState().load()
    void useBotsStore.getState().load()
    return window.uld.workflows.onRunFinished(() => { void load() })
  }, [])
  const act = async (id: string, action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(id)
    try { await action(); setError(null) }
    catch (e) { setError(toNormalized(e).message) }
    finally { setBusy(null) }
  }
  const search = query.trim().toLowerCase()
  const loadHistory = (id: string) => act(id, async () => {
    const runs = await unwrap(window.uld.scheduledTasks.runs(id))
    setHistory(h => ({ ...h, [id]: runs }))
  })
  const visibleTasks = tasks.filter(t => filter !== 'workflows' && (filter !== 'bots' || t.agentId) && (filter !== 'prompts' || !t.agentId) && `${t.title} ${t.prompt} ${roster?.bots.find(b => b.agent.id === t.agentId)?.agent.name ?? ''}`.toLowerCase().includes(search))
  const visibleWorkflows = filter === 'all' || filter === 'workflows' ? workflows.filter(w => w.name.toLowerCase().includes(search)) : []
  return <section className="automation-view" aria-label="Automation">
    <header className="automation-header"><div><h1>Automation</h1><p>Scheduled prompts, bot routines and workflows in one place. All runs happen on your desktop.</p></div><div className="automation-actions">
      <button className="btn btn-primary" onClick={() => navigateGuarded(() => { setEditing(undefined); setCreating(true) }, 'page')}>New scheduled task</button>
      <button className="btn" onClick={() => useUiStore.getState().openWorkflows(true)}>New workflow</button>
    </div></header>
    {creating && <ScheduledTaskCreateForm key={editing?.id ?? 'new'} editing={editing} onCreated={() => setCreating(false)} onCancel={() => setCreating(false)} />}
    <div className="automation-toolbar"><input className="input" aria-label="Search automation" placeholder="Search tasks, bots and workflows…" value={query} onChange={e => setQuery(e.target.value)} /><label>Show <select className="select" value={filter} onChange={e => setFilter(e.target.value as Filter)}><option value="all">All automation</option><option value="prompts">Scheduled prompts</option><option value="bots">Bot routines</option><option value="workflows">Workflows</option></select></label><button className="btn" onClick={() => { void load(); void useScheduledTasksStore.getState().load(); void useWorkflowsStore.getState().load() }}>Refresh</button></div>
    {error && <p role="alert" className="form-error">{error}</p>}
    {!visibleTasks.length && !visibleWorkflows.length && <div className="callout">{search ? 'No automation matches your search.' : 'Create a scheduled task for a single instruction, or a workflow for several connected steps.'}</div>}
    <div className="automation-list">
      {visibleTasks.map(task => <article className="card automation-item" key={task.id}>
        <div><span className="field-hint">{task.agentId ? `Bot routine · ${roster?.bots.find(b => b.agent.id === task.agentId)?.agent.name ?? 'Bot unavailable'}` : 'Scheduled prompt'}</span><h2>{task.title}</h2><p>{task.enabled ? `Next: ${when(task.nextRunAt)}` : 'Paused'} · {task.recurrence} · {task.lastStatus}</p>{task.lastError && <p className="form-error">{task.lastError}</p>}</div>
        <button className="btn" disabled={task.lastStatus === 'running'} onClick={() => navigateGuarded(() => { setEditing(task); setCreating(true) }, 'page')}>Edit routine</button>
        <div className="automation-actions"><button className="btn" disabled={!!busy || task.lastStatus === 'running'} onClick={() => void act(task.id, () => useScheduledTasksStore.getState().runNow(task.id))}>Run now</button><button className="btn" disabled={!!busy} onClick={() => void act(task.id, () => useScheduledTasksStore.getState().setEnabled(task.id, !task.enabled))}>{task.enabled ? 'Pause' : 'Resume'}</button><button className="btn btn-danger" disabled={!!busy} onClick={() => void act(task.id, async () => { if (await confirmAction('Delete scheduled task?', `Delete “${task.title}” and its saved run history?`, 'Delete task')) await useScheduledTasksStore.getState().remove(task.id) })}>Delete</button></div>
        <details><summary>Instructions and results</summary><pre>{task.prompt}</pre><button className="btn" disabled={busy === task.id} onClick={() => void loadHistory(task.id)}>Load run history</button>{history[task.id]?.length === 0 && <p>No recorded runs.</p>}{history[task.id]?.map(run => <details key={run.id}><summary>{when(run.startedAt)} · {run.status}</summary><pre>{run.error || run.output}</pre></details>)}</details>
      </article>)}
      {visibleWorkflows.map(workflow => {
        const status = overview.find(w => w.workflow.id === workflow.id)
        return <article className="card automation-item" key={workflow.id}><div><span className="field-hint">Workflow</span><h2>{workflow.name}</h2><p>{workflow.schedule ? `${scheduleLabel(workflow.schedule)} · ${workflow.scheduleEnabled ? 'Enabled' : 'Paused'}` : 'Runs on demand'}{status?.latestRun ? ` · Last run: ${status.latestRun.status}` : ''}</p></div><div className="automation-actions"><button className="btn" disabled={!!busy} onClick={() => void act(workflow.id, () => useWorkflowsStore.getState().runNow(workflow.id))}>Run now</button><button className="btn" onClick={() => useUiStore.getState().openWorkflows(true, workflow.id)}>Edit workflow</button>{workflow.schedule && <button className="btn" disabled={!!busy} onClick={() => void act(workflow.id, async () => { await unwrap(window.uld.workflows.update(workflow.id, { scheduleEnabled: !workflow.scheduleEnabled })); await load() })}>{workflow.scheduleEnabled ? 'Pause' : 'Resume'}</button>}</div><details><summary>Run history</summary><RunHistory workflowId={workflow.id} latestRunId={status?.latestRun?.id ?? null} /></details></article>
      })}
    </div>
  </section>
}
