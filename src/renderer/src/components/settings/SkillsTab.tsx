/**
 * Settings → Skills: install skills in the standard Agent Skills format —
 * import a skill folder (SKILL.md), a folder of skills, or a plugin
 * (.claude-plugin/plugin.json) — or author one manually. Enabled skills are
 * listed in the system prompt; the model loads their instructions on demand
 * via the use_skill tool.
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { Skill } from '@shared/types'
import { ConfirmButton, Switch } from '@/components/common/controls'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { useEditorState } from '@/hooks/useEditorState'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'
import { useSkillsStore } from '@/stores/skills'
import { useUiStore } from '@/stores/ui'
import { toNormalized, unwrap } from '@/api/uld'
import './settings.css'

function SkillForm({ editing, onDone }: { editing: Skill | null; onDone: () => void }): ReactElement {
  const create = useSkillsStore((s) => s.create)
  const update = useSkillsStore((s) => s.update)
  const toast = useUiStore((s) => s.toast)
  const [name, setName] = useState(editing?.name ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [content, setContent] = useState(editing?.content ?? '')
  const [busy, run] = useAsyncAction()
  const guard = useUnsavedChanges(name !== (editing?.name ?? '') || description !== (editing?.description ?? '') || content !== (editing?.content ?? ''), 'settings')

  const submit = async (): Promise<void> => {
    if (name.trim().length === 0) {
      toast('Give the skill a name.', 'error')
      return
    }
    if (content.trim().length === 0) {
      toast('Add the skill instructions.', 'error')
      return
    }
    await run(async () => {
      if (editing) {
        await update(editing.id, { name, description, content })
      } else {
        await create({ name, description, content })
      }
      guard.markSaved(); onDone()
    })
  }

  return (
    <div className="card prompt-form">
      <h5>{editing ? 'Edit skill' : 'New skill'}</h5>
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="input"
          value={name}
          maxLength={100}
          placeholder="e.g. commit-messages"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">Description</span>
        <input
          className="input"
          value={description}
          maxLength={1024}
          placeholder="One line: when should the assistant use this skill?"
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">Instructions (Markdown)</span>
        <textarea
          className="textarea"
          rows={10}
          value={content}
          placeholder="The skill's full instructions — the SKILL.md body…"
          onChange={(e) => setContent(e.target.value)}
        />
      </label>
      <div className="prompt-form-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Add skill'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => guard.discard(onDone)}>
          Cancel
        </button>
      </div>
    </div>
  )
}

export default function SkillsTab(): ReactElement {
  const skills = useSkillsStore((s) => s.skills)
  const loaded = useSkillsStore((s) => s.loaded)
  const load = useSkillsStore((s) => s.load)
  const update = useSkillsStore((s) => s.update)
  const remove = useSkillsStore((s) => s.remove)
  const importFolder = useSkillsStore((s) => s.importFolder)
  const toast = useUiStore((s) => s.toast)
  const [, run] = useAsyncAction()

  const { formOpen, editing, openAdd, openEdit, closeForm } = useEditorState<Skill>()
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  const runImport = async (): Promise<void> => {
    setImporting(true)
    try {
      const path = await unwrap(window.uld.app.pickFolder())
      if (!path) return
      const imported = await importFolder(path)
      toast(
        imported.length === 1
          ? `Imported the skill "${imported[0].name}".`
          : `Imported ${imported.length} skills.`,
        'success'
      )
    } catch (e) {
      toast(toNormalized(e).message, 'error')
    } finally {
      setImporting(false)
    }
  }

  return (
    <section aria-label="Skills">
      <header className="tab-header">
        <div>
          <h3>Skills</h3>
          <p className="field-hint">
            Install skills in the standard Agent Skills format: a folder with a SKILL.md (YAML
            frontmatter + Markdown instructions), a folder of such skills, or a plugin with a
            .claude-plugin/plugin.json manifest. Enabled skills are offered to the assistant, which
            loads their instructions on demand.
          </p>
        </div>
        <div className="prompt-form-actions">
          <button type="button" className="btn" disabled={importing} onClick={() => void runImport()}>
            {importing ? 'Importing…' : 'Import folder…'}
          </button>
          {!formOpen ? (
            <button type="button" className="btn" onClick={openAdd}>
              + New skill
            </button>
          ) : null}
        </div>
      </header>

      {formOpen ? (
        <SkillForm key={editing?.id ?? 'new'} editing={editing} onDone={closeForm} />
      ) : null}

      {!loaded ? (
        <p className="field-hint">Loading…</p>
      ) : skills.length === 0 && !formOpen ? (
        <div className="empty-state card">
          <p>No skills installed yet. Import a skill or plugin folder, or create one manually.</p>
        </div>
      ) : (
        <ul className="prompt-list">
          {skills.map((skill) => (
            <li key={skill.id} className="prompt-item card">
              <div className="prompt-item-main">
                <strong className="prompt-item-title">
                  {skill.name}
                  {skill.pluginName ? (
                    <span className="field-hint"> — plugin: {skill.pluginName}</span>
                  ) : null}
                </strong>
                <p className="prompt-item-body">{skill.description || '(no description)'}</p>
              </div>
              <div className="prompt-item-actions">
                <Switch
                  checked={skill.enabled}
                  onChange={(v) => void run(() => update(skill.id, { enabled: v }))}
                  label={`Enable ${skill.name}`}
                />
                <button type="button" className="btn btn-ghost" onClick={() => openEdit(skill)}>
                  Edit
                </button>
                <ConfirmButton
                  label="Delete"
                  prompt="Delete this skill?"
                  onConfirm={() => run(() => remove(skill.id))}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
