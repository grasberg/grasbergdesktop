/**
 * Settings → Memory: toggle for the assistant's persistent memory plus the
 * list of saved memories (review, edit, delete). The list stays visible even
 * when the feature is off, so users can always audit what has been stored.
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { AppSettings, Memory } from '@shared/types'
import { useMemoriesStore } from '@/stores/memories'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { ConfirmButton, Switch, errorMessage } from './ProvidersTab'
import './settings.css'

function MemoryForm({
  editing,
  onDone,
}: {
  editing: Memory | null
  onDone: () => void
}): ReactElement {
  const create = useMemoriesStore((s) => s.create)
  const update = useMemoriesStore((s) => s.update)
  const toast = useUiStore((s) => s.toast)
  const [title, setTitle] = useState(editing?.title ?? '')
  const [content, setContent] = useState(editing?.content ?? '')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (title.trim().length === 0) {
      toast('Give the memory a title.', 'error')
      return
    }
    setBusy(true)
    try {
      if (editing) {
        await update(editing.id, { title, content })
      } else {
        await create({ title, content })
      }
      onDone()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card prompt-form">
      <h5>{editing ? 'Edit memory' : 'New memory'}</h5>
      <label className="field">
        <span className="field-label">Title</span>
        <input
          className="input"
          value={title}
          maxLength={200}
          placeholder="e.g. preferred-language"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">Memory</span>
        <textarea
          className="textarea"
          rows={5}
          value={content}
          placeholder="The fact the assistant should remember…"
          onChange={(e) => setContent(e.target.value)}
        />
      </label>
      <div className="prompt-form-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Add memory'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  )
}

export default function MemoryTab(): ReactElement {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.update)
  const memories = useMemoriesStore((s) => s.memories)
  const loaded = useMemoriesStore((s) => s.loaded)
  const load = useMemoriesStore((s) => s.load)
  const remove = useMemoriesStore((s) => s.remove)
  const toast = useUiStore((s) => s.toast)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Memory | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  if (!settings) {
    return <p className="field-hint">Loading settings…</p>
  }

  function persist(patch: Partial<AppSettings>): void {
    void updateSettings(patch).catch((e: unknown) => toast(errorMessage(e), 'error'))
  }

  const closeForm = (): void => {
    setFormOpen(false)
    setEditing(null)
  }

  return (
    <section aria-label="Memory">
      <header className="tab-header">
        <div>
          <h3>Memory</h3>
          <p className="field-hint">
            Let the assistant remember durable facts about you across conversations. Memories are
            stored locally and added to the system prompt.
          </p>
        </div>
        {!formOpen ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setEditing(null)
              setFormOpen(true)
            }}
          >
            + New memory
          </button>
        ) : null}
      </header>

      <div className="toggle-row">
        <div className="toggle-row-text">
          <span className="toggle-row-title">Enable memory</span>
          <span className="field-hint">
            When off, nothing is remembered or added to prompts. Saved memories stay listed below
            so you can review or delete them.
          </span>
        </div>
        <Switch
          checked={settings.memoryEnabled}
          onChange={(v) => persist({ memoryEnabled: v })}
          label="Enable memory"
        />
      </div>

      {formOpen ? <MemoryForm editing={editing} onDone={closeForm} /> : null}

      {!loaded ? (
        <p className="field-hint">Loading…</p>
      ) : memories.length === 0 && !formOpen ? (
        <div className="empty-state card">
          <p>No memories saved yet. The assistant adds memories as you chat.</p>
        </div>
      ) : (
        <ul className="prompt-list">
          {memories.map((m) => (
            <li key={m.id} className="prompt-item card">
              <div className="prompt-item-main">
                <strong className="prompt-item-title">{m.title}</strong>
                <p className="prompt-item-body">{m.content}</p>
              </div>
              <div className="prompt-item-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setEditing(m)
                    setFormOpen(true)
                  }}
                >
                  Edit
                </button>
                <ConfirmButton
                  label="Delete"
                  prompt="Delete this memory?"
                  onConfirm={async () => {
                    try {
                      await remove(m.id)
                    } catch (e) {
                      toast(errorMessage(e), 'error')
                    }
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
