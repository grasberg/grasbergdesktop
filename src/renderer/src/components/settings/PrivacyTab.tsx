import { useEffect, useState } from 'react'
import type { BackupPreview, BackupSummary, Space } from '@shared/types'
import { Switch } from '@/components/common/controls'
import { usePersistSettings } from '@/hooks/usePersistSettings'
import { useSettingsStore } from '@/stores/settings'
import { useConversationsStore } from '@/stores/conversations'
import { useLockStore } from '@/stores/lock'
import { useProjectsStore } from '@/stores/projects'
import { useProvidersStore } from '@/stores/providers'
import { useMemoriesStore } from '@/stores/memories'
import { useSkillsStore } from '@/stores/skills'
import { useSpacesStore } from '@/stores/spaces'
import { useUiStore } from '@/stores/ui'
import { toNormalized, unwrap } from '@/api/uld'
import { useWorkflowsStore } from '@/stores/workflows'
import { usePromptsStore } from '@/stores/prompts'
import { useModalBehavior } from '@/hooks/useModalBehavior'
import { isRemoteClient } from '@/lib/client-platform'

function BackupSection() {
  const toast = useUiStore((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const [includePrivate, setIncludePrivate] = useState(false)
  const [preview, setPreview] = useState<BackupPreview | null>(null)
  const [summary, setSummary] = useState<BackupSummary | null>(null)
  const previewRef = useModalBehavior(!!preview, () => { if (!busy) setPreview(null) })

  const runExport = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await unwrap(
        window.uld.backup.export(includePrivate && !isRemoteClient() ? { includePrivateSpaces: true } : undefined)
      )
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
      const result = await unwrap(window.uld.backup.preview())
      if (result.canceled) return
      setPreview(result)
    } catch (e) { toast(toNormalized(e).message, 'error') }
    finally { setBusy(false) }
  }
  const commitImport = async (): Promise<void> => {
    if (!preview || busy) return
    setBusy(true)
    try {
      const result = await unwrap(window.uld.backup.commit(preview.id))
      setPreview(null)
      setSummary(result)
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
        useWorkflowsStore.getState().load(),
        usePromptsStore.getState().load(),
        useSpacesStore.getState().load(),
      ])
    } catch (e) {
      toast(toNormalized(e).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {summary && <div className="callout" role="status">Import complete: {summary.conversationsImported} conversations, {summary.memoriesImported} memories, {summary.skillsImported} skills, {summary.promptsImported} prompts, {summary.workflowsImported} workflows and {summary.settingsApplied} settings. {summary.skippedItems} invalid or duplicate entries skipped. <button className="btn btn-ghost" onClick={() => setSummary(null)}>Dismiss</button></div>}
      {preview && <div className="modal-backdrop" style={{ zIndex: 950 }}><div className="modal" ref={previewRef} role="dialog" aria-modal="true" aria-labelledby="backup-preview-title">
        <h3 id="backup-preview-title">Review backup import</h3><p>{preview.filename} · version {preview.version}{preview.exportedAt ? ` · ${new Date(preview.exportedAt).toLocaleString()}` : ''}</p>
        <p>Eligible entries: {preview.counts.conversationsImported} conversations, {preview.counts.memoriesImported} memories, {preview.counts.skillsImported} skills, {preview.counts.promptsImported} prompts, {preview.counts.workflowsImported} workflows and {preview.counts.settingsApplied} settings.</p>
        <p>{preview.counts.skippedItems} invalid or duplicate entries will be skipped. Final counts can change if data changes before import.</p>
        <p>Matching memories and skills are updated. Existing conversations, prompts and workflows are kept. Keys and security settings are excluded. Import cannot be undone automatically; export a backup first if you need to restore your current version.</p>
        <div className="prompt-form-actions"><button data-autofocus className="btn" disabled={busy} onClick={() => setPreview(null)}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => void commitImport()}>{busy ? 'Importing…' : 'Import backup'}</button></div>
      </div></div>}
      <div className="toggle-row">
        <div className="toggle-row-text">
          <span className="toggle-row-title">Backup</span>
          <span className="field-hint">
            Export conversations, prompts, workflows, settings, memories and skills as JSON. Stored
            API keys and OAuth tokens are excluded; text you wrote may still contain sensitive data.
            Import merges named entries and skips conversation IDs that already exist.
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
      {!isRemoteClient() && <div className="toggle-row">
        <div className="toggle-row-text">
          <span className="toggle-row-title">Include private spaces in export</span>
          <span className="field-hint">
            Off by default. When on, the export also contains private-space conversations and the
            space definitions; on import, spaces merge by name.
          </span>
        </div>
        <Switch
          checked={includePrivate}
          onChange={setIncludePrivate}
          label="Include private spaces in export"
        />
      </div>}
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
          Permanently removes every chat and work task (with their messages and task-workspace
          files), every project, and every workspace. Your API keys, providers, settings,
          memories, skills and connected folders are kept. This cannot be undone.
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

const IDLE_OPTIONS: Array<{ value: number | null; label: string }> = [
  { value: null, label: 'Never' },
  { value: 5, label: 'After 5 minutes' },
  { value: 15, label: 'After 15 minutes' },
  { value: 30, label: 'After 30 minutes' },
  { value: 60, label: 'After 1 hour' },
]

function AppLockSection() {
  const toast = useUiStore((s) => s.toast)
  const settings = useSettingsStore((s) => s.settings)
  const status = useLockStore((s) => s.status)
  const persist = usePersistSettings()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void useLockStore.getState().load()
  }, [])

  const configured = status?.configured ?? false

  const save = async (removing: boolean): Promise<void> => {
    if (!removing) {
      if (next.length < 6) {
        toast('The passphrase needs at least 6 characters.', 'error')
        return
      }
      if (next !== confirm) {
        toast('The passphrases do not match.', 'error')
        return
      }
    }
    setBusy(true)
    try {
      await useLockStore.getState().setPassphrase({
        ...(configured ? { current } : {}),
        next: removing ? null : next,
      })
      setCurrent('')
      setNext('')
      setConfirm('')
      toast(removing ? 'App lock removed.' : 'Passphrase set.', 'success')
    } catch (e) {
      toast(toNormalized(e).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header className="tab-header">
        <div>
          <h3>App lock</h3>
        </div>
      </header>
      <div className="callout">
        <p>
          An optional passphrase locks the window on launch and after idle. A privacy screen for
          shared desks — it does not encrypt the data on disk, and remote access (phone, Telegram)
          keeps working while locked.
        </p>
      </div>
      <div className="toggle-row">
        <div className="toggle-row-text">
          <span className="toggle-row-title">
            {configured ? 'Passphrase is set' : 'No passphrase set'}
          </span>
          <span className="field-hint">
            {configured
              ? 'Grasberg locks on launch. Change or remove the passphrase below.'
              : 'Set a passphrase to enable the lock.'}
          </span>
        </div>
        {configured ? (
          <button
            type="button"
            className="btn"
            onClick={() => void useLockStore.getState().lockNow()}
          >
            Lock now
          </button>
        ) : null}
      </div>
      <div className="form-grid">
        {configured ? (
          <input
            type="password"
            className="input"
            placeholder="Current passphrase"
            aria-label="Current passphrase"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        ) : null}
        <input
          type="password"
          className="input"
          placeholder="New passphrase (min 6 characters)"
          aria-label="New passphrase"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <input
          type="password"
          className="input"
          placeholder="Confirm new passphrase"
          aria-label="Confirm new passphrase"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <div className="prompt-form-actions">
          <button type="button" className="btn" disabled={busy || !next} onClick={() => void save(false)}>
            {configured ? 'Change passphrase' : 'Set passphrase'}
          </button>
          {configured ? (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy || !current}
              onClick={() => void save(true)}
            >
              Remove
            </button>
          ) : null}
        </div>
      </div>
      {configured ? (
        <div className="toggle-row">
          <div className="toggle-row-text">
            <span className="toggle-row-title">Auto-lock when idle</span>
            <span className="field-hint">Locks after the system has been idle this long.</span>
          </div>
          <select
            className="input"
            aria-label="Auto-lock when idle"
            value={settings?.appLockIdleMinutes ?? ''}
            onChange={(e) =>
              void persist({
                appLockIdleMinutes: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          >
            {IDLE_OPTIONS.map((opt) => (
              <option key={opt.label} value={opt.value ?? ''}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </>
  )
}

function SpaceRow({ space }: { space: Space }) {
  const providers = useProvidersStore((s) => s.providers)
  const [name, setName] = useState(space.name)
  const [editingAllowlist, setEditingAllowlist] = useState(false)
  const allowAll = space.providerAllowlist === null

  const toggleProvider = (providerId: string, checked: boolean): void => {
    const currentIds = space.providerAllowlist ?? providers.map((p) => p.id)
    const nextIds = checked
      ? [...new Set([...currentIds, providerId])]
      : currentIds.filter((id) => id !== providerId)
    // An empty selection would brick the space — treat it as "all providers".
    void useSpacesStore
      .getState()
      .setAllowlist(space.id, nextIds.length === 0 || nextIds.length === providers.length ? null : nextIds)
  }

  return (
    <div className="card space-row">
      <div className="space-row-head">
        <input
          className="input"
          aria-label={`Rename space ${space.name}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const trimmed = name.trim()
            if (trimmed && trimmed !== space.name) {
              void useSpacesStore.getState().rename(space.id, trimmed)
            } else {
              setName(space.name)
            }
          }}
        />
        <button
          type="button"
          className="btn"
          onClick={() => setEditingAllowlist((v) => !v)}
        >
          {allowAll ? 'All providers' : `${space.providerAllowlist?.length} providers`}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          title="A space can only be deleted when it has no conversations."
          onClick={() => void useSpacesStore.getState().remove(space.id)}
        >
          Delete
        </button>
      </div>
      {editingAllowlist ? (
        <div className="space-allowlist">
          <label className="space-allowlist-item">
            <input
              type="checkbox"
              checked={allowAll}
              onChange={(e) => {
                if (e.target.checked) void useSpacesStore.getState().setAllowlist(space.id, null)
              }}
            />
            All providers
          </label>
          {providers.map((provider) => (
            <label key={provider.id} className="space-allowlist-item">
              <input
                type="checkbox"
                checked={allowAll || (space.providerAllowlist?.includes(provider.id) ?? false)}
                onChange={(e) => toggleProvider(provider.id, e.target.checked)}
              />
              {provider.label}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function PrivateSpacesSection() {
  const spaces = useSpacesStore((s) => s.spaces)
  const [newName, setNewName] = useState('')

  useEffect(() => {
    void useSpacesStore.getState().load()
    void useProvidersStore.getState().load()
  }, [])

  const createSpace = (): void => {
    const name = newName.trim()
    if (!name) return
    setNewName('')
    void useSpacesStore.getState().create(name)
  }

  return (
    <>
      <header className="tab-header">
        <div>
          <h3>Private spaces</h3>
        </div>
      </header>
      <div className="callout">
        <p>
          Conversations in a private space are excluded from backups (unless explicitly included),
          remote/phone access, Telegram, and notification previews. Switch spaces from the sidebar;
          every launch starts in the default space.
        </p>
      </div>
      {spaces.map((space) => (
        <SpaceRow key={space.id} space={space} />
      ))}
      <div className="prompt-form-actions">
        <input
          className="input"
          placeholder="New space name"
          aria-label="New space name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') createSpace()
          }}
        />
        <button type="button" className="btn" disabled={!newName.trim()} onClick={createSpace}>
          New space
        </button>
      </div>
    </>
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
          Conversations and settings are stored on your desktop. Sending a message shares its
          context and selected attachments with the chosen provider; credentials authenticate those
          requests. Model lists can refresh from models.dev. Enabled tools, voice downloads, MCP
          servers and bridges may contact their configured services. Paired phones receive app data
          through the encrypted tunnel.
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
      {isRemoteClient() ? <div className="callout">Private spaces, the desktop passphrase and bulk deletion are managed on your desktop. Private-space conversations are excluded from this device, including exports.</div> : <><DeleteAllSection /><AppLockSection /><PrivateSpacesSection /></>}
    </section>
  )
}
