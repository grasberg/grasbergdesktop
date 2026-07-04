import type { AppSettings, ThemeSetting } from '@shared/types'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { errorMessage } from './ProvidersTab'

const THEMES: { value: ThemeSetting; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const FONT_SIZES: { value: AppSettings['fontSize']; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
]

export default function AppearanceTab() {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const toast = useUiStore((s) => s.toast)

  if (!settings) {
    return <p className="field-hint">Loading settings…</p>
  }

  function persist(patch: Partial<AppSettings>) {
    void update(patch).catch((e: unknown) => toast(errorMessage(e), 'error'))
  }

  return (
    <section aria-label="Appearance">
      <header className="tab-header">
        <div>
          <h3>Appearance</h3>
        </div>
      </header>

      <fieldset className="settings-field">
        <legend className="field-label">Theme</legend>
        <div className="theme-options" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <label
              key={t.value}
              className={`theme-option${settings.theme === t.value ? ' selected' : ''}`}
            >
              <input
                type="radio"
                name="uld-theme"
                value={t.value}
                checked={settings.theme === t.value}
                onChange={() => persist({ theme: t.value })}
              />
              <span className={`mini-preview mini-${t.value}`} aria-hidden="true">
                <span className="mini-bar" />
                <span className="mini-line" />
                <span className="mini-line short" />
              </span>
              <span className="theme-option-label">{t.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="settings-field">
        <legend className="field-label">Font size</legend>
        <div className="seg-group" role="radiogroup" aria-label="Font size">
          {FONT_SIZES.map((f) => (
            <label
              key={f.value}
              className={`seg-option${settings.fontSize === f.value ? ' selected' : ''}`}
            >
              <input
                type="radio"
                name="uld-fontsize"
                value={f.value}
                checked={settings.fontSize === f.value}
                onChange={() => persist({ fontSize: f.value })}
              />
              <span>{f.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  )
}
