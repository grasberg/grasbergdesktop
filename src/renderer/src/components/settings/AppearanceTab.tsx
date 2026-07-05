import type { AppSettings, ThemeSetting } from '@shared/types'
import { usePersistSettings } from '@/hooks/usePersistSettings'
import { useSettingsStore } from '@/stores/settings'

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
  const persist = usePersistSettings()

  if (!settings) {
    return <p className="field-hint">Loading settings…</p>
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
                onChange={() => void persist({ theme: t.value })}
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
                onChange={() => void persist({ fontSize: f.value })}
              />
              <span>{f.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  )
}
