/**
 * A bot's routines (v50): the scheduled tasks that run AS this bot and
 * report into its chat. Pause/resume, run now, run history, remove, create —
 * plus an honest line about whether they run while the window is closed.
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { AgentProfile, ScheduledTask, ScheduledTaskRun } from '@shared/types'
import { formatCost } from '@shared/pricing'
import ScheduledTaskCreateForm from '@/components/scheduled/ScheduledTaskCreateForm'
import { ConfirmButton } from '@/components/common/controls'
import { useNow } from '@/hooks/useNow'
import { dateTime } from '@/lib/format'
import { isMac } from '@/lib/platform'
import { useScheduledTasksStore } from '@/stores/scheduled-tasks'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

const RECURRENCE_LABEL: Record<ScheduledTask['recurrence'], string> = {
  once: 'Once',
  hourly: 'Hourly',
  daily: 'Daily',
  weekly: 'Weekly',
}

function dotFor(task: ScheduledTask): string {
  if (task.lastStatus === 'running') return 'running'
  if (task.lastStatus === 'error') return 'error'
  if (task.lastStatus === 'ok') return 'ok'
  return 'never'
}

export default function BotRoutinesPanel({ agent }: { agent: AgentProfile }): ReactElement {
  const allTasks = useScheduledTasksStore((s) => s.tasks)
  const loaded = useScheduledTasksStore((s) => s.loaded)
  const settings = useSettingsStore((s) => s.settings)
  const [creating, setCreating] = useState(false)
  const [historyId, setHistoryId] = useState<string | null>(null)
  const [history, setHistory] = useState<ScheduledTaskRun[]>([])
  useNow()

  useEffect(() => {
    if (!loaded) void useScheduledTasksStore.getState().load()
  }, [loaded])

  const tasks = allTasks.filter((task) => task.agentId === agent.id)
  const alwaysOn = isMac || settings?.runInBackground === true

  const toggleHistory = (taskId: string): void => {
    if (historyId === taskId) {
      setHistoryId(null)
      return
    }
    setHistoryId(taskId)
    setHistory([])
    void window.uld.scheduledTasks.runs(taskId).then((res) => {
      if (res.ok) setHistory(res.data)
    })
  }

  return (
    <div className="bot-routines">
      <div className="bot-routines-head">
        <h4>Routines</h4>
        <button type="button" onClick={() => setCreating((value) => !value)}>
          {creating ? 'Cancel' : '+ New routine'}
        </button>
      </div>
      {creating ? (
        <ScheduledTaskCreateForm
          fixedAgentId={agent.id}
          onCreated={() => setCreating(false)}
          onCancel={() => setCreating(false)}
        />
      ) : null}
      {tasks.length === 0 && !creating ? (
        <p className="bot-form-hint">
          No routines yet. A routine is a scheduled task that runs as {agent.name} — with its
          persona, memory and toolset — and reports into its chat.
        </p>
      ) : (
        <ul className="sched-popover-list bot-routines-list">
          {tasks.map((task) => {
            const running = task.lastStatus === 'running'
            const completed = task.recurrence === 'once' && task.nextRunAt === null
            const nextRun =
              task.nextRunAt === null ? 'No next run' : dateTime(task.nextRunAt, 'compact')
            return (
              <li
                key={task.id}
                className={`sched-popover-item${task.enabled ? '' : ' paused'}`}
                title={task.lastError ?? (task.lastOutput || task.prompt)}
              >
                <span className={`run-dot ${dotFor(task)}`} aria-hidden="true" />
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
                      : `${RECURRENCE_LABEL[task.recurrence]} · ${nextRun}${task.approvedToolIds.length > 0 ? ` · ${task.approvedToolIds.length} ${task.approvedToolIds.length === 1 ? 'tool' : 'tools'}` : ''}${task.budgetUsd != null ? ` · cap ${formatCost(task.budgetUsd)}` : ''}${task.enabled ? '' : ' · paused'}`}
                  </span>
                </button>
                <button
                  type="button"
                  className="sched-action"
                  disabled={running}
                  title="Run this routine now, outside its schedule"
                  onClick={() => {
                    useUiStore.getState().toast(`Running "${task.title}" now…`)
                    void useScheduledTasksStore.getState().runNow(task.id)
                  }}
                >
                  {running ? 'Running…' : 'Run now'}
                </button>
                {!completed ? (
                  <button
                    type="button"
                    className="sched-action"
                    disabled={running}
                    onClick={() =>
                      void useScheduledTasksStore.getState().setEnabled(task.id, !task.enabled)
                    }
                  >
                    {task.enabled ? 'Pause' : 'Resume'}
                  </button>
                ) : null}
                <ConfirmButton
                  label="Remove"
                  prompt={`Remove the routine "${task.title}"?`}
                  onConfirm={() => void useScheduledTasksStore.getState().remove(task.id)}
                />
                {historyId === task.id ? (
                  <ul className="sched-history">
                    {history.length === 0 ? (
                      <li className="sched-history-empty">No runs recorded yet.</li>
                    ) : (
                      history.map((run) => (
                        <li key={run.id} className={`sched-history-item ${run.status}`}>
                          <span className={`run-dot ${run.status}`} aria-hidden="true" />
                          <span className="sched-history-time">{dateTime(run.startedAt, 'compact')}</span>
                          {run.catchUp ? (
                            <span className="sched-history-late" title="Grasberg was closed when this was due — it ran once at the next start.">
                              ran late
                            </span>
                          ) : null}
                          <span className="sched-history-text">
                            {run.error ?? run.output.slice(0, 160)}
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
      <p className="bot-form-hint bot-routines-status">
        {alwaysOn
          ? 'Grasberg keeps running when the window is closed, so routines run on schedule.'
          : 'Routines run only while Grasberg is open; a slot missed while it was closed runs once at the next start. Turn on "Keep running in the background" in Settings → Appearance to change that.'}
      </p>
    </div>
  )
}
