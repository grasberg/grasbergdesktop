/**
 * Create form for a standalone scheduled task (v50). The sidebar clock
 * popover keeps its inline form; this one serves the bot editor's Routines
 * panel, where the owning bot is fixed ("Run as" is implied).
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import type {
  AgentProfile,
  CodeProject,
  ScheduledTask,
  ScheduledTaskRecurrence,
} from '@shared/types'
import { unwrap } from '@/api/uld'
import { useScheduledTasksStore } from '@/stores/scheduled-tasks'
import { effectivePermission, useToolsStore } from '@/stores/tools'
import { useUiStore } from '@/stores/ui'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'

function initialDateTime(at?: number | null): string {
  const date = new Date(at ?? Date.now() + 60 * 60_000)
  date.setSeconds(0, 0)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

export default function ScheduledTaskCreateForm({
  fixedAgentId,
  editing,
  onCreated,
  onCancel,
}: {
  /** Pin the owning bot; hides the "Run as" picker. */
  fixedAgentId?: string
  editing?: ScheduledTask
  onCreated?: (task: ScheduledTask) => void
  onCancel?: () => void
}): ReactElement {
  const [title, setTitle] = useState(editing?.title ?? '')
  const [prompt, setPrompt] = useState(editing?.prompt ?? '')
  const [runAt, setRunAt] = useState(() => initialDateTime(editing?.nextRunAt))
  const [recurrence, setRecurrence] = useState<ScheduledTaskRecurrence>(editing?.recurrence ?? 'daily')
  const [grantIds, setGrantIds] = useState<string[]>(editing?.approvedToolIds ?? [])
  const [projectId, setProjectId] = useState(editing?.projectId ?? '')
  const [projects, setProjects] = useState<CodeProject[]>([])
  const [agentId, setAgentId] = useState(fixedAgentId ?? editing?.agentId ?? '')
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [webhookUrl, setWebhookUrl] = useState(editing?.webhookUrl ?? '')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const snapshot = JSON.stringify({ title, prompt, runAt, recurrence, grantIds, projectId, agentId, webhookUrl })
  const [baseline] = useState(snapshot)
  const guard = useUnsavedChanges(snapshot !== baseline)
  const tools = useToolsStore((state) => state.tools)
  const permissions = useToolsStore((state) => state.permissions)
  const toolsLoaded = useToolsStore((state) => state.loaded)

  useEffect(() => {
    if (!toolsLoaded) void useToolsStore.getState().load()
    void (async () => {
      try {
        setProjects(await unwrap(window.uld.code.projectsList()))
      } catch {
        setProjects([])
      }
      if (fixedAgentId) return
      try {
        setAgents((await unwrap(window.uld.agents.list())).filter((agent) => agent.enabled))
      } catch {
        setAgents([])
      }
    })()
  }, [fixedAgentId, toolsLoaded])

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
  const toggleGrant = (toolId: string): void =>
    setGrantIds((ids) => (ids.includes(toolId) ? ids.filter((id) => id !== toolId) : [...ids, toolId]))

  const createTask = async (): Promise<void> => {
    if (savingRef.current) return
    const timestamp = new Date(runAt).getTime()
    if (!title.trim() || !prompt.trim() || !Number.isFinite(timestamp)) {
      useUiStore.getState().toast('Add a title, instructions and a valid time.', 'error')
      return
    }
    savingRef.current = true; setSaving(true)
    try {
    const input = {
      title: title.trim(),
      prompt: prompt.trim(),
      recurrence,
      runAt: editing?.nextRunAt && runAt === initialDateTime(editing.nextRunAt) ? editing.nextRunAt : timestamp,
      approvedToolIds: grantIds,
      projectId: projectId || null,
      agentId: fixedAgentId ?? (agentId || null),
      webhookUrl: webhookUrl.trim() || null,
    }
    const created = editing ? await useScheduledTasksStore.getState().update(editing.id, input) : await useScheduledTasksStore.getState().create(input)
    if (created) { guard.markSaved(); onCreated?.(created) }
    } finally { savingRef.current = false; setSaving(false) }
  }

  return (
    <div className="sched-create-form">
      <fieldset disabled={saving} style={{ display: 'contents', border: 0, padding: 0, minWidth: 0 }}>
      <input
        className="input"
        value={title}
        maxLength={120}
        placeholder="Routine name"
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
          onChange={(event) => setRecurrence(event.target.value as ScheduledTaskRecurrence)}
        >
          <option value="once">Once</option>
          <option value="hourly">Hourly</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
      </div>
      {!fixedAgentId && agents.length > 0 ? (
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
      <details><summary>Advanced: tools and delivery</summary>
      <input
        className="input"
        type="url"
        aria-label="Webhook URL for results"
        value={webhookUrl}
        onChange={(e) => setWebhookUrl(e.target.value)}
        placeholder="Webhook URL for results (optional, https)"
        maxLength={2000}
      />
      {grantable.length > 0 ? (
        <div className="sched-grants">
          <span className="sched-grants-label">Pre-approve tools for this routine's runs</span>
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
      </details>
      <div className="sched-create-row">
        <button
          type="button"
          className="btn btn-primary sched-create-submit"
          disabled={saving || !title.trim() || !prompt.trim()}
          onClick={() => void createTask()}
        >
          {saving ? 'Saving…' : editing ? 'Save routine' : 'Schedule routine'}
        </button>
        {onCancel ? (
          <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => guard.discard(onCancel)}>
            Cancel
          </button>
        ) : null}
      </div>
      </fieldset>
    </div>
  )
}
