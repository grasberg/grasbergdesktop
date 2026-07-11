/**
 * Workspace item list for the Work panel's Tasks tab: items grouped by kind, with
 * kind-specific bodies (task status, interactive checklists, markdown docs),
 * an origin badge separating user items from assistant proposals, inline
 * delete confirmation and an "Add" menu for user-created items.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { WorkspaceItem, WorkspaceItemKind } from '@shared/types'
import Markdown from '@/components/chat/Markdown'
import { useWorkspaceStore } from '@/stores/workspace'
import './work.css'

const KIND_SECTIONS: Array<{ kind: WorkspaceItemKind; heading: string }> = [
  { kind: 'plan', heading: 'Plan' },
  { kind: 'task', heading: 'Tasks' },
  { kind: 'checklist', heading: 'Checklists' },
  { kind: 'note', heading: 'Notes' },
  { kind: 'doc', heading: 'Docs' },
]

const KIND_LABEL: Record<WorkspaceItemKind, string> = {
  plan: 'Plan',
  task: 'Task',
  checklist: 'Checklist',
  note: 'Note',
  doc: 'Doc',
}

const TASK_STATUSES = ['todo', 'doing', 'done'] as const

/** Matches "- [ ] item" / "* [x] item" lines (leading indent allowed). */
const CHECKBOX_LINE = /^\s*[-*]\s*\[( |x|X)\]\s?(.*)$/

function OriginBadge({ origin }: { origin: WorkspaceItem['origin'] }): ReactElement {
  return (
    <span
      className={`cowork-origin ${origin === 'user' ? 'cowork-origin-user' : 'cowork-origin-assistant'}`}
      title={origin === 'user' ? 'Created by you' : 'Proposed by the assistant'}
    >
      {origin === 'user' ? 'you' : 'assistant'}
    </span>
  )
}

function ChecklistBody({ item }: { item: WorkspaceItem }): ReactElement {
  const toggleChecklistLine = useWorkspaceStore((s) => s.toggleChecklistLine)
  const lines = item.content.split('\n')
  const hasBoxes = lines.some((l) => CHECKBOX_LINE.test(l))
  if (!hasBoxes) {
    return <p className="cowork-item-empty">No checklist entries yet — edit to add “- [ ]” lines.</p>
  }
  return (
    <ul className="cowork-checklist">
      {lines.map((line, index) => {
        const match = CHECKBOX_LINE.exec(line)
        if (!match) {
          const text = line.trim()
          return text ? (
            <li key={index} className="cowork-checklist-text">
              {text}
            </li>
          ) : null
        }
        const checked = match[1].toLowerCase() === 'x'
        return (
          <li key={index} className="cowork-checklist-row">
            <label className="cowork-checkbox">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => void toggleChecklistLine(item.id, index)}
              />
              <span className={checked ? 'cowork-checked' : undefined}>{match[2] || '…'}</span>
            </label>
          </li>
        )
      })}
    </ul>
  )
}

