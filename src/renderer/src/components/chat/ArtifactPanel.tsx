/**
 * Sandboxed live preview for HTML/SVG code blocks in any mode ("Preview" button
 * on a fenced block). Same iframe hardening as Design mode: `sandbox` with
 * scripts only and content via srcDoc — the opaque origin blocks same-origin
 * state, window.uld/IPC, popups and top-navigation. Note the sandbox does NOT
 * block outbound network (fetch to https origins still works), matching the
 * existing Design-mode posture.
 */

import { useEffect, type ReactElement } from 'react'
import { useUiStore } from '@/stores/ui'
import './chat.css'

/** Bare <svg> markup needs a document shell to display sensibly. */
function toSrcDoc(title: string, html: string): string {
  if (title !== 'svg') return html
  return `<!doctype html><html><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#fff">${html}</body></html>`
}

export default function ArtifactPanel(): ReactElement | null {
  const preview = useUiStore((s) => s.artifactPreview)
  const openArtifactPreview = useUiStore((s) => s.openArtifactPreview)

  // Escape closes the drawer (capture phase, so Esc doesn't also stop a
  // running generation while the drawer has focus).
  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        openArtifactPreview(null)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [preview, openArtifactPreview])

  if (!preview) return null

  return (
    <aside className="artifact-drawer" role="dialog" aria-label="Artifact preview">
      <header className="artifact-drawer-head">
        <span className="artifact-drawer-title">Preview ({preview.title})</span>
        <button
          type="button"
          className="btn-icon"
          aria-label="Close preview"
          title="Close (Esc)"
          onClick={() => openArtifactPreview(null)}
        >
          ✕
        </button>
      </header>
      <iframe
        className="artifact-drawer-frame"
        title="Artifact preview"
        sandbox="allow-scripts"
        srcDoc={toSrcDoc(preview.title, preview.html)}
      />
    </aside>
  )
}
