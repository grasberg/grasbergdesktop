/**
 * The mobile app: pairing screen → conversation list → chat with live
 * streaming, plus the interactive cards (approvals/questions). Deliberately
 * small — a phone surface for the desktop's existing pipeline, not a second
 * implementation of it.
 */

import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message } from '@shared/types'
import { requestRemote, subscribeRemote, useMobileStore } from './store'
import { loadIdentity } from './tunnel'
const FullApp = lazy(() => import('./full/FullApp'))

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
  const [custom, setCustom] = useState<Record<string, string>>({})
  const responding = useMobileStore((s) => s.responding)
  const online = useMobileStore((s) => s.tunnelState === 'online')
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
          <details><summary>Review tool arguments</summary><pre>{JSON.stringify(request.toolCall.arguments, null, 2)}</pre></details>
          {!online ? <p role="status">Reconnect to respond. This request remains on your desktop.</p> : null}
          <div className="card-actions">
            <button
              type="button"
              className="primary"
              disabled={!online || responding[request.requestId]}
              onClick={() => void respondApproval(request.requestId, true)}
            >
              Allow once
            </button>
            <button type="button" disabled={!online || responding[request.requestId]} onClick={() => void respondApproval(request.requestId, false)}>
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
              disabled={!online || responding[request.requestId]}
              onClick={() => void respondQuestion(request.requestId, option)}
            >
              {option}
            </button>
          ))}
          <div className="card-actions">
            <input
              aria-label="Custom answer"
              value={custom[request.requestId] ?? ''}
              placeholder="Custom answer…"
              onChange={(e) => setCustom(s => ({ ...s, [request.requestId]: e.target.value }))}
            />
            <button
              type="button"
              className="primary"
              disabled={!online || responding[request.requestId] || !custom[request.requestId]?.trim()}
              onClick={async () => {
                if (await respondQuestion(request.requestId, custom[request.requestId].trim())) {
                  setCustom(s => ({ ...s, [request.requestId]: '' }))
                }
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
  const bottomRef = useRef<HTMLDivElement>(null)
  const followBottom = useRef(true)
  const [showJump, setShowJump] = useState(false)

  const currentId = useMobileStore((s) => s.currentId)
  const draft = useMobileStore((s) => s.currentId ? s.drafts[s.currentId] ?? '' : '')
  const setDraft = useMobileStore((s) => s.setDraft)
  const pendingSend = useMobileStore((s) => s.currentId ? s.sends[s.currentId] : undefined)
  const online = useMobileStore((s) => s.tunnelState === 'online')
  const activeStreams = Object.entries(streams).filter(
    ([, stream]) => stream.conversationId === currentId
  )
  const streaming = activeStreams.length > 0

  useEffect(() => {
    if (followBottom.current) bottomRef.current?.scrollIntoView({ behavior: 'instant' })
  }, [messages.length, activeStreams.map(([, s]) => s.text.length).join(',')])

  const submit = (): void => {
    if (!draft.trim() || !online || pendingSend?.status === 'sending') return
    void sendMessage(draft)
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
      <div className="history" onScroll={e => {
        const el = e.currentTarget
        followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
        setShowJump(!followBottom.current)
      }}>
        {messages.filter(m => !streaming || m.status !== 'streaming').map((message) => (
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
      {showJump ? <button type="button" onClick={() => { followBottom.current = true; bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }}>Jump to latest ↓</button> : null}
      <ApprovalCards />
      <footer className="composer">
        {pendingSend?.error ? <p role="alert" className="error">{pendingSend.error} Your draft is kept. Use Send to retry.</p> : null}
        {!online ? <p role="status">Offline — your draft is saved on this device.</p> : null}
        {streaming ? (
          <button type="button" disabled={!online} className="stop" onClick={() => void stopStream(activeStreams[0][0])}>
            Stop generating
          </button>
        ) : null}
          <div className="input-row">
            <textarea
              value={draft}
              rows={1}
              aria-label="Message"
              placeholder={streaming ? 'Queue a follow-up…' : 'Message Grasberg…'}
              onChange={(e) => { if (currentId) setDraft(currentId, e.target.value) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
            <button type="button" aria-label="Send message" className="send" disabled={!online || !draft.trim() || pendingSend?.status === 'sending'} onClick={submit}>
              {pendingSend?.status === 'sending' ? '…' : '↑'}
            </button>
          </div>
        {!streaming && lastAssistant ? (
          <button
            type="button"
            className="regen"
            disabled={!online || pendingSend?.status === 'sending'}
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
  const online = useMobileStore((s) => s.tunnelState === 'online')
  return (
    <div className="list">
      <header className="topbar">
        <strong>Grasberg</strong>
        <button type="button" className="primary" disabled={!online} onClick={() => void newConversation()}>
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

function Gate({ children }: { children: ReactNode }): ReactNode {
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
  const capabilities = useMobileStore(s => s.capabilities)
  const [showCompact, setShowCompact] = useState(false)
  const host = useMemo(() => ({ request: requestRemote, subscribe: subscribeRemote, capabilities: () => useMobileStore.getState().capabilities!, draftKey: `grasberg.remote-draft.${loadIdentity()?.deviceId ?? 'unpaired'}` }), [])
  const state = useMobileStore((s) => s.tunnelState)
  const currentId = useMobileStore((s) => s.currentId)
  const toast = useMobileStore((s) => s.toast)
  const setToast = useMobileStore((s) => s.setToast)
  const appVersion = useMobileStore((s) => s.appVersion)
  const init = useMobileStore((s) => s.init)

  useEffect(() => {
    void init()
  }, [init])

  if (capabilities?.access === 'full' && !showCompact && !['unpaired', 'pairing', 'error'].includes(state)) return <Suspense fallback={<p role="status">Loading full app…</p>}><FullApp host={host} online={state === 'online'} onLeave={() => setShowCompact(true)} /></Suspense>

  return (
    <div className="app" data-state={state}>
      {toast ? <div className="toast" role="alert">{toast}<button type="button" aria-label="Dismiss notification" onClick={() => setToast(null)}>×</button></div> : null}
      <Gate>
        {capabilities?.access === 'full' && <button type="button" onClick={() => setShowCompact(false)}>Open full app</button>}
        {capabilities?.access === 'limited' && <p className="statusbar">Limited access. Enable full access for this device in desktop Settings → Bridges.</p>}
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
