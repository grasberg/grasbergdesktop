/**
 * Settings → Agents: the same profiles the Bots pane calls bots. One identity,
 * one editor (AgentProfileForm, v49) — this tab lists them, toggles enable,
 * opens their chat, and shows recent background runs.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { AgentProfile, AgentRun } from '@shared/types'
import AgentProfileForm from '@/components/agents/AgentProfileForm'
import { BotAvatarBadge } from '@/components/bots/BotAvatarBadge'
import { ConfirmButton, Switch } from '@/components/common/controls'
import { useEditorState } from '@/hooks/useEditorState'
import { usePersistSettings } from '@/hooks/usePersistSettings'
import { useSettingsStore } from '@/stores/settings'
import { useBotsStore } from '@/stores/bots'
import { useUiStore } from '@/stores/ui'
import './settings.css'

/** Bot Mode caps (v50): rounds / messages per room send, hop cap, room size. */
function BotModeLimitsCard(): ReactElement | null {
  const settings = useSettingsStore((s) => s.settings)
  const persist = usePersistSettings()
  if (!settings) return null
  const limits = settings.botMode
  const field = (
    key: keyof typeof limits,
    label: string,
    min: number,
    max: number,
    hint: string
  ): ReactElement => (
    <label className="field bot-limit-field">
      <span className="field-label">{label}</span>
      <input
        className="input"
        type="number"
        min={min}
        max={max}
        value={limits[key]}
        onChange={(e) => {
          const value = Math.floor(Number(e.target.value))
          if (!Number.isFinite(value) || value < min || value > max) return
          void persist({ botMode: { ...limits, [key]: value } })
        }}
      />
      <p className="field-hint">{hint}</p>
    </label>
  )
  return (
    <div className="card prompt-form">
      <h5>Bot Mode limits</h5>
      <p className="field-hint">
        Caps on what a room or a bot-to-bot chain may do per user message. The defaults are
        the Hermes numbers; raise them for bigger rooms, lower them to contain spend.
      </p>
      <div className="agent-tool-grid">
        {field('groupMaxRounds', 'Rounds per room send', 1, 10, 'Round-table rooms settle earlier on a silent round.')}
        {field('groupMaxMessages', 'Bot messages per room send', 1, 50, 'Across all rounds of one user message.')}
        {field('maxHops', 'Bot-to-bot chain depth', 1, 20, 'A message_agent call past this depth is refused.')}
        {field('groupMaxMembers', 'Room size', 2, 12, 'Members per room, including observers and the lead.')}
      </div>
    </div>
  )
}

export default function AgentsTab(): ReactElement {
  const toast = useUiStore((s) => s.toast)
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
  }, [load])

  useEffect(() => {
    if (!runs.some((run) => run.status === 'running')) return
    const timer = window.setInterval(() => void load(), 2000)
    return () => window.clearInterval(timer)
  }, [runs, load])

  const setEnabled = async (agent: AgentProfile, enabled: boolean): Promise<void> => {
    const res = await window.uld.agents.update(agent.id, { enabled })
    if (!res.ok) toast(res.error.message, 'error')
    await load()
    void useBotsStore.getState().load()
  }

  const remove = async (id: string): Promise<void> => {
    const res = await window.uld.agents.delete(id)
    if (!res.ok) toast(res.error.message, 'error')
    await load()
    void useBotsStore.getState().load()
  }

  const openBots = (): void => {
    useUiStore.getState().openSettings(false)
    useUiStore.getState().setView('bots')
  }

  const openChat = (agent: AgentProfile): void => {
    useUiStore.getState().openSettings(false)
    void useBotsStore.getState().openBotChat(agent.id)
  }

  return (
    <section aria-label="Agents">
      <header className="tab-header">
        <div>
          <h3>Agents</h3>
          <p className="field-hint">
            Your agents are your bots: a persona, an optional dedicated model, a toolset, its own
            memory and routines. The Bots pane is their home (chats, rooms, deliveries); this list
            edits the very same profiles. The assistant reaches one with delegate(agent=&quot;name&quot;),
            workflow AI-agent nodes and scheduled tasks can run as one.
          </p>
        </div>
        <div className="prompt-form-actions">
          <button type="button" className="btn btn-ghost" onClick={openBots}>
            Open Bots
          </button>
          {!formOpen ? (
            <button type="button" className="btn" onClick={openAdd}>
              + New agent
            </button>
          ) : null}
        </div>
      </header>

      <BotModeLimitsCard />

      {formOpen ? (
        <div className="card">
          <AgentProfileForm
            key={editing?.id ?? 'new'}
            variant="settings"
            editing={editing}
            teammates={agents}
            onSaved={() => {
              closeForm()
              void load()
            }}
            onCancel={closeForm}
          />
        </div>
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
              <BotAvatarBadge agent={a} size={32} />
              <div className="prompt-item-main">
                <strong className="prompt-item-title">
                  {a.name}
                  {a.title ? <span className="field-hint"> · {a.title}</span> : null}
                  {!a.enabled ? ' (disabled)' : ''}
                </strong>
                <p className="prompt-item-body">{a.description || a.systemPrompt.slice(0, 120)}</p>
              </div>
              <div className="prompt-item-actions">
                <Switch
                  checked={a.enabled}
                  onChange={(v) => void setEnabled(a, v)}
                  label={`Enable agent ${a.name}`}
                />
                <button type="button" className="btn btn-ghost" onClick={() => openChat(a)}>
                  Open chat
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => openEdit(a)}>
                  Edit
                </button>
                <ConfirmButton
                  label="Delete"
                  prompt="Delete this agent? Its chat and room memberships go too."
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
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void window.uld.agents.stopRun(run.id).then(() => load())}
                  >
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
