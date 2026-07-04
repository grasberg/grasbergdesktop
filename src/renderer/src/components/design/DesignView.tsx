/**
 * Design mode: the chat experience plus a sandboxed preview of the HTML
 * prototypes the assistant produces (```uld-html blocks, saved by a completion
 * hook). Prototypes render in an iframe with `sandbox` and no network access.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { Document } from '@shared/types'
import { useChatStore } from '@/stores/chat'
import { useUiStore } from '@/stores/ui'
import ChatView from '@/components/chat/ChatView'
import './design.css'

export default function DesignView(): ReactElement {
  const conversation = useChatStore((s) => s.conversation)
  const streaming = useChatStore((s) => s.streaming)
  const toast = useUiStore((s) => s.toast)
  const conversationId = conversation?.id ?? null

  const [artifacts, setArtifacts] = useState<Document[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const prevStreaming = useRef(streaming)

  const load = useCallback(async (): Promise<void> => {
    if (!conversationId) return
    const res = await window.uld.documents.listHtml(conversationId)
    if (res.ok) {
      setArtifacts(res.data)
      setSelectedId((cur) => cur ?? res.data[0]?.id ?? null)
    }
  }, [conversationId])

  useEffect(() => {
    setSelectedId(null)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  // After a generation, a new prototype may have been produced — reload and
  // select the newest.
  useEffect(() => {
    if (prevStreaming.current && !streaming) {
      void window.uld.documents.listHtml(conversationId ?? '').then((res) => {
        if (res.ok) {
          setArtifacts(res.data)
          if (res.data[0]) setSelectedId(res.data[0].id)
        }
      })
    }
    prevStreaming.current = streaming
  }, [streaming, conversationId])

  const selected = artifacts.find((a) => a.id === selectedId) ?? null

  const exportHtml = async (): Promise<void> => {
    if (!selected) return
    const res = await window.uld.documents.export(selected.id, 'html')
    if (res.ok && !res.data.canceled) toast('Prototype exported.', 'success')
    else if (!res.ok) toast(res.error.message, 'error')
  }

  return (
    <div className={`design-layout${collapsed ? ' panel-collapsed' : ''}`}>
      <div className="design-chat">
        <ChatView />
      </div>
      <aside className="design-panel">
        <header className="design-panel-head">
          <select
            className="select"
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(e.target.value || null)}
            aria-label="Prototype"
          >
            {artifacts.length === 0 ? <option value="">No prototypes yet</option> : null}
            {artifacts.map((a, i) => (
              <option key={a.id} value={a.id}>
                {a.title || `Prototype ${artifacts.length - i}`}
              </option>
            ))}
          </select>
          <div className="design-panel-actions">
            <button type="button" className="btn btn-ghost" disabled={!selected} onClick={() => void exportHtml()}>
              Export .html
            </button>
            <button
              type="button"
              className="btn-icon"
              aria-label="Collapse preview panel"
              onClick={() => setCollapsed((c) => !c)}
            >
              ⇥
            </button>
          </div>
        </header>
        {selected ? (
          <iframe
            className="design-preview"
            title="Prototype preview"
            sandbox="allow-scripts"
            srcDoc={selected.content}
          />
        ) : (
          <div className="design-empty">
            Ask the assistant to design an interactive prototype — it will appear here.
          </div>
        )}
      </aside>
      {collapsed ? (
        <button
          type="button"
          className="design-reopen"
          aria-label="Show preview panel"
          onClick={() => setCollapsed(false)}
        >
          ◀ Preview
        </button>
      ) : null}
    </div>
  )
}
