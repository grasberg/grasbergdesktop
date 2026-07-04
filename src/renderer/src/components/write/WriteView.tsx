/**
 * Write mode: the chat experience plus a Markdown document panel. The
 * assistant proposes the full document via a ```uld-doc block (saved by a
 * completion hook); the user can also edit it directly and export it.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { Document } from '@shared/types'
import { useChatStore } from '@/stores/chat'
import { useUiStore } from '@/stores/ui'
import ChatView from '@/components/chat/ChatView'
import Markdown from '@/components/chat/Markdown'
import './write.css'

export default function WriteView(): ReactElement {
  const conversation = useChatStore((s) => s.conversation)
  const streaming = useChatStore((s) => s.streaming)
  const toast = useUiStore((s) => s.toast)
  const conversationId = conversation?.id ?? null

  const [doc, setDoc] = useState<Document | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [preview, setPreview] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const prevStreaming = useRef(streaming)

  const loadDoc = useCallback(async (): Promise<void> => {
    if (!conversationId) return
    const res = await window.uld.documents.get(conversationId)
    if (res.ok && res.data) {
      setDoc(res.data)
      // Don't clobber unsaved edits; only sync when clean.
      setContent((cur) => (dirty ? cur : res.data!.content))
    }
  }, [conversationId, dirty])

  useEffect(() => {
    setDirty(false)
    void loadDoc()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  // Reload after a generation finishes (the assistant may have written the doc).
  useEffect(() => {
    if (prevStreaming.current && !streaming) void loadDoc()
    prevStreaming.current = streaming
  }, [streaming, loadDoc])

  const save = async (): Promise<void> => {
    if (!conversationId) return
    const res = await window.uld.documents.save(conversationId, content)
    if (res.ok) {
      setDoc(res.data)
      setDirty(false)
      toast('Document saved.', 'success')
    } else {
      toast(res.error.message, 'error')
    }
  }

  const exportAs = async (format: 'markdown' | 'html'): Promise<void> => {
    if (!conversationId) return
    if (!doc) await save() // ensure a document id exists
    let current = doc
    if (!current) {
      const got = await window.uld.documents.get(conversationId)
      current = got.ok ? got.data : null
    }
    if (!current) return
    const res = await window.uld.documents.export(current.id, format)
    if (res.ok && !res.data.canceled) toast('Document exported.', 'success')
    else if (!res.ok) toast(res.error.message, 'error')
  }

  return (
    <div className={`write-layout${collapsed ? ' panel-collapsed' : ''}`}>
      <div className="write-chat">
        <ChatView />
      </div>
      <aside className="write-panel">
        <header className="write-panel-head">
          <strong>Document{dirty ? ' •' : ''}</strong>
          <div className="write-panel-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setPreview((p) => !p)}>
              {preview ? 'Edit' : 'Preview'}
            </button>
            <button type="button" className="btn" disabled={!dirty} onClick={() => void save()}>
              Save
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void exportAs('markdown')}>
              .md
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void exportAs('html')}>
              .html
            </button>
            <button
              type="button"
              className="btn-icon"
              aria-label="Collapse document panel"
              onClick={() => setCollapsed((c) => !c)}
            >
              ⇥
            </button>
          </div>
        </header>
        {preview ? (
          <div className="write-preview">
            <Markdown content={content || '*The document is empty. Ask the assistant to draft it.*'} />
          </div>
        ) : (
          <textarea
            className="textarea write-editor mono"
            value={content}
            placeholder="Write here, or ask the assistant to draft the document…"
            onChange={(e) => {
              setContent(e.target.value)
              setDirty(true)
            }}
          />
        )}
      </aside>
      {collapsed ? (
        <button
          type="button"
          className="write-reopen"
          aria-label="Show document panel"
          onClick={() => setCollapsed(false)}
        >
          ◀ Document
        </button>
      ) : null}
    </div>
  )
}
