import type { AppSettings } from '@shared/types'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { errorMessage, Switch } from './ProvidersTab'

export default function PrivacyTab() {
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
    <section aria-label="Privacy">
      <header className="tab-header">
        <div>
          <h3>Privacy</h3>
        </div>
      </header>

      <div className="callout">
        <p>
          Local-first: conversations, settings and keys stay on this device. The only network calls
          are to LLM providers you configure.
        </p>
      </div>

      <div className="toggle-row">
        <div className="toggle-row-text">
          <span className="toggle-row-title">Anonymous usage statistics</span>
          <span className="field-hint">
            Currently no telemetry is implemented; this switch is honored by future versions.
          </span>
        </div>
        <Switch
          checked={settings.telemetryEnabled}
          onChange={(v) => persist({ telemetryEnabled: v })}
          label="Anonymous usage statistics"
        />
      </div>

      <div className="toggle-row">
        <div className="toggle-row-text">
          <span className="toggle-row-title">Warn before sending files</span>
          <span className="field-hint">
            Show a confirmation before attached file contents are sent to a provider.
          </span>
        </div>
        <Switch
          checked={settings.warnBeforeSendingFiles}
          onChange={(v) => persist({ warnBeforeSendingFiles: v })}
          label="Warn before sending files"
        />
      </div>
    </section>
  )
}
