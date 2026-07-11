/**
 * Settings → Agents: user-defined sub-agents (persona + optional dedicated
 * model + optional restricted toolset). The assistant runs them with
 * delegate(agent="name"); workflow AI-agent nodes can select one too.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { AgentProfile, AgentRun } from '@shared/types'
import { ConfirmButton, Switch } from '@/components/common/controls'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { useEditorState } from '@/hooks/useEditorState'
import { useProvidersStore } from '@/stores/providers'
import { useToolsStore } from '@/stores/tools'
import { useUiStore } from '@/stores/ui'
import './settings.css'

function AgentForm({
  editing,
  onDone,
}: {
  editing: AgentProfile | null
  onDone: () => void
}): ReactElement {
  const providers = useProvidersStore((s) => s.providers)
  const toolDefs = useToolsStore((s) => s.tools)
  const toast = useUiStore((s) => s.toast)
  const [name, setName] = useState(editing?.name ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [systemPrompt, setSystemPrompt] = useState(editing?.systemPrompt ?? '')
  const [providerId, setProviderId] = useState(editing?.providerId ?? '')
  const [modelId, setModelId] = useState(editing?.modelId ?? '')
  const [maxRounds, setMaxRounds] = useState(editing?.maxRounds ? String(editing.maxRounds) : '')
  const [restrictTools, setRestrictTools] = useState(editing?.toolIds !== null && editing !== null)
  const [toolIds, setToolIds] = useState<Set<string>>(new Set(editing?.toolIds ?? []))
  const [busy, run] = useAsyncAction()

  const toggleTool = (id: string): void => {
    setToolIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      toast('Give the agent a name.', 'error')
      return
    }
    if (!systemPrompt.trim()) {
      toast('Give the agent a system prompt (its persona).', 'error')
      return
    }
    const rounds = Math.floor(Number(maxRounds))
    const input = {
      name: name.trim(),
      description: description.trim(),
      systemPrompt,
      providerId: providerId || null,
      modelId: modelId.trim() || null,
      toolIds: restrictTools ? [...toolIds] : null,
      maxRounds: Number.isFinite(rounds) && rounds >= 1 ? Math.min(rounds, 40) : null,
    }
    await run(async () => {
      const res = editing
        ? await window.uld.agents.update(editing.id, input)
        : await window.uld.agents.create(input)
      if (!res.ok) {
        toast(res.error.message, 'error')
        return
      }
      onDone()
    })
  }

  return (
    <div className="card prompt-form">
      <h5>{editing ? 'Edit agent' : 'New agent'}</h5>
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="input"
          value={name}
          maxLength={100}
          placeholder="e.g. researcher"
          onChange={(e) => setName(e.target.value)}
        />
        <p className="field-hint">The assistant calls it with delegate(agent=&quot;{name.trim() || 'name'}&quot;).</p>
      </label>
      <label className="field">
        <span className="field-label">Description</span>
        <input
          className="input"
          value={description}
          maxLength={1024}
          placeholder="What this agent is good at (shown in lists)"
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">System prompt (persona)</span>
        <textarea
          className="textarea"
          rows={7}
          value={systemPrompt}
          placeholder="You are a meticulous researcher. Investigate the task using the available tools…"
          onChange={(e) => setSystemPrompt(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">Provider (empty = conversation&apos;s)</span>
        <select className="select" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
          <option value="">Use the conversation&apos;s provider</option>
          {providers
            .filter((p) => p.enabled)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Model id (empty = provider default)</span>
        <input
          className="input mono"
          value={modelId}
          placeholder="e.g. a cheaper model for routine work"
          onChange={(e) => setModelId(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">Max rounds (empty = default 12)</span>
        <input
          className="input"
          type="number"
          min={1}
          max={40}
          value={maxRounds}
          onChange={(e) => setMaxRounds(e.target.value)}
        />
      </label>
      <div className="field">
        <Switch
          checked={restrictTools}
          onChange={setRestrictTools}
          label="Restrict the agent's tools"
        />
        <p className="field-hint">
          Off = the standard sub-agent toolset (read-only project tools + fetch, with
          approval-gated edits). On = only the tools picked below.
        </p>
      </div>
      {restrictTools && (
        <div className="field agent-tool-grid">
          {toolDefs
            .filter((t) => t.enabled && t.id !== 'delegate')
            .map((t) => (
              <label key={t.id} className="agent-tool-check">
                <input
                  type="checkbox"
                  checked={toolIds.has(t.id)}
                  onChange={() => toggleTool(t.id)}
                />
                <span className="mono">{t.name}</span>
              </label>
            ))}
        </div>
      )}
      <div className="prompt-form-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Add agent'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  )
}

export default function AgentsTab(): ReactElement {
  const toast = useUiStore((s) => s.toast)
  const toolsLoaded = useToolsStore((s) => s.loaded)
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [loaded, setLoaded] = useState(false)
  const { formOpen, editing, openAdd, openEdit, closeForm } = useEditorState<AgentProfile>()

  const load = useCallback(async () => {
    const [res, runRes] = await Promise.all([window.uld.agents.list(), window.uld.agents.runs()])
    if (res.ok) setAgents(res.data)
    if (runRes.ok) setRuns(runRes.data)
    setLoaded(true)
  }, [])

  useEffect(() => {
    void load()
    if (!toolsLoaded) void useToolsStore.getState().load()
  }, [load, toolsLoaded])

  useEffect(() => {
    if (!runs.some((run) => run.status === 'running')) return
    const timer = window.setInterval(() => void load(), 2000)
    return () => window.clearInterval(timer)
  }, [runs, load])

  const setEnabled = async (agent: AgentProfile, enabled: boolean): Promise<void> => {
    const res = await window.uld.agents.update(agent.id, { enabled })
    if (!res.ok) toast(res.error.message, 'error')
    await load()
  }

  const remove = async (id: string): Promise<void> => {
    const res = await window.uld.agents.delete(id)
    if (!res.ok) toast(res.error.message, 'error')
    await load()
  }

  return (
    <section aria-label="Agents">
      <header className="tab-header">
        <div>
          <h3>Agents</h3>
          <p className="field-hint">
            Your own sub-agents: a persona, an optional dedicated (often cheaper) model, and an
            optional restricted toolset. The assistant runs them with delegate(agent=&quot;name&quot;);
            workflow AI-agent nodes can select one too.
          </p>
        </div>
        {!formOpen ? (
          <button type="button" className="btn" onClick={openAdd}>
            + New agent
          </button>
        ) : null}
      </header>

      {formOpen ? (
        <AgentForm
          key={editing?.id ?? 'new'}
          editing={editing}
          onDone={() => {
            closeForm()
            void load()
          }}
        />
      ) : null}

      {!loaded ? (
        <p className="field-hint">Loading…</p>
      ) : agents.length === 0 && !formOpen ? (
        <div className="empty-state card">
          <p>No agents yet. Create one — e.g. a “researcher” on a cheap model.</p>
        </div>
      ) : (
        <ul className="prompt-list">
          {agents.map((a) => (
            <li key={a.id} className="prompt-item card">
              <div className="prompt-item-main">
                <strong className="prompt-item-title">
                  {a.name}
                  {!a.enabled ? ' (disabled)' : ''}
                </strong>
                <p className="prompt-item-body">
                  {a.description || a.systemPrompt.slice(0, 120)}
                </p>
              </div>
              <div className="prompt-item-actions">
                <Switch
                  checked={a.enabled}
                  onChange={(v) => void setEnabled(a, v)}
                  label={`Enable agent ${a.name}`}
                />
                <button type="button" className="btn btn-ghost" onClick={() => openEdit(a)}>
                  Edit
                </button>
                <ConfirmButton
                  label="Delete"
                  prompt="Delete this agent?"
                  onConfirm={() => void remove(a.id)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {runs.length > 0 ? (
        <section className="agent-runs" aria-label="Recent agent runs">
          <h4>Recent runs</h4>
          <ul className="prompt-list">
            {runs.slice(0, 20).map((run) => (
              <li key={run.id} className="prompt-item card">
                <div className="prompt-item-main">
                  <strong className="prompt-item-title">
                    {run.agentName ?? 'delegate'} · {run.status}
                  </strong>
                  <p className="prompt-item-body">{run.task}</p>
                  {run.result ? <p className="field-hint">{run.result.slice(0, 240)}</p> : null}
                </div>
                <span className={`badge agent-run-${run.status}`}>{run.status}</span>
                {run.status === 'running' ? (
                  <button type="button" className="btn btn-ghost" onClick={() => void window.uld.agents.stopRun(run.id).then(() => load())}>
                    Stop
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  )
}
