import { useEffect, useRef, useState, type ReactElement } from 'react'
import Markdown from '@/components/chat/Markdown'
import { useCodeStore } from '@/stores/code'
import './code.css'

function isMarkdownPath(relPath: string): boolean {
  return /\.(md|markdown)$/i.test(relPath)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Read-only preview modal for the file selected in the tree. Markdown files
 * render through the shared Markdown component; everything else is shown as
 * monospace text with CSS-counter line numbers. Esc closes.
 */
export default function FilePreview(): ReactElement | null {
  const openFile = useCodeStore((s) => s.openFile)
  const closePreview = useCodeStore((s) => s.closePreview)

  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  useEffect(() => {
    if (!openFile) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') closePreview()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [openFile, closePreview])

  if (!openFile) return null

  const copy = (): void => {
    void navigator.clipboard.writeText(openFile.content).then(() => {
      setCopied(true)
      window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500)
    })
  }

  const lines = openFile.content.split('\n')

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closePreview()
      }}
    >
      <div
        className="modal code-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Preview of ${openFile.relPath}`}
      >
        <header className="code-preview-header">
          <span className="code-preview-path" title={openFile.relPath}>
            {openFile.relPath}
          </span>
          <span className="badge">{formatBytes(openFile.sizeBytes)}</span>
          <div className="code-preview-actions">
            <button type="button" className="btn" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              className="btn-icon"
              aria-label="Close preview"
              onClick={closePreview}
            >
              ×
            </button>
          </div>
        </header>

        {openFile.truncated && (
          <div className="code-preview-truncated" role="status">
            This file is large — only the beginning is shown (and sent as context).
          </div>
        )}

        <div className="code-preview-body">
          {isMarkdownPath(openFile.relPath) ? (
            <Markdown content={openFile.content} />
          ) : (
            <pre className="code-preview-pre">
              {lines.map((line, i) => (
                <span key={i} className="code-preview-line">
                  {line.length > 0 ? line : ' '}
                  {'\n'}
                </span>
              ))}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
