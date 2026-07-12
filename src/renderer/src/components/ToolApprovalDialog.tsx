/**
 * Modal shown while a tool invocation awaits user approval. Nothing runs
 * until the user explicitly clicks Allow — Deny is the focused default and
 * Escape denies. While Settings is open (e.g. via "Tool settings…"), the
 * dialog hides but the approval stays pending and reappears on close.
 */

import { useEffect, useRef, type ReactElement } from 'react'
import type { ToolRiskLevel } from '@shared/types'
import { prettyJson } from '@/lib/format'
import { effectivePermission, useToolsStore } from '@/stores/tools'
import { useUiStore } from '@/stores/ui'

const RISK_LABEL: Record<ToolRiskLevel, string> = {
  safe: 'safe',
  sensitive: 'sensitive',
  dangerous: 'dangerous',
}

export function RiskBadge({ risk }: { risk: ToolRiskLevel }): ReactElement {
  return <span className={`badge tool-risk tool-risk-${risk}`}>{RISK_LABEL[risk]}</span>
}

export default function ToolApprovalDialog(): ReactElement | null {
  const pending = useToolsStore((s) => s.approvalQueue[0] ?? null)
  const tools = useToolsStore((s) => s.tools)
  const permissions = useToolsStore((s) => s.permissions)
  const loaded = useToolsStore((s) => s.loaded)
  const settingsOpen = useUiStore((s) => s.settingsOpen)

  const visible = pending !== null && !settingsOpen
  const denyRef = useRef<HTMLButtonElement>(null)

  // Have definitions at hand for description/permission display.
  useEffect(() => {
    if (pending && !loaded) void useToolsStore.getState().load()
  }, [pending, loaded])

  // Focus the safe default when the dialog appears.
  useEffect(() => {
    if (visible) denyRef.current?.focus()
  }, [visible])

  // Esc = Deny. Capture phase so the global shortcut handler (which would
  // otherwise stop the in-flight generation) never sees the event.
  // Every response names the request this dialog rendered — main may settle the
  // head request underneath us, and the answer must not land on the next one.
  const requestId = pending?.requestId ?? null
  useEffect(() => {
    if (!visible || !requestId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        void useToolsStore.getState().respond(requestId, false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible, requestId])

  if (!pending || !visible) return null

  const tool =
    tools.find((t) => t.id === pending.toolCall.name) ??
    tools.find((t) => t.name === pending.toolCall.name) ??
    null

  return (
    <div className="modal-backdrop tool-approval-backdrop">
      <div
        className="modal tool-approval-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tool-approval-title"
      >
        <header className="tool-approval-head">
          <h2 id="tool-approval-title" className="tool-approval-title">
            <span className="mono">{pending.toolCall.name}</span>
          </h2>
          <RiskBadge risk={pending.risk} />
        </header>

        {tool?.description ? <p className="tool-approval-desc">{tool.description}</p> : null}

        {pending.note ? <p className="tool-approval-note">{pending.note}</p> : null}

        <p className="tool-approval-copy">
          The assistant wants to run this tool. Nothing runs without your approval.
        </p>

        <div className="tool-approval-args-wrap">
          <span className="tool-approval-args-label">Arguments</span>
          <pre className="tool-approval-args mono" tabIndex={0}>
            {prettyJson(pending.toolCall.arguments)}
          </pre>
        </div>

        <div className="tool-approval-actions">
          <button
            type="button"
            className="btn-link tool-approval-settings"
            onClick={() => useUiStore.getState().openSettings(true)}
          >
            Tool settings…
          </button>
          <span className="tool-approval-spacer" />
          <button
            type="button"
            ref={denyRef}
            className="btn"
            onClick={() => void useToolsStore.getState().respond(pending.requestId, false)}
          >
            Deny
          </button>
          {tool?.noStandingApproval !== true && (
            <button
              type="button"
              className="btn"
              title="Also auto-approve future calls of this tool in this conversation (until the app restarts)"
              onClick={() =>
                void useToolsStore.getState().respond(pending.requestId, true, 'conversation')
              }
            >
              Allow for this conversation
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void useToolsStore.getState().respond(pending.requestId, true)}
          >
            Allow once
          </button>
        </div>

        {tool && effectivePermission(permissions, tool) === 'ask' ? (
          <p className="tool-approval-hint">
            This tool asks every time. Change that under Settings → Tools.
          </p>
        ) : null}
      </div>
    </div>
  )
}
