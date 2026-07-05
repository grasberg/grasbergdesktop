/**
 * Compact card for one tool invocation inside an assistant message: tool id,
 * status chip, and collapsible arguments/result. Purely presentational —
 * approval itself happens in ToolApprovalDialog.
 */

import { memo, useMemo, type ReactElement } from 'react'
import type { ToolCallRecord } from '@shared/types'
import { prettyJson } from '@/lib/format'
import './toolcall.css'

const STATUS_LABEL: Record<ToolCallRecord['status'], string> = {
  proposed: 'awaiting approval',
  approved: 'running',
  denied: 'denied',
  done: 'done',
  error: 'error',
}

function ToolIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M9.8 2.2a3.6 3.6 0 0 0-4.5 4.5L2 10l-.4 2.9a1 1 0 0 0 1.5 1.5L6 12l3.3-3.3a3.6 3.6 0 0 0 4.5-4.5L11.5 6.5 9.5 4.5 11.8 2.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ToolCallCard({ toolCall }: { toolCall: ToolCallRecord }): ReactElement {
  const hasArgs = toolCall.arguments.trim().length > 0 && toolCall.arguments.trim() !== '{}'
  // The chat store replaces ToolCallRecords immutably, so this only recomputes
  // when the arguments actually change (not per streaming text delta).
  const args = useMemo(() => prettyJson(toolCall.arguments), [toolCall.arguments])
  return (
    <div className="tool-call-card" data-status={toolCall.status}>
      <div className="tool-call-head">
        <span className="tool-call-icon" aria-hidden>
          <ToolIcon />
        </span>
        <span className="tool-call-name mono" title={toolCall.name}>
          {toolCall.name}
        </span>
        <span className={`tool-call-chip tool-call-chip-${toolCall.status}`}>
          {STATUS_LABEL[toolCall.status]}
        </span>
      </div>
      {hasArgs ? (
        <details className="tool-call-details">
          <summary className="tool-call-summary">Arguments</summary>
          <pre className="tool-call-pre tool-call-args mono">{args}</pre>
        </details>
      ) : null}
      {toolCall.result ? (
        <details className="tool-call-details">
          <summary className="tool-call-summary">Result</summary>
          <pre className="tool-call-pre tool-call-result">{toolCall.result}</pre>
        </details>
      ) : null}
    </div>
  )
}

export default memo(ToolCallCard)
