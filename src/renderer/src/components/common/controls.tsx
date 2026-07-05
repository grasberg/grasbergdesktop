/**
 * Small shared UI controls used across settings tabs, onboarding and other
 * surfaces. Purely presentational — no store access.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { TestConnectionResult } from '@shared/types'

/** Button that swaps to an inline confirm/cancel pair before running the action. */
export function ConfirmButton(props: {
  label: ReactNode
  prompt?: string
  confirmLabel?: string
  className?: string
  disabled?: boolean
  onConfirm: () => void | Promise<void>
}) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!armed) {
    return (
      <button
        type="button"
        className={props.className ?? 'btn btn-danger'}
        disabled={props.disabled}
        onClick={() => setArmed(true)}
      >
        {props.label}
      </button>
    )
  }
  return (
    <span className="confirm-inline" role="group" aria-label="Confirm action">
      {props.prompt ? <span className="confirm-prompt">{props.prompt}</span> : null}
      <button
        type="button"
        className="btn btn-danger"
        autoFocus
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await props.onConfirm()
          } finally {
            setBusy(false)
            setArmed(false)
          }
        }}
      >
        {props.confirmLabel ?? 'Confirm'}
      </button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  )
}

/** Accessible toggle switch (checkbox under the hood). */
export function Switch(props: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <label className="switch" title={props.label}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        aria-label={props.label}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
    </label>
  )
}

/** Inline outcome of a provider connection test (spinner / summary / error). */
export function TestResult(props: { testing: boolean; result: TestConnectionResult | null }) {
  if (props.testing) {
    return (
      <span className="test-result" role="status">
        <span className="spinner" aria-hidden="true" /> Testing…
      </span>
    )
  }
  if (!props.result) return null
  if (props.result.ok) {
    const parts = ['Connected']
    if (props.result.latencyMs != null) parts.push(`${props.result.latencyMs}ms`)
    if (props.result.modelCount != null) parts.push(`${props.result.modelCount} models`)
    return (
      <span className="test-result ok" role="status">
        {parts.join(' · ')}
      </span>
    )
  }
  return (
    <span className="test-result err" role="status">
      {props.result.message}
    </span>
  )
}
