/** Standalone clock-task popover beside Home (independent from Workflows). */

import { useEffect, useRef, useState } from 'react'
import type {
  AgentProfile,
  CodeProject,
  ScheduledTaskRecurrence,
  ScheduledTaskRun,
} from '@shared/types'
import { unwrap } from '@/api/uld'
import { useNow } from '@/hooks/useNow'
import { useScheduledTasksStore } from '@/stores/scheduled-tasks'
import { effectivePermission, useToolsStore } from '@/stores/tools'
import { useUiStore } from '@/stores/ui'

const ClockIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
)

const TrashIcon = (
  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.5 6.8v4M9.5 6.8v4" />
  </svg>
)

const RECURRENCE_LABEL: Record<ScheduledTaskRecurrence, string> = {
  once: 'Once',
  hourly: 'Hourly',
  daily: 'Daily',
  weekly: 'Weekly',
}

function initialDateTime(): string {
  const date = new Date(Date.now() + 60 * 60_000)
  date.setSeconds(0, 0)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function dateTimeLabel(value: number | null): string {
  if (value === null) return 'No next run'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}

export default function ScheduledTasks(): React.JSX.Element {
  const tasks = useScheduledTasksStore((state) => state.tasks)
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [runAt, setRunAt] = useState(initialDateTime)
  const [recurrence, setRecurrence] = useState<ScheduledTaskRecurrence>('once')
  const [grantIds, setGrantIds] = useState<string[]>([])
  const [projectId, setProjectId] = useState('')
  const [projects, setProjects] = useState<CodeProject[]>([])
  const [agentId, setAgentId] = useState('')
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [saving, setSaving] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [historyId, setHistoryId] = useState<string | null>(null)
  const [history, setHistory] = useState<ScheduledTaskRun[]>([])
  const menuRef = useRef<HTMLDivElement>(null)
  const tools = useToolsStore((state) => state.tools)
  const permissions = useToolsStore((state) => state.permissions)
  useNow()

  // Approval-gated tools the user may pre-approve for a task's headless runs.
  // noStandingApproval tools (git_write) keep their per-call contract, and a
  // task must not mint further scheduled tasks.
  const grantable = tools.filter(
    (tool) =>
      tool.enabled &&
      tool.noStandingApproval !== true &&
      tool.id !== 'schedule_task' &&
      effectivePermission(permissions, tool) === 'ask'
  )

  const toggleGrant = (toolId: string): void => {
    setGrantIds((ids) =>
      ids.includes(toolId) ? ids.filter((id) => id !== toolId) : [...ids, toolId]
    )
  }

  /** Expands one task's recorded runs (collapsing whichever was open). */
  const toggleHistory = (taskId: string): void => {
    if (historyId === taskId) {
      setHistoryId(null)
      return
    }
    setHistoryId(taskId)
    setHistory([])
    void (async () => {
      const res = await window.uld.scheduledTasks.runs(taskId)
      // Guard against a slow response landing after the user moved on.
      if (res.ok) setHistory(res.data)
    })()
  }

  const failed = tasks.some((task) => task.lastStatus === 'error')

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false)
        setCreating(false)
        setConfirmingId(null)
        setHistoryId(null)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
        setCreating(false)
        setConfirmingId(null)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  const resetForm = (): void => {
    setTitle('')
    setPrompt('')
    setRunAt(initialDateTime())
    setRecurrence('once')
    setGrantIds([])
    setProjectId('')
    setAgentId('')
  }

  const openCreateForm = (): void => {
    setCreating((value) => !value)
    setConfirmingId(null)
    if (creating) return
    void useToolsStore.getState().load()
    void (async () => {
      try {
        setProjects(await unwrap(window.uld.code.projectsList()))
      } catch {
        setProjects([])
      }
      try {
        setAgents((await unwrap(window.uld.agents.list())).filter((agent) => agent.enabled))
      } catch {
        setAgents([])
      }
    })()
  }

  const createTask = async (): Promise<void> => {
    const timestamp = new Date(runAt).getTime()
    if (!title.trim() || !prompt.trim() || !Number.isFinite(timestamp)) {
      useUiStore.getState().toast('Add a title, instructions and a valid time.', 'error')
      return
    }
    setSaving(true)
    const created = await useScheduledTasksStore.getState().create({
      title: title.trim(),
      prompt: prompt.trim(),
      recurrence,
      runAt: timestamp,
      approvedToolIds: grantIds,
      projectId: grantIds.length > 0 && projectId ? projectId : null,
      agentId: agentId || null,
    })
    setSaving(false)
    if (created) {
      resetForm()
      setCreating(false)
    }
  }

  return (
    <div className="sched-menu-wrap" ref={menuRef}>
      <button
        type="button"
        className={`btn-icon sidebar-clock-btn${open ? ' active' : ''}`}
        aria-label="Scheduled tasks"
        title="Scheduled tasks"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value)
          setCreating(false)
          setConfirmingId(null)
          if (!open) void useScheduledTasksStore.getState().load()
        }}
      >
        {ClockIcon}
        {failed ? <span className="sched-clock-alert" aria-hidden="true" /> : null}
      </button>

      {open ? (
        <div className="sched-popover" role="dialog" aria-label="Scheduled tasks">
          <div className="sched-popover-head">
            <div>
              <strong>Scheduled tasks</strong>
              <span>Run any instruction at a chosen time</span>
            </div>
            <button
              type="button"
              className="btn btn-ghost sched-manage"
              onClick={openCreateForm}
            >
              {creating ? 'Cancel' : '+ Add'}
            </button>
          </div>

          {creating ? (
            <div className="sched-create-form">
              <input
                className="input"
                value={title}
                maxLength={120}
                placeholder="Task name"
                aria-label="Scheduled task name"
                onChange={(event) => setTitle(event.target.value)}
              />
              <textarea
                className="textarea"
                value={prompt}
                maxLength={20_000}
                placeholder="What should be done?"
                aria-label="Scheduled task instructions"
                onChange={(event) => setPrompt(event.target.value)}
              />
              <div className="sched-create-row">
                <input
                  className="input"
                  type="datetime-local"
                  value={runAt}
                  aria-label="First run time"
                  onChange={(event) => setRunAt(event.target.value)}
                />
                <select
                  className="select"
                  value={recurrence}
                  aria-label="Repeat schedule"
                  onChange={(event) =>
                    setRecurrence(event.target.value as ScheduledTaskRecurrence)
                  }
                >
                  <option value="once">Once</option>
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </div>
              {agents.length > 0 ? (
                <select
                  className="select"
                  value={agentId}
                  aria-label="Agent profile that runs this task"
                  onChange={(event) => setAgentId(event.target.value)}
                >
                  <option value="">Default model, no persona</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      Run as {agent.name} (own memory)
                    </option>
                  ))}
                </select>
              ) : null}
              {grantable.length > 0 ? (
                <div className="sched-grants">
                  <span className="sched-grants-label">
                    Pre-approve tools for this task's runs
                  </span>
                  <div className="sched-grants-list">
                    {grantable.map((tool) => (
                      <label key={tool.id} className="sched-grant-check">
                        <input
                          type="checkbox"
                          checked={grantIds.includes(tool.id)}
                          onChange={() => toggleGrant(tool.id)}
                        />
                        <span>{tool.name}</span>
                      </label>
                    ))}
                  </div>
                  {grantIds.length > 0 ? (
                    <select
                      className="select"
                      value={projectId}
                      aria-label="Working folder for file and shell tools"
                      onChange={(event) => setProjectId(event.target.value)}
                    >
                      <option value="">No working folder</option>
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name || project.path}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
              ) : null}
              <button
                type="button"
                className="btn btn-primary sched-create-submit"
                disabled={saving || !title.trim() || !prompt.trim()}
                onClick={() => void createTask()}
              >
                {saving ? 'Saving…' : 'Schedule task'}
              </button>
            </div>
          ) : null}

          {tasks.length === 0 ? (
            <div className="sched-popover-empty">No scheduled tasks.</div>
          ) : (
            <ul className="sched-popover-list">
              {tasks.map((task) => {
                const running = task.lastStatus === 'running'
                const dot = running
                  ? 'running'
                  : task.lastStatus === 'error'
                    ? 'error'
                    : task.lastStatus === 'ok'
                      ? 'ok'
                      : 'never'
                const completed = task.recurrence === 'once' && task.nextRunAt === null
                const confirming = confirmingId === task.id
                return (
                  <li
                    key={task.id}
                    className={`sched-popover-item${task.enabled ? '' : ' paused'}`}
                    title={task.lastError ?? (task.lastOutput || task.prompt)}
                  >
                    <span className={`run-dot ${dot}`} aria-hidden="true" />
                    <button
                      type="button"
                      className="sched-popover-main"
                      aria-expanded={historyId === task.id}
                      title={historyId === task.id ? 'Hide run history' : 'Show run history'}
                      onClick={() => toggleHistory(task.id)}
                    >
                      <span className="sched-item-name">{task.title}</span>
                      <span className="sched-item-meta">
                        {completed
                          ? 'Completed'
                          : `${RECURRENCE_LABEL[task.recurrence]} · ${dateTimeLabel(task.nextRunAt)}${task.approvedToolIds.length > 0 ? ` · ${task.approvedToolIds.length} ${task.approvedToolIds.length === 1 ? 'tool' : 'tools'}` : ''}${task.enabled ? '' : ' · paused'}`}
                      </span>
                    </button>
                    {!completed ? (
                      <button
                        type="button"
                        className="sched-action"
                        disabled={running}
                        onClick={() =>
                          void useScheduledTasksStore
                            .getState()
                            .setEnabled(task.id, !task.enabled)
                        }
                      >
                        {task.enabled ? 'Pause' : 'Resume'}
                      </button>
                    ) : null}
                    {confirming ? (
                      <div className="sched-remove-confirm">
                        <button
                          type="button"
                          className="sched-confirm-remove"
                          onClick={() => {
                            setConfirmingId(null)
                            void useScheduledTasksStore.getState().remove(task.id)
                          }}
                        >
                          Remove
                        </button>
                        <button
                          type="button"
                          className="sched-confirm-cancel"
                          aria-label={`Cancel removing ${task.title}`}
                          onClick={() => setConfirmingId(null)}
                        >
                          ×
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn-icon sched-remove"
                        aria-label={`Remove scheduled task ${task.title}`}
                        title="Remove task"
                        onClick={() => setConfirmingId(task.id)}
                      >
                        {TrashIcon}
                      </button>
                    )}
                    {historyId === task.id ? (
                      <ul className="sched-history">
                        {history.length === 0 ? (
                          <li className="sched-history-empty">No runs recorded yet.</li>
                        ) : (
                          history.map((run) => (
                            <li key={run.id} className={`sched-history-run ${run.status}`}>
                              <span className={`run-dot ${run.status}`} aria-hidden="true" />
                              <span className="sched-history-time">
                                {dateTimeLabel(run.startedAt)}
                              </span>
                              {/* The honest bit: a slot missed while Grasberg
                                  was closed ran late, and says so. */}
                              {run.catchUp ? (
                                <span
                                  className="sched-history-late"
                                  title="Grasberg was closed when this was due — it ran once at the next start, not once per missed slot."
                                >
                                  ran late
                                </span>
                              ) : null}
                              <span className="sched-history-text">
                                {run.error ?? run.output ?? ''}
                              </span>
                            </li>
                          ))
                        )}
                      </ul>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
