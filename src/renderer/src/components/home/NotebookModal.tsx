/**
 * Notebook editor modal: Markdown view (the chat rendering pipeline), plain
 * textarea edit mode, version history with restore, .md export and delete.
 * Owned by the Home Notes card — not a routed view.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { NotebookDoc, NotebookDocVersionSummary } from '@shared/types'
import { unwrap } from '@/api/uld'
import { relativeTime } from '@/lib/format'
import { toastError } from '@/stores/ui'
import Markdown from '@/components/chat/Markdown'

interface NotebookModalProps {
  docId: string
  onClose: () => void
}

export default function NotebookModal({ docId, onClose }: NotebookModalProps): ReactElement {
  const [doc, setDoc] = useState<NotebookDoc | null>(null)
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [versions, setVersions] = useState<NotebookDocVersionSummary[] | null>(null)
  const [busy, setBusy] = useState(false)

  const refetch = useCallback(async (): Promise<void> => {
    try {
      setDoc(await unwrap(window.uld.documents.get(docId)))
    } catch (e) {
      toastError('Failed to load note', e)
    }
  }, [docId])

  const loadVersions = useCallback(async (): Promise<void> => {
    try {
      setVersions(await unwrap(window.uld.documents.listVersions(docId)))
    } catch (e) {
      toastError('Failed to load versions', e)
    }
  }, [docId])

  useEffect(() => {
    void refetch()
  }, [refetch])

  // Manual drafts are only versioned at Save — closing with a dirty draft
  // (Escape, backdrop mis-click, Close) would destroy it unrecoverably.
  const dirty =
    editing && doc !== null && (draftTitle !== doc.title || draftContent !== doc.content)
  const requestClose = useCallback((): void => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return
    onClose()
  }, [dirty, onClose])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [requestClose])

  const startEdit = (): void => {
    if (!doc) return
    setDraftTitle(doc.title)
    setDraftContent(doc.content)
    setEditing(true)
  }

  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await unwrap(
        window.uld.documents.update(docId, {
          title: draftTitle.trim() || 'Untitled note',
          content: draftContent,
        })
      )
      setEditing(false)
      await refetch()
      if (showHistory) await loadVersions()
    } catch (e) {
      toastError('Failed to save note', e)
    } finally {
      setBusy(false)
    }
  }

  const toggleHistory = async (): Promise<void> => {
    const next = !showHistory
    setShowHistory(next)
    if (next) await loadVersions()
  }

  const restore = async (version: NotebookDocVersionSummary): Promise<void> => {
    if (!window.confirm('Restore this version? The current content is saved as a version.')) return
    try {
      await unwrap(window.uld.documents.revert(docId, version.id))
      await refetch()
      await loadVersions()
    } catch (e) {
      toastError('Failed to restore version', e)
    }
  }

  const exportMd = async (): Promise<void> => {
    try {
      await unwrap(window.uld.documents.export(docId))
    } catch (e) {
      toastError('Failed to export note', e)
    }
  }

  const remove = async (): Promise<void> => {
    if (!window.confirm('Delete this note and its version history?')) return
    try {
      await unwrap(window.uld.documents.delete(docId))
      onClose()
    } catch (e) {
      toastError('Failed to delete note', e)
    }
  }

  return (
    <div className="modal-backdrop" onClick={requestClose}>
      <div
        className="modal notebook-modal"
        role="dialog"
        aria-modal="true"
        aria-label={doc?.title ?? 'Note'}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="notebook-toolbar">
          {editing ? (
            <input
              className="input notebook-title-input"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              maxLength={200}
              aria-label="Note title"
            />
          ) : (
            <h2 className="notebook-title">{doc?.title ?? '…'}</h2>
          )}
          <div className="notebook-actions">
            {editing ? (
              <>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
                  Save
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn" disabled={!doc} onClick={startEdit}>
                  Edit
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => void toggleHistory()}>
                  {showHistory ? 'Hide history' : 'History'}
                </button>
                <button type="button" className="btn btn-ghost" disabled={!doc} onClick={() => void exportMd()}>
                  Export .md
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => void remove()}>
                  Delete
                </button>
              </>
            )}
            <button type="button" className="btn btn-ghost" onClick={requestClose}>
              Close
            </button>
          </div>
        </div>

        {editing ? (
          <textarea
            className="textarea notebook-textarea"
            value={draftContent}
            onChange={(event) => setDraftContent(event.target.value)}
            aria-label="Note content (Markdown)"
          />
        ) : (
          <div className="notebook-content">
            {doc === null ? null : doc.content.trim().length === 0 ? (
              <p className="notebook-empty">This note is empty. Click Edit to start writing.</p>
            ) : (
              <Markdown content={doc.content} />
            )}
          </div>
        )}

        {showHistory && !editing ? (
          <div className="notebook-versions">
            {versions === null ? null : versions.length === 0 ? (
              <p className="notebook-empty">No versions yet — they appear when the content changes.</p>
            ) : (
              <ul className="notebook-version-list">
                {versions.map((version) => (
                  <li key={version.id} className="notebook-version-row">
                    <span className="notebook-version-meta">
                      {relativeTime(version.createdAt)} · {version.contentLength} chars
                    </span>
                    <button type="button" className="btn btn-ghost" onClick={() => void restore(version)}>
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
