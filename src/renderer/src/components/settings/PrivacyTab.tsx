import { useState } from 'react'
import type { AppSettings } from '@shared/types'
import { useSettingsStore } from '@/stores/settings'
import { useMemoriesStore } from '@/stores/memories'
import { useSkillsStore } from '@/stores/skills'
import { useUiStore } from '@/stores/ui'
import { toNormalized, unwrap } from '@/api/uld'
import { errorMessage, Switch } from './ProvidersTab'

function BackupSection() {
  const toast = useUiStore((s) => s.toast)
  const [busy, setBusy] = useState(false)

  const runExport = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await unwrap(window.uld.backup.export())
      if (!result.canceled) toast(`Backup saved to ${result.path}`, 'success')
    } catch (e) {
      toast(toNormalized(e).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const runImport = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await unwrap(window.uld.backup.import())
      if (result.canceled) return
      const parts = [
        `${result.memoriesImported} memories`,
        `${result.skillsImported} skills`,
        `${result.settingsApplied} settings`,
      ]
      const skipped = result.skippedItems > 0 ? ` (${result.skippedItems} entries skipped)` : ''
      toast(`Imported ${parts.join(', ')}${skipped}.`, 'success')
      // Refresh every store the import may have touched.
      await Promise.all([
        useSettingsStore.getState().load(),
        useMemoriesStore.getState().load(),
        useSkillsStore.getState().load(),
      ])
    } catch (e) {
      toast(toNormalized(e).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="toggle-row">
        <div className="toggle-row-text">
          <span className="toggle-row-title">Backup</span>
          <span className="field-hint">
            Export or import your settings, memories and skills as a JSON file. API keys and other
            secrets are never included. Importing merges: existing entries with the same name are
            updated, nothing is duplicated.
          </span>
        </div>
        <div className="prompt-form-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void runExport()}>
            Export…
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void runImport()}>
            Import…
          </button>
        </div>
      </div>
    </>
  )
}

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

      <BackupSection />
    </section>
  )
}
