/**
 * Hands-free voice call with the open conversation (v53, dots "call your
 * dot", Muse voice): a phone button next to the mic. While a call is live a
 * small bar shows what is happening — listening, hearing you, thinking,
 * speaking — and hangs up on click or Esc. Local whisper does the
 * transcription; the system voice reads replies.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { VoiceCall, type VoiceCallState } from '@/lib/voice-call'
import { MicDeniedError } from '@/lib/recorder'
import { useChatStore } from '@/stores/chat'
import { useVoiceStore } from '@/stores/voice'
import { useUiStore } from '@/stores/ui'

const STATE_LABEL: Record<VoiceCallState, string> = {
  starting: 'Starting…',
  listening: 'Listening — just talk',
  hearing: 'Hearing you…',
  thinking: 'Thinking…',
  speaking: 'Speaking — talk to interrupt',
  ended: 'Call ended',
}

export default function VoiceCallButton({ disabled }: { disabled: boolean }): ReactElement {
  const [state, setState] = useState<VoiceCallState | null>(null)
  const call = useRef<VoiceCall | null>(null)

  const hangUp = (): void => {
    void call.current?.end()
    call.current = null
    setState(null)
  }

  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hangUp()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state])

  // Leaving the conversation ends the call.
  const conversationId = useChatStore((s) => s.conversation?.id ?? null)
  useEffect(() => () => hangUp(), [conversationId])

  const start = async (): Promise<void> => {
    useVoiceStore.getState().stopSpeaking()
    const next = new VoiceCall({
      transcribe: (wav) => useVoiceStore.getState().sendRecording(wav),
      send: (text) => useChatStore.getState().send(text),
      messages: () => useChatStore.getState().messages,
      subscribe: (listener) => useChatStore.subscribe(listener),
      onState: (value, detail) => {
        if (value === 'ended') setState(null)
        else setState(value)
        if (detail) useUiStore.getState().toast(detail, 'error')
      },
    })
    call.current = next
    setState('starting')
    try {
      await next.start()
    } catch (error) {
      call.current = null
      setState(null)
      useUiStore
        .getState()
        .toast(
          error instanceof MicDeniedError
            ? 'Microphone access was denied — allow it in your OS privacy settings.'
            : `Could not start the call: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
    }
  }

  return (
    <>
      <button
        type="button"
        className={`btn-icon composer-call${state ? ' active' : ''}`}
        aria-label={state ? 'Hang up' : 'Start a voice call'}
        title={state ? 'Hang up (Esc)' : 'Voice call — talk hands-free, replies are read aloud'}
        disabled={disabled && !state}
        onClick={() => (state ? hangUp() : void start())}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />
        </svg>
      </button>
      {state ? (
        <div className={`voice-call-bar state-${state}`} role="status" aria-live="polite">
          <span className="voice-call-dot" aria-hidden />
          <span>{STATE_LABEL[state]}</span>
          <button type="button" className="btn btn-danger" onClick={hangUp}>
            Hang up
          </button>
        </div>
      ) : null}
    </>
  )
}
