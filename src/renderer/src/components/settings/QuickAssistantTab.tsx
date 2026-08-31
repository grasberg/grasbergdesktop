import { useEffect, useState } from 'react'
import type { QuickAction } from '@shared/types'
import { DEFAULT_QUICK_ACTIONS } from '@shared/types'
import { usePersistSettings } from '@/hooks/usePersistSettings'
import { useSettingsStore } from '@/stores/settings'
import { useProvidersStore } from '@/stores/providers'

/** Provider + model picker for one quick action (unset = the default chain). */
function QuickModelPicker({
  action,
  onChange,
}: {
  action: QuickAction
  onChange: (patch: Pick<QuickAction, 'providerId' | 'modelId'>) => void
}): React.JSX.Element {
  const providers = useProvidersStore((s) => s.providers)
  const modelsByProvider = useProvidersStore((s) => s.modelsByProvider)
  const loadModels = useProvidersStore((s) => s.loadModels)

  const provider = providers.find((p) => p.id === action.providerId) ?? null
  const enabledProviders = providers.filter((p) => p.enabled)
  const models = provider ? modelsByProvider[provider.id] ?? [] : []
  const [modelDraft, setModelDraft] = useState(action.modelId ?? '')
  const inList = models.some((m) => m.id === action.modelId)

  useEffect(() => setModelDraft(action.modelId ?? ''), [action.modelId])

  useEffect(() => {
    if (!provider || modelsByProvider[provider.id]) return
    void loadModels(provider.id).catch(() => {
      // Best-effort; the custom model input still works.
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.id])

  const commitModelDraft = (): void => {
    const trimmed = modelDraft.trim()
    onChange({ providerId: action.providerId, modelId: trimmed || undefined })
  }

  return (
    <div className="quick-action-model">
      <select
        className="select"
        aria-label={`${action.label || 'Action'} provider`}
        value={action.providerId ?? ''}
        onChange={(e) => {
          const id = e.target.value
          onChange(id ? { providerId: id, modelId: undefined } : {})
        }}
      >
        <option value="">Default model</option>
        {enabledProviders.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
        {provider && !provider.enabled ? (
          <option value={provider.id}>{provider.label} (disabled)</option>
        ) : null}
      </select>
      {provider ? (
        models.length > 0 && (inList || !action.modelId) ? (
          <select
            className="select"
            aria-label={`${action.label || 'Action'} model`}
            value={action.modelId ?? ''}
            onChange={(e) =>
              onChange({ providerId: action.providerId, modelId: e.target.value || undefined })
            }
          >
            <option value="">
              Provider default{provider.defaultModelId ? ` (${provider.defaultModelId})` : ''}
            </option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label ?? m.id}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input mono"
            aria-label={`${action.label || 'Action'} custom model id`}
            value={modelDraft}
            placeholder="model id"
            spellCheck={false}
            onChange={(e) => setModelDraft(e.target.value)}
            onBlur={commitModelDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitModelDraft()
              }
            }}
          />
        )
      ) : null}
    </div>
  )
}

/** One editable quick action (label + prompt + optional model + remove). */
function QuickActionRow({
  action,
  onChange,
  onRemove,
}: {
  action: QuickAction
  onChange: (next: QuickAction) => void
  onRemove: () => void
}): React.JSX.Element {
  const [label, setLabel] = useState(action.label)
  const [prompt, setPrompt] = useState(action.prompt)

  useEffect(() => setLabel(action.label), [action.label])
  useEffect(() => setPrompt(action.prompt), [action.prompt])

  const commitLabel = (): void => {
    const trimmed = label.trim().slice(0, 60)
    if (!trimmed) {
      setLabel(action.label)
      return
    }
    if (trimmed !== action.label) onChange({ ...action, label: trimmed })
  }

  const commitPrompt = (): void => {
    if (!prompt.trim()) {
      setPrompt(action.prompt)
      return
    }
    if (prompt !== action.prompt) onChange({ ...action, prompt })
  }

  return (
    <div className="quick-action-row settings-field">
      <div className="quick-action-head">
        <input
          className="input"
          aria-label="Action label"
          value={label}
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitLabel()
            }
          }}
        />
        <button type="button" className="btn" onClick={onRemove}>
          Remove
        </button>
      </div>
      <textarea
        className="input"
        aria-label="Action prompt"
        rows={3}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onBlur={commitPrompt}
      />
      <QuickModelPicker
        action={action}
        onChange={(patch) =>
          onChange({
            id: action.id,
            label: action.label,
            prompt: action.prompt,
            ...(patch.providerId ? { providerId: patch.providerId } : {}),
            ...(patch.modelId ? { modelId: patch.modelId } : {}),
          })
        }
      />
    </div>
  )
}

export default function QuickAssistantTab(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const persist = usePersistSettings()

  const shortcutValue = settings?.quickAssistantShortcut ?? ''
  const [shortcut, setShortcut] = useState(shortcutValue)
  useEffect(() => setShortcut(shortcutValue), [shortcutValue])

  if (!settings) {
    return <p className="field-hint">Loading settings…</p>
  }

  const actions = settings.quickActions

  const saveActions = (next: QuickAction[]): void => {
    void persist({ quickActions: next })
  }

  return (
    <section aria-label="Quick assistant">
      <header className="tab-header">
        <div>
          <h3>Quick assistant</h3>
          <p className="field-hint">
            A global shortcut opens a small always-on-top window that acts on the text you copied
            — without saving anything unless you promote it to a conversation.
          </p>
        </div>
      </header>

      <div className="settings-field">
        <label className="field-label" htmlFor="quick-shortcut">
          Summon shortcut
        </label>
        <div className="quick-shortcut-row">
          <input
            id="quick-shortcut"
            className="input mono"
            value={shortcut}
            spellCheck={false}
            placeholder="CommandOrControl+Shift+Space"
            onChange={(e) => setShortcut(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            onClick={() => void persist({ quickAssistantShortcut: shortcut.trim() })}
          >
            Save
          </button>
        </div>
        <span className="field-hint">
          Electron accelerator, e.g. CommandOrControl+Shift+Space. Leave empty to disable. If
          another app owns the combo, a notice appears when you save.
        </span>
      </div>

      <h4 className="section-subhead">Quick actions</h4>
      <p className="field-hint">
        {'{selection}'} in a prompt is replaced with the copied text; without it, the text is
        appended at the end.
      </p>
      {actions.map((action) => (
        <QuickActionRow
          key={action.id}
          action={action}
          onChange={(next) => saveActions(actions.map((a) => (a.id === next.id ? next : a)))}
          onRemove={() => saveActions(actions.filter((a) => a.id !== action.id))}
        />
      ))}
      <div className="quick-actions-toolbar">
        <button
          type="button"
          className="btn"
          onClick={() =>
            saveActions([
              ...actions,
              { id: crypto.randomUUID(), label: 'New action', prompt: '{selection}' },
            ])
          }
        >
          Add action
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => saveActions(DEFAULT_QUICK_ACTIONS)}
        >
          Restore defaults
        </button>
      </div>
    </section>
  )
}
