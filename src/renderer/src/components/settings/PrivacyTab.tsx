import { useState } from 'react'
import { Switch } from '@/components/common/controls'
import { usePersistSettings } from '@/hooks/usePersistSettings'
import { useSettingsStore } from '@/stores/settings'
import { useConversationsStore } from '@/stores/conversations'
import { useProjectsStore } from '@/stores/projects'
import { useMemoriesStore } from '@/stores/memories'
import { useSkillsStore } from '@/stores/skills'
import { useUiStore } from '@/stores/ui'
import { toNormalized, unwrap } from '@/api/uld'

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
        `${result.conversationsImported} conversations`,
        `${result.memoriesImported} memories`,
        `${result.skillsImported} skills`,
        `${result.promptsImported} prompts`,
        `${result.workflowsImported} workflows`,
        `${result.settingsApplied} settings`,
      ]
      const skipped = result.skippedItems > 0 ? ` (${result.skippedItems} entries skipped)` : ''
      toast(`Imported ${parts.join(', ')}${skipped}.`, 'success')
      // Refresh every store the import may have touched.
      await Promise.all([
        useSettingsStore.getState().load(),
        useMemoriesStore.getState().load(),
        useSkillsStore.getState().load(),
        useConversationsStore.getState().load(),
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

function DeleteAllSection() {
  const toast = useUiStore((s) => s.toast)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const runDelete = async (): Promise<void> => {
    setBusy(true)
    try {
      await unwrap(window.uld.data.deleteAllContent())
      // Reset the sidebar: no active conversation, empty lists.
      const convs = useConversationsStore.getState()
      convs.select(null)
      await convs.load()
      await useProjectsStore.getState().load(useConversationsStore.getState().modeFilter)
      toast('Deleted all projects and chats.', 'success')
      setConfirming(false)
    } catch (e) {
      toast(toNormalized(e).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="toggle-row">
      <div className="toggle-row-text">
        <span className="toggle-row-title">Delete all projects and chats</span>
        <span className="field-hint">
          Permanently removes every conversation in all modes (with their messages and documents),
          every project, and every cowork workspace. Your API keys, providers, settings, memories,
          skills and granted code folders are kept. This cannot be undone.
        </span>
      </div>
      <div className="prompt-form-actions">
        {confirming ? (
          <>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => void runDelete()}
            >
              {busy ? 'Deleting…' : 'Yes, delete everything'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)}>
            Delete…
          </button>
        )}
      </div>
    </div>
  )
}

export default function PrivacyTab() {
  const settings = useSettingsStore((s) => s.settings)
  const persist = usePersistSettings()

  if (!settings) {
    return <p className="field-hint">Loading settings…</p>
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
          onChange={(v) => void persist({ telemetryEnabled: v })}
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
          onChange={(v) => void persist({ warnBeforeSendingFiles: v })}
          label="Warn before sending files"
        />
      </div>

      <BackupSection />
      <DeleteAllSection />
    </section>
  )
}
