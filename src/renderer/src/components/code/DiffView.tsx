import { memo, type ReactElement } from 'react'
import './code.css'

interface DiffViewProps {
  diff: string
}

type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx'

/** Classifies one unified-diff line. Order matters: file headers before +/-. */
function classify(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('\\')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

/** Renders a unified diff string with per-line add/remove/hunk coloring. */
function DiffView({ diff }: DiffViewProps): ReactElement {
  const lines = diff.replace(/\n$/, '').split('\n')
  return (
    <div className="diff-view">
      <pre className="diff-pre" aria-label="Unified diff">
        {lines.map((line, i) => (
          <span key={i} className={`diff-line diff-line-${classify(line)}`}>
            {line.length > 0 ? line : ' '}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  )
}

export default memo(DiffView)
