/**
 * Morning brief settings: a once-daily digest of overnight results and today's
 * schedule, generated main-side (BriefService) on the economy model unless an
 * agent profile is chosen. History is main-owned; only the config lives here.
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { AgentProfile, MorningBriefSettings } from '@shared/types'
import { Switch } from '@/components/common/controls'
import { useSettingsStore } from '@/stores/settings'

const DEFAULT_CONFIG: MorningBriefSettings = {
  enabled: false,
  time: '08:00',
  agentId: null,
  deliverTelegram: false,
  deliverNotification: true,
}

export default function MorningBriefCard(): ReactElement | null {
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const [agents, setAgents] = useState<AgentProfile[]>([])

  useEffect(() => {
    void window.uld.agents.list().then((result) => {
      if (result.ok) setAgents(result.data.filter((a) => a.enabled))
    })
  }, [])

  if (!settings) return null
  const cfg = settings.morningBrief ?? DEFAULT_CONFIG
  const save = (patch: Partial<MorningBriefSettings>): void =>
    void update({ morningBrief: { ...cfg, ...patch } })

  return (
    <div className="card settings-card">
      <h4>Morning brief</h4>
      <div className="toggle-row">
        <div className="toggle-row-text">
          <span className="toggle-row-title">Daily brief</span>
          <span className="field-hint">
            Generate a daily brief of overnight results and today's schedule, shown on Home.
          </span>
        </div>
        <Switch
          checked={cfg.enabled}
          onChange={(enabled) => save({ enabled })}
          label="Generate a daily brief"
        />
      </div>
      <label className="field">
        <span className="field-label">Time</span>
        <input
          className="input"
          type="time"
          value={cfg.time}
          disabled={!cfg.enabled}
          onChange={(e) => {
            if (e.target.value) save({ time: e.target.value })
          }}
        />
      </label>
      <label className="field">
        <span className="field-label">Written by</span>
        <select
          className="select"
          value={cfg.agentId ?? ''}
          disabled={!cfg.enabled}
          onChange={(e) => save({ agentId: e.target.value || null })}
        >
          <option value="">Default (economy) model</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
      <div className="toggle-row">
        <div className="toggle-row-text">
          <span className="toggle-row-title">Desktop notification</span>
          <span className="field-hint">Respects the global desktop-notifications toggle.</span>
        </div>
        <Switch
          checked={cfg.deliverNotification}
          onChange={(deliverNotification) => save({ deliverNotification })}
          disabled={!cfg.enabled}
          label="Also show a desktop notification"
        />
      </div>
      <div className="toggle-row">
        <div className="toggle-row-text">
          <span className="toggle-row-title">Send to Telegram</span>
          <span className="field-hint">
            Requires the Telegram bridge to be connected and paired.
          </span>
        </div>
        <Switch
          checked={cfg.deliverTelegram}
          onChange={(deliverTelegram) => save({ deliverTelegram })}
          disabled={!cfg.enabled}
          label="Also send to the paired Telegram chat"
        />
      </div>
    </div>
  )
}
