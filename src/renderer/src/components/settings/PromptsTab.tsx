/**
 * Settings → Prompts: the prompt library. Reusable saved prompts that can be
 * inserted into the composer (paperclip's sibling) or set as a conversation's
 * system prompt from the chat header.
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { PromptTemplate } from '@shared/types'
import { ConfirmButton } from '@/components/common/controls'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { useEditorState } from '@/hooks/useEditorState'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'
import { usePromptsStore } from '@/stores/prompts'
import { useUiStore } from '@/stores/ui'
import './settings.css'

function PromptForm({
  editing,
  onDone,
}: {
  editing: PromptTemplate | null
  onDone: () => void
}): ReactElement {
  const create = usePromptsStore((s) => s.create)
  const update = usePromptsStore((s) => s.update)
  const toast = useUiStore((s) => s.toast)
  const [title, setTitle] = useState(editing?.title ?? '')
  const [body, setBody] = useState(editing?.body ?? '')
  const [busy, run] = useAsyncAction()
  const guard = useUnsavedChanges(title !== (editing?.title ?? '') || body !== (editing?.body ?? ''), 'settings')

  const submit = async (): Promise<void> => {
    if (title.trim().length === 0) {
      toast('Give the prompt a title.', 'error')
      return
    }
    await run(async () => {
      if (editing) {
        await update(editing.id, { title, body })
      } else {
        await create({ title, body })
      }
      guard.markSaved(); onDone()
    })
  }

  return (
    <div className="card prompt-form">
      <h5>{editing ? 'Edit prompt' : 'New prompt'}</h5>
      <label className="field">
        <span className="field-label">Title</span>
        <input
          className="input"
          value={title}
          maxLength={200}
          placeholder="e.g. Concise code reviewer"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">Prompt</span>
        <textarea
          className="textarea"
          rows={8}
          value={body}
          placeholder="The prompt text to insert or use as a system prompt…"
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <div className="prompt-form-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Add prompt'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => guard.discard(onDone)}>
          Cancel
        </button>
      </div>
    </div>
  )
}

export default function PromptsTab(): ReactElement {
  const templates = usePromptsStore((s) => s.templates)
  const loaded = usePromptsStore((s) => s.loaded)
  const load = usePromptsStore((s) => s.load)
  const remove = usePromptsStore((s) => s.remove)
  const [, run] = useAsyncAction()

  const { formOpen, editing, openAdd, openEdit, closeForm } = useEditorState<PromptTemplate>()

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section aria-label="Prompts">
      <header className="tab-header">
        <div>
          <h3>Prompt library</h3>
          <p className="field-hint">
            Save prompts you reuse often. Insert them into the composer, or set one as a
            conversation&apos;s system prompt from the chat header.
          </p>
        </div>
        {!formOpen ? (
          <button type="button" className="btn" onClick={openAdd}>
            + New prompt
          </button>
        ) : null}
      </header>

      {formOpen ? (
        <PromptForm key={editing?.id ?? 'new'} editing={editing} onDone={closeForm} />
      ) : null}

      {!loaded ? (
        <p className="field-hint">Loading…</p>
      ) : templates.length === 0 && !formOpen ? (
        <div className="empty-state card">
          <p>No saved prompts yet.</p>
        </div>
      ) : (
        <ul className="prompt-list">
          {templates.map((t) => (
            <li key={t.id} className="prompt-item card">
              <div className="prompt-item-main">
                <strong className="prompt-item-title">{t.title}</strong>
                <p className="prompt-item-body">{t.body}</p>
              </div>
              <div className="prompt-item-actions">
                <button type="button" className="btn btn-ghost" onClick={() => openEdit(t)}>
                  Edit
                </button>
                <ConfirmButton
                  label="Delete"
                  prompt="Delete this prompt?"
                  onConfirm={() => run(() => remove(t.id))}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
