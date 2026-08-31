import { useEffect, useRef, useState } from 'react'
import type {
  AppSettings,
  NormalizedError,
  QuickAction,
  QuickContext,
  QuickStreamEventEnvelope,
} from '@shared/types'
import { toNormalized, unwrap } from '@/api/uld'
import Markdown from '@/components/chat/Markdown'
import './quick.css'

type QuickPhase = 'idle' | 'streaming' | 'done' | 'error'

interface QuickRunState {
  streamId: string
  prompt: string
  providerId: string
  modelId: string
  label: string
}

/**
 * The quick-assistant window's whole surface (loaded via ?view=quick). Talks
 * to window.uld directly — none of the main app's stores are mounted here.
 */
export default function QuickApp(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [context, setContext] = useState<QuickContext>({ selectionText: '', truncated: false })
  const [phase, setPhase] = useState<QuickPhase>('idle')
  const [answer, setAnswer] = useState('')
  const [stopped, setStopped] = useState(false)
  const [error, setError] = useState<NormalizedError | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  // The active run, readable from the push subscription without re-subscribing.
  const runRef = useRef<QuickRunState | null>(null)
  // Envelopes that arrive before the quick:run reply sets runRef: the push and
  // the invoke reply travel on different IPC paths with no ordering guarantee,
  // so a near-synchronous terminal 'error'/'done' can beat the reply and would
  // otherwise be dropped forever (the window stuck on "Thinking…").
  const pendingEnvelopesRef = useRef<QuickStreamEventEnvelope[]>([])

  const applyEnvelope = (envelope: QuickStreamEventEnvelope): void => {
    const event = envelope.event
    if (event.type === 'text-delta') {
      setAnswer((prev) => prev + event.text)
    } else if (event.type === 'done') {
      if (event.text) setAnswer(event.text)
      setStopped(event.finishReason === 'aborted')
      setPhase('done')
    } else if (event.type === 'error') {
      setError(event.error)
      setPhase('error')
    }
  }
  const applyEnvelopeRef = useRef(applyEnvelope)
  applyEnvelopeRef.current = applyEnvelope

  useEffect(() => {
    void unwrap(window.uld.settings.get())
      .then(setSettings)
      .catch(() => undefined)
    // Pull the capture on mount — a push at load time could beat this effect.
    void unwrap(window.uld.quick.getContext())
      .then(setContext)
      .catch(() => undefined)
    const unsubscribeContext = window.uld.quick.onContext((ctx) => {
      // Re-summon: fresh clipboard capture, reset the previous exchange.
      runRef.current = null
      pendingEnvelopesRef.current = []
      setContext(ctx)
      setPhase('idle')
      setAnswer('')
      setStopped(false)
      setError(null)
      setHint(null)
      // The actions may have been edited in Settings since the last summon.
      void unwrap(window.uld.settings.get())
        .then(setSettings)
        .catch(() => undefined)
    })
    const unsubscribeStream = window.uld.quick.onStreamEvent((envelope) => {
      const current = runRef.current
      if (!current) {
        // Buffer until the quick:run reply lands; runAction replays these.
        pendingEnvelopesRef.current.push(envelope)
        return
      }
      if (envelope.streamId !== current.streamId) return
      applyEnvelopeRef.current(envelope)
    })
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void window.uld.quick.hide()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      unsubscribeContext()
      unsubscribeStream()
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])

  // Follow the app theme (the quick window renders the same theme tokens).
  const theme = settings?.theme ?? 'system'
  useEffect(() => {
    const apply = (resolved: 'light' | 'dark'): void => {
      document.documentElement.dataset.theme = resolved
    }
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const onChange = (): void => apply(mq.matches ? 'dark' : 'light')
      onChange()
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
    apply(theme)
    return undefined
  }, [theme])

  const runAction = async (action: QuickAction): Promise<void> => {
    if (!context.selectionText) {
      setHint('Copy some text first, then press the shortcut again.')
      return
    }
    setHint(null)
    setAnswer('')
    setStopped(false)
    setError(null)
    setPhase('streaming')
    pendingEnvelopesRef.current = []
    try {
      const res = await unwrap(
        window.uld.quick.run({ actionId: action.id, selection: context.selectionText })
      )
      runRef.current = { ...res, label: action.label }
      // Replay anything this run pushed before its invoke reply arrived.
      const buffered = pendingEnvelopesRef.current
      pendingEnvelopesRef.current = []
      for (const envelope of buffered) {
        if (envelope.streamId === res.streamId) applyEnvelope(envelope)
      }
    } catch (e) {
      runRef.current = null
      pendingEnvelopesRef.current = []
      setError(toNormalized(e))
      setPhase('error')
    }
  }

  const stop = (): void => {
    const current = runRef.current
    if (current) void window.uld.chat.stop(current.streamId)
  }

  const promote = async (): Promise<void> => {
    const current = runRef.current
    if (!current || !answer) return
    // Collapse whitespace like promoteQuick's fallback title does — multi-line
    // clipboard text must not put literal newlines into a conversation title.
    const preview = context.selectionText.replace(/\s+/g, ' ').trim().slice(0, 40)
    const title = `${current.label}: ${preview}`.trim().slice(0, 60)
    try {
      await unwrap(
        window.uld.quick.promote({
          userText: current.prompt,
          answer,
          providerId: current.providerId,
          modelId: current.modelId,
          title,
        })
      )
    } catch (e) {
      setError(toNormalized(e))
      setPhase('error')
    }
  }

  const actions = settings?.quickActions ?? []
  const hasSelection = context.selectionText.length > 0

  return (
    <div className="quick-app">
      <header className="quick-titlebar">
        <span className="quick-title">Quick assistant</span>
        {context.truncated ? <span className="quick-truncated">truncated</span> : null}
        <button
          type="button"
          className="btn-icon quick-close"
          aria-label="Close"
          onClick={() => void window.uld.quick.hide()}
        >
          ✕
        </button>
      </header>

      <div className="quick-selection" aria-label="Copied text">
        {hasSelection ? (
          context.selectionText
        ) : (
          <span className="quick-empty">
            Nothing on the clipboard. Copy some text, then press the shortcut again.
          </span>
        )}
      </div>

      <div className="quick-actions" role="toolbar" aria-label="Quick actions">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className="btn quick-action-btn"
            disabled={phase === 'streaming'}
            onClick={() => void runAction(action)}
          >
            {action.label}
          </button>
        ))}
      </div>
      {hint ? <div className="quick-hint">{hint}</div> : null}

      <div className="quick-answer" aria-live="polite">
        {phase === 'error' && error ? (
          <div className="quick-error">{error.message}</div>
        ) : answer ? (
          <>
            <Markdown content={answer} />
            {stopped ? <div className="quick-stopped">(stopped)</div> : null}
          </>
        ) : phase === 'streaming' ? (
          <div className="quick-waiting">Thinking…</div>
        ) : null}
      </div>

      <footer className="quick-footer">
        {phase === 'streaming' ? (
          <button type="button" className="btn" onClick={stop}>
            Stop
          </button>
        ) : null}
        {phase === 'done' && answer ? (
          <button type="button" className="btn btn-primary" onClick={() => void promote()}>
            Open as conversation
          </button>
        ) : null}
        <span className="quick-esc-hint">Esc closes</span>
      </footer>
    </div>
  )
}
