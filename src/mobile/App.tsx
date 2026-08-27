/**
 * The mobile app: pairing screen → conversation list → chat with live
 * streaming, plus the interactive cards (approvals/questions). Deliberately
 * small — a phone surface for the desktop's existing pipeline, not a second
 * implementation of it.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message } from '@shared/types'
import { useMobileStore } from './store'

function StatusDot({ state }: { state: string }): ReactElement {
  const cls =
    state === 'online' ? 'on' : state === 'offline' || state === 'connecting' ? 'wait' : 'off'
  return <span className={`dot ${cls}`} aria-label={`Connection: ${state}`} />
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return `${Math.floor(diff / 86_400_000)}d`
}

function ApprovalCards(): ReactElement | null {
  const approvals = useMobileStore((s) => s.approvals)
  const questions = useMobileStore((s) => s.questions)
  const respondApproval = useMobileStore((s) => s.respondApproval)
  const respondQuestion = useMobileStore((s) => s.respondQuestion)
  const [custom, setCustom] = useState('')
  if (approvals.length === 0 && questions.length === 0) return null
  return (
    <div className="cards">
      {approvals.map((request) => (
        <div key={request.requestId} className="card approval">
          <strong>Approval needed</strong>
          <p className="mono">
            {request.toolCall.name} ({request.risk})
          </p>
          {request.note ? <p>{request.note}</p> : null}
          <div className="card-actions">
            <button
              type="button"
              className="primary"
              onClick={() => void respondApproval(request.requestId, true)}
            >
              Allow once
            </button>
            <button type="button" onClick={() => void respondApproval(request.requestId, false)}>
              Deny
            </button>
          </div>
        </div>
      ))}
      {questions.map((request) => (
        <div key={request.requestId} className="card question">
          <strong>The assistant asks</strong>
          <p>{request.question}</p>
          {request.options.map((option) => (
            <button
              key={option}
              type="button"
              className="chip"
              onClick={() => void respondQuestion(request.requestId, option)}
            >
              {option}
            </button>
          ))}
          <div className="card-actions">
            <input
              value={custom}
              placeholder="Custom answer…"
              onChange={(e) => setCustom(e.target.value)}
            />
            <button
              type="button"
              className="primary"
              disabled={!custom.trim()}
              onClick={() => {
                void respondQuestion(request.requestId, custom.trim())
                setCustom('')
              }}
            >
              Send
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

function MessageBubble({ message }: { message: Message }): ReactElement {
  const mine = message.role === 'user'
  return (
    <div className={`bubble ${mine ? 'mine' : 'theirs'}`}>
      {mine ? (
        message.content
      ) : (
        <div className="md">
          <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
        </div>
      )}
    </div>
  )
}

function ChatView(): ReactElement {
  const conversation = useMobileStore((s) => s.conversation)
  const messages = useMobileStore((s) => s.messages)
  const streams = useMobileStore((s) => s.streams)
  const sendMessage = useMobileStore((s) => s.sendMessage)
  const stopStream = useMobileStore((s) => s.stopStream)
  const closeConversation = useMobileStore((s) => s.closeConversation)
  const regenerate = useMobileStore((s) => s.regenerate)
  const [draft, setDraft] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  const currentId = useMobileStore((s) => s.currentId)
  const activeStreams = Object.entries(streams).filter(
    ([, stream]) => stream.conversationId === currentId
  )
  const streaming = activeStreams.length > 0

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, activeStreams.map(([, s]) => s.text.length).join(',')])

  const submit = (): void => {
    if (!draft.trim() || streaming) return
    void sendMessage(draft)
    setDraft('')
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')

  return (
    <div className="chat">
      <header className="topbar">
        <button type="button" className="icon" onClick={closeConversation} aria-label="Back">
          ‹
        </button>
        <div className="title">
          <strong>{conversation?.title || 'Conversation'}</strong>
          {conversation?.modelId ? <span className="sub">{conversation.modelId}</span> : null}
        </div>
      </header>
      <div className="history">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {activeStreams.map(([streamId, stream]) => (
          <div key={streamId} className="bubble theirs streaming">
            <div className="md">
              <Markdown remarkPlugins={[remarkGfm]}>{stream.text || '…'}</Markdown>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <ApprovalCards />
      <footer className="composer">
        {streaming ? (
          <button type="button" className="stop" onClick={() => void stopStream(activeStreams[0][0])}>
            Stop generating
          </button>
        ) : (
          <div className="input-row">
            <textarea
              value={draft}
              rows={1}
              placeholder="Message Grasberg…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
            <button type="button" className="send" disabled={!draft.trim()} onClick={submit}>
              ↑
            </button>
          </div>
        )}
        {!streaming && lastAssistant ? (
          <button
            type="button"
            className="regen"
            onClick={() => void regenerate(lastAssistant.id)}
          >
            Regenerate
          </button>
        ) : null}
      </footer>
    </div>
  )
}

function ConversationList(): ReactElement {
  const conversations = useMobileStore((s) => s.conversations)
  const loading = useMobileStore((s) => s.conversationsLoading)
  const openConversation = useMobileStore((s) => s.openConversation)
  const newConversation = useMobileStore((s) => s.newConversation)
  return (
    <div className="list">
      <header className="topbar">
        <strong>Grasberg</strong>
        <button type="button" className="primary" onClick={() => void newConversation()}>
          + New
        </button>
      </header>
      <ApprovalCards />
      {loading && conversations.length === 0 ? <p className="empty">Loading…</p> : null}
      {!loading && conversations.length === 0 ? (
        <p className="empty">No conversations yet. Start one, or use the desktop app.</p>
      ) : null}
      <ul>
        {conversations.map((summary) => (
          <li key={summary.id}>
            <button type="button" onClick={() => void openConversation(summary.id)}>
              <span className="title">{summary.title || 'Untitled'}</span>
              {summary.snippet ? <span className="snippet">{summary.snippet}</span> : null}
              <span className="when">{relativeTime(summary.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Gate({ children }: { children: ReactElement }): ReactElement {
  const state = useMobileStore((s) => s.tunnelState)
  const error = useMobileStore((s) => s.tunnelError)
  const forgetDevice = useMobileStore((s) => s.forgetDevice)
  if (state === 'unpaired' || state === 'pairing' || state === 'error') {
    return (
      <div className="gate">
        <h1>Grasberg</h1>
        {state === 'pairing' ? <p>Pairing with your desktop…</p> : null}
        {state === 'unpaired' ? (
          <p>
            This browser is not paired. Open <strong>Settings → Bridges → Remote access</strong> in
            the desktop app and scan the QR code with this phone.
          </p>
        ) : null}
        {state === 'error' ? <p className="error">{error}</p> : null}
        {state !== 'pairing' ? (
          <button type="button" onClick={() => location.reload()}>
            Try again
          </button>
        ) : null}
        {state === 'error' && error?.includes('revoked') ? (
          <button type="button" onClick={forgetDevice}>
            Reset this device
          </button>
        ) : null}
      </div>
    )
  }
  return children
}

export default function App(): ReactElement {
  const state = useMobileStore((s) => s.tunnelState)
  const currentId = useMobileStore((s) => s.currentId)
  const toast = useMobileStore((s) => s.toast)
  const setToast = useMobileStore((s) => s.setToast)
  const appVersion = useMobileStore((s) => s.appVersion)
  const init = useMobileStore((s) => s.init)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast, setToast])

  return (
    <div className="app" data-state={state}>
      {toast ? <div className="toast">{toast}</div> : null}
      <Gate>
        {currentId ? (
          <ChatView />
        ) : (
          <>
            <ConversationList />
            <footer className="statusbar">
              <StatusDot state={state} />
              <span>
                {state === 'online'
                  ? `Connected${appVersion ? ` · desktop v${appVersion}` : ''}`
                  : state === 'offline'
                    ? 'Desktop offline — it will reconnect automatically'
                    : 'Connecting…'}
              </span>
            </footer>
          </>
        )}
      </Gate>
    </div>
  )
}