function TaskBody({ item }: { item: WorkspaceItem }): ReactElement {
  const setTaskStatus = useWorkspaceStore((s) => s.setTaskStatus)
  return (
    <div className="cowork-task-body">
      <select
        className="select cowork-task-status"
        aria-label={`Status for ${item.title}`}
        value={item.status ?? 'todo'}
        onChange={(e) => void setTaskStatus(item.id, e.target.value as 'todo' | 'doing' | 'done')}
      >
        {TASK_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {item.content.trim() && <Markdown content={item.content} />}
    </div>
  )
}

function ItemCard({ item }: { item: WorkspaceItem }): ReactElement {
  const updateItem = useWorkspaceStore((s) => s.updateItem)
  const deleteItem = useWorkspaceStore((s) => s.deleteItem)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saving, setSaving] = useState(false)

  const startEdit = (): void => {
    setDraft(item.content)
    setEditing(true)
  }

  const saveEdit = async (): Promise<void> => {
    setSaving(true)
    try {
      await updateItem(item.id, { content: draft })
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  const markdownKind = item.kind === 'note' || item.kind === 'doc' || item.kind === 'plan'
  const done = item.kind === 'task' && item.status === 'done'

  return (
    <article className={`cowork-item card${item.origin === 'user' ? ' cowork-item-user' : ''}`}>
      <header className="cowork-item-head">
        <span className={`cowork-item-title${done ? ' cowork-checked' : ''}`} title={item.title}>
          {item.title}
        </span>
        <OriginBadge origin={item.origin} />
        <div className="cowork-item-actions">
          {!editing && (
            <button
              type="button"
              className="btn-icon"
              aria-label={`Edit ${item.title}`}
              title="Edit content"
              onClick={startEdit}
            >
              ✎
            </button>
          )}
          {!confirmDelete && (
            <button
              type="button"
              className="btn-icon"
              aria-label={`Delete ${item.title}`}
              title="Delete"
              onClick={() => setConfirmDelete(true)}
            >
              🗑
            </button>
          )}
        </div>
      </header>

      {confirmDelete && (
        <div className="cowork-confirm" role="alert">
          <span className="cowork-confirm-label">Delete this {KIND_LABEL[item.kind].toLowerCase()}?</span>
          <button
            type="button"
            className="btn btn-danger cowork-confirm-btn"
            onClick={() => void deleteItem(item.id)}
          >
            Delete
          </button>
          <button
            type="button"
            className="btn btn-ghost cowork-confirm-btn"
            onClick={() => setConfirmDelete(false)}
          >
            Cancel
          </button>
        </div>
      )}

      {editing ? (
        <div className="cowork-item-edit">
          <textarea
            className="textarea cowork-item-textarea"
            rows={6}
            value={draft}
            autoFocus
            aria-label={`Content for ${item.title}`}
            placeholder={item.kind === 'checklist' ? '- [ ] First step' : 'Markdown content'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false)
            }}
          />
          <div className="cowork-item-edit-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving}
              onClick={() => void saveEdit()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="cowork-item-body">
          {item.kind === 'task' && <TaskBody item={item} />}
          {item.kind === 'checklist' && <ChecklistBody item={item} />}
          {markdownKind &&
            (item.content.trim() ? (
              <div
                className="cowork-item-md"
                role="button"
                tabIndex={0}
                title="Click to edit"
                onClick={startEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    startEdit()
                  }
                }}
              >
                <Markdown content={item.content} />
              </div>
            ) : (
              <button type="button" className="cowork-item-empty-btn" onClick={startEdit}>
                Empty — click to write
              </button>
            ))}
        </div>
      )}
    </article>
  )
}

function AddItemMenu(): ReactElement {
  const createItem = useWorkspaceStore((s) => s.createItem)
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<WorkspaceItemKind>('task')
  const [title, setTitle] = useState('')
  const [adding, setAdding] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const add = async (): Promise<void> => {
    const trimmed = title.trim()
    if (!trimmed) return
    setAdding(true)
    try {
      await createItem(kind, trimmed, kind === 'checklist' ? '- [ ] First step' : '', 'user')
      setTitle('')
      setOpen(false)
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="cowork-add" ref={rootRef}>
      <button
        type="button"
        className="btn cowork-add-btn"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        + Add
      </button>
      {open && (
        <div className="cowork-add-popover" role="dialog" aria-label="Add workspace item">
          <label className="cowork-add-label" htmlFor="cowork-add-kind">
            Kind
          </label>
          <select
            id="cowork-add-kind"
            className="select"
            value={kind}
            onChange={(e) => setKind(e.target.value as WorkspaceItemKind)}
          >
            {KIND_SECTIONS.map(({ kind: k }) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <label className="cowork-add-label" htmlFor="cowork-add-title">
            Title
          </label>
          <input
            id="cowork-add-title"
            className="input"
            value={title}
            autoFocus
            placeholder={`New ${KIND_LABEL[kind].toLowerCase()} title`}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add()
            }}
          />
          <div className="cowork-add-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={adding || !title.trim()}
              onClick={() => void add()}
            >
              {adding ? 'Adding…' : 'Add'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function WorkspaceItems(): ReactElement {
  const items = useWorkspaceStore((s) => s.items)
  const loading = useWorkspaceStore((s) => s.loading)

  const sections = KIND_SECTIONS.map(({ kind, heading }) => ({
    kind,
    heading,
    items: items.filter((x) => x.kind === kind),
  })).filter((s) => s.items.length > 0)

  return (
    <section className="cowork-items" aria-label="Workspace items">
      <div className="cowork-items-toolbar">
        <h3 className="cowork-items-heading">Items</h3>
        <AddItemMenu />
      </div>
      {loading && items.length === 0 && <p className="cowork-item-empty">Loading…</p>}
      {!loading && items.length === 0 && (
        <p className="cowork-item-empty">
          Nothing here yet. Add plans, tasks, checklists or notes — the assistant can propose
          items too as you work.
        </p>
      )}
      {sections.map(({ kind, heading, items: sectionItems }) => (
        <div key={kind} className="cowork-section">
          <h4 className="cowork-section-heading">{heading}</h4>
          {sectionItems.map((item) => (
            <ItemCard key={item.id} item={item} />
          ))}
        </div>
      ))}
    </section>
  )
}
