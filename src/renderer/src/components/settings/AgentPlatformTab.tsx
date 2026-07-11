import { useState, type ReactElement } from 'react'
import type { ProjectHook, ProjectHookEvent } from '@shared/types'
import { Switch } from '@/components/common/controls'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

export default function AgentPlatformTab(): ReactElement {
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const [name, setName] = useState('Quality gate')
  const [command, setCommand] = useState('npm test')
  const [event, setEvent] = useState<ProjectHookEvent>('afterAgent')
  const toast = useUiStore((state) => state.toast)
  if (!settings) return <p className="field-hint">Loading…</p>

  const saveHooks = (projectHooks: ProjectHook[]): void => void update({ projectHooks })
  const addHook = (): void => {
    if (!name.trim() || !command.trim()) return
    saveHooks([
      ...settings.projectHooks,
      { id: crypto.randomUUID(), name: name.trim(), command: command.trim(), event, enabled: true },
    ])
  }

  return (
    <section aria-label="Agent platform">
      <header className="tab-header">
        <div>
          <h3>Agent platform</h3>
          <p className="field-hint">Routing, deterministic quality gates and IDE handoff.</p>
        </div>
        <div className="prompt-item-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void window.uld.agents.packImport().then((result) => {
            if (!result.ok) toast(result.error.message, 'error')
            else if (!result.data.canceled) toast(`Imported ${result.data.agents} agents, ${result.data.skills} skills and ${result.data.hooks} hooks.`, 'success')
          })}>Import pack</button>
          <button type="button" className="btn" onClick={() => void window.uld.agents.packExport().then((result) => {
            if (!result.ok) toast(result.error.message, 'error')
            else if (!result.data.canceled) toast('Agent pack exported.', 'success')
          })}>Export pack</button>
        </div>
      </header>

      <div className="card settings-card">
        <h4>Automatic model routing</h4>
        <Switch
          checked={settings.autoRoutingEnabled}
          onChange={(autoRoutingEnabled) => void update({ autoRoutingEnabled })}
          label="Choose a provider automatically when a task has no explicit model"
        />
        <label className="field">
          <span className="field-label">Policy</span>
          <select
            className="select"
            value={settings.autoRoutingPolicy}
            onChange={(e) => void update({ autoRoutingPolicy: e.target.value as typeof settings.autoRoutingPolicy })}
          >
            <option value="balanced">Balanced</option>
            <option value="lowest_cost">Lowest cost</option>
            <option value="highest_quality">Highest quality</option>
            <option value="local_only">Local only</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Soft task budget (USD)</span>
          <input
            className="input"
            type="number"
            min="0.01"
            step="0.01"
            value={settings.autoRoutingMaxCostUsd ?? ''}
            onChange={(e) => void update({ autoRoutingMaxCostUsd: e.target.value ? Number(e.target.value) : null })}
          />
        </label>
      </div>

      <div className="card settings-card">
        <h4>IDE bridge</h4>
        <label className="field">
          <span className="field-label">Editor command</span>
          <select
            className="select"
            value={settings.ideCommand}
            onChange={(e) => void update({ ideCommand: e.target.value as typeof settings.ideCommand })}
          >
            <option value="auto">Auto-detect</option>
            <option value="code">VS Code</option>
            <option value="cursor">Cursor</option>
            <option value="zed">Zed</option>
          </select>
        </label>
      </div>

      <div className="card settings-card">
        <h4>Project hooks</h4>
        <p className="field-hint">
          Hooks run only when shell execution is enabled and the exact command is allowlisted.
        </p>
        {settings.projectHooks.map((hook) => (
          <div className="prompt-item" key={hook.id}>
            <div className="prompt-item-main">
              <strong>{hook.name}</strong>
              <p className="field-hint">{hook.event} · <span className="mono">{hook.command}</span></p>
            </div>
            <Switch
              checked={hook.enabled}
              onChange={(enabled) => saveHooks(settings.projectHooks.map((item) => item.id === hook.id ? { ...item, enabled } : item))}
              label={`Enable ${hook.name}`}
            />
            <button type="button" className="btn btn-ghost" onClick={() => saveHooks(settings.projectHooks.filter((item) => item.id !== hook.id))}>
              Delete
            </button>
          </div>
        ))}
        <div className="prompt-form">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Hook name" />
          <select className="select" value={event} onChange={(e) => setEvent(e.target.value as ProjectHookEvent)}>
            <option value="afterAgent">After agent</option>
            <option value="afterApply">After apply</option>
            <option value="beforeCommit">Before commit</option>
          </select>
          <input className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npm test" />
          <button type="button" className="btn" onClick={addHook}>Add hook</button>
        </div>
      </div>
    </section>
  )
}
