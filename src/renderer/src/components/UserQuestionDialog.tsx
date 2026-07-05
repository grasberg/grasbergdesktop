/**
 * Modal shown when the assistant asks a structured clarifying question
 * (ask_user_question). The user clicks a suggested answer, types a custom
 * one, or dismisses (Escape) — dismissal resolves the tool call with null so
 * generation always continues.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useToolsStore } from '@/stores/tools'

export default function UserQuestionDialog(): ReactElement | null {
  const pending = useToolsStore((s) => s.questionQueue[0] ?? null)
  const [custom, setCustom] = useState('')
  const firstOptionRef = useRef<HTMLButtonElement>(null)

  // Reset the custom answer whenever a new question appears.
  useEffect(() => {
    setCustom('')
    if (pending) firstOptionRef.current?.focus()
  }, [pending?.requestId])

  // Esc = dismiss (answer null). Capture phase so the global Escape handler
  // (stop generation) never sees the event.
  useEffect(() => {
    if (!pending) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        void useToolsStore.getState().respondQuestion(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pending])

  if (!pending) return null

  const submitCustom = (): void => {
    const answer = custom.trim()
    if (answer.length === 0) return
    void useToolsStore.getState().respondQuestion(answer)
  }

  return (
    <div className="modal-backdrop tool-approval-backdrop">
      <div
        className="modal user-question-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-question-title"
      >
        <header className="tool-approval-head">
          <h2 id="user-question-title" className="tool-approval-title">
            The assistant has a question
          </h2>
        </header>

        <p className="user-question-text">{pending.question}</p>

        {pending.options.length > 0 ? (
          <div className="user-question-options">
            {pending.options.map((option, index) => (
              <button
                key={option}
                type="button"
                ref={index === 0 ? firstOptionRef : undefined}
                className="btn user-question-option"
                onClick={() => void useToolsStore.getState().respondQuestion(option)}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}

        <div className="user-question-custom">
          <input
            type="text"
            className="input"
            placeholder="Or type your own answer…"
            aria-label="Custom answer"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCustom()
            }}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={custom.trim().length === 0}
            onClick={submitCustom}
          >
            Answer
          </button>
        </div>

        <div className="tool-approval-actions">
          <span className="tool-approval-spacer" />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void useToolsStore.getState().respondQuestion(null)}
          >
            Skip question
          </button>
        </div>
      </div>
    </div>
  )
}
