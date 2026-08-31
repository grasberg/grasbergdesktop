/**
 * The Home "Notes" card: living Markdown documents the user and the assistant
 * both edit (the assistant through its list/read/edit_document tools). Rows
 * open the notebook modal; tool-driven edits refresh the list live via
 * push:documentsChanged.
 */

import { useEffect, useState, type ReactElement } from 'react'
import { unwrap } from '@/api/uld'
import { relativeTime } from '@/lib/format'
import { toastError } from '@/stores/ui'
import { useDocumentsStore } from '@/stores/documents'
import NotebookModal from './NotebookModal'

export default function NotesCard(): ReactElement {
  const documents = useDocumentsStore((s) => s.documents)
  const loaded = useDocumentsStore((s) => s.loaded)
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    void useDocumentsStore.getState().load()
    return window.uld.documents.onChanged(() => void useDocumentsStore.getState().load())
  }, [])

  const createNote = async (): Promise<void> => {
    try {
      const doc = await unwrap(window.uld.documents.create({ title: 'Untitled note', content: '' }))
      await useDocumentsStore.getState().load()
      setOpenId(doc.id)
    } catch (e) {
      toastError('Failed to create note', e)
    }
  }

  return (
    <section className="card home-card home-card-notes" aria-label="Notes">
      <div className="home-card-head">
        <h2 className="home-card-title">Notes</h2>
        <button
          type="button"
          className="btn btn-ghost home-card-action"
          onClick={() => void createNote()}
        >
          New note
        </button>
      </div>

      {!loaded ? (
        <div aria-hidden="true">
          <div className="home-skeleton" />
          <div className="home-skeleton" />
        </div>
      ) : documents.length === 0 ? (
        <div className="home-empty">
          <p>
            No notes yet. Notes are living Markdown documents you and the assistant both edit —
            the assistant reaches them with its document tools.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => void createNote()}>
            New note
          </button>
        </div>
      ) : (
        <ul className="home-list">
          {documents.map((doc) => (
            <li key={doc.id}>
              <button
                type="button"
                className="home-row-btn"
                title={`Open "${doc.title}"`}
                onClick={() => setOpenId(doc.id)}
              >
                <span className="home-row-main">
                  <span className="home-row-title">{doc.title}</span>
                  <span className="home-row-meta">{doc.contentLength} chars</span>
                </span>
                <span className="home-row-time">{relativeTime(doc.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {openId ? (
        <NotebookModal
          docId={openId}
          onClose={() => {
            setOpenId(null)
            void useDocumentsStore.getState().load()
          }}
        />
      ) : null}
    </section>
  )
}
