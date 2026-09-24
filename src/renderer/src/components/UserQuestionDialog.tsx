/**
 * Modal shown when the assistant asks a structured clarifying question
 * (ask_user_question). The user clicks a suggested answer, types a custom
 * one, or dismisses (Escape) — dismissal resolves the tool call with null so
 * generation always continues.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useToolsStore } from '@/stores/tools'
import { useModalBehavior } from '@/hooks/useModalBehavior'

export default function UserQuestionDialog(): ReactElement | null {
  const pending = useToolsStore((s) => s.questionQueue[0] ?? null)
  const [custom, setCustom] = useState('')
  const firstOptionRef = useRef<HTMLButtonElement>(null)
  const responding = useToolsStore(s => !!(pending && s.responding[pending.requestId]))
  const modalRef = useModalBehavior(!!pending, () => { if (pending) void useToolsStore.getState().respondQuestion(pending.requestId, null) })

  // Reset the custom answer whenever a new question appears.
  useEffect(() => {
    setCustom('')
    if (pending) firstOptionRef.current?.focus()
  }, [pending?.requestId])

  // Esc = dismiss (answer null). Capture phase so the global Escape handler
  // (stop generation) never sees the event.
  // Every response names the question this dialog rendered — main may settle the
  // head request underneath us, and the answer must not land on the next one.
  if (!pending) return null

  const submitCustom = (): void => {
    const answer = custom.trim()
    if (answer.length === 0) return
    void useToolsStore.getState().respondQuestion(pending.requestId, answer)
  }

  return (
    <div className="modal-backdrop tool-approval-backdrop">
      <div
        className="modal user-question-modal"
        ref={modalRef}
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
                disabled={responding}
                onClick={() =>
                  void useToolsStore.getState().respondQuestion(pending.requestId, option)
                }
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
            disabled={responding || custom.trim().length === 0}
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
            disabled={responding}
            onClick={() => void useToolsStore.getState().respondQuestion(pending.requestId, null)}
          >
            Skip question
          </button>
        </div>
      </div>
    </div>
  )
}
