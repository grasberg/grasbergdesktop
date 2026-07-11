/**
 * Preview tab: renders .html files from the task's folder in a sandboxed
 * iframe (the exact ArtifactPanel/old-DesignView hardening: srcDoc + sandbox
 * without allow-same-origin → opaque origin, no window.uld, no top-nav; the
 * sandbox does not block outbound network — same documented posture).
 */

import { useEffect, useState, type ReactElement } from 'react'
import { unwrap } from '@/api/uld'

export default function PreviewTab({
  projectId,
  files,
  selected,
  onSelect,
  reloadKey,
}: {
  projectId: string
  /** Relative paths of every .html file in the tree. */
  files: string[]
  selected: string | null
  onSelect: (relPath: string) => void
  /** Bumped after a generation settles so an edited file re-renders. */
  reloadKey: number
}): ReactElement {
  const [content, setContent] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const active = selected && files.includes(selected) ? selected : (files[0] ?? null)

  useEffect(() => {
    if (!active) {
      setContent(null)
      return
    }
    let cancelled = false
    setError(null)
    void unwrap(window.uld.code.readFile({ projectId, relPath: active }))
      .then((file) => {
        if (cancelled) return
        setContent(file.content)
        setTruncated(file.truncated)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setContent(null)
        setError(e instanceof Error ? e.message : 'Could not read the file.')
      })
    return () => {
      cancelled = true
    }
  }, [projectId, active, reloadKey])

  if (!active) {
    return <div className="work-tab-empty">No .html files in this task yet.</div>
  }

  return (
    <div className="work-preview">
      <div className="work-preview-bar">
        <select
          className="select work-preview-select"
          aria-label="Prototype file"
          value={active}
          onChange={(e) => onSelect(e.target.value)}
        >
          {files.map((relPath) => (
            <option key={relPath} value={relPath}>
              {relPath}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <div className="work-tab-empty">{error}</div>
      ) : truncated ? (
        <div className="work-tab-empty">
          This file is too large to preview safely — open it from the Files tab instead.
        </div>
      ) : content !== null ? (
        <iframe
          className="work-preview-frame"
          title={`Preview of ${active}`}
          sandbox="allow-scripts"
          srcDoc={content}
        />
      ) : (
        <div className="work-tab-empty">Loading…</div>
      )}
    </div>
  )
}
