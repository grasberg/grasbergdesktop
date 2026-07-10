import { useEffect, useState, type ReactElement } from 'react'
import type { Attachment } from '@shared/types'
import { formatBytes } from '@/lib/format'
import { useUiStore } from '@/stores/ui'
import './chat.css'

/**
 * An image the generate_image tool produced, rendered inside the assistant
 * message: lazy data-URL load (the readAttachment path AttachmentChip uses),
 * click-to-enlarge overlay, caption with the generating model, and Save as….
 * Degrades to a name-only chip when the stored file is gone.
 */
export default function GeneratedImage({ attachment }: { attachment: Attachment }): ReactElement {
  const toast = useUiStore((s) => s.toast)
  const [src, setSrc] = useState<string | null>(attachment.dataUrl ?? null)
  const [missing, setMissing] = useState(false)
  const [enlarged, setEnlarged] = useState(false)

  useEffect(() => {
    if (src || !attachment.storageKey) return
    let cancelled = false
    void window.uld.app.readAttachment(attachment.storageKey).then((res) => {
      if (cancelled) return
      if (res.ok && res.data) setSrc(res.data.dataUrl)
      else setMissing(true)
    })
    return () => {
      cancelled = true
    }
  }, [attachment.storageKey, src])

  const saveAs = async (): Promise<void> => {
    if (!attachment.storageKey) return
    const res = await window.uld.app.saveAttachmentAs(attachment.storageKey, attachment.name)
    if (!res.ok) toast(res.error.message, 'error')
    else if (!res.data.canceled && res.data.path) toast(`Saved to ${res.data.path}`, 'success')
  }

  if (missing || !attachment.storageKey) {
    return (
      <span className="msg-attachment-chip" title={attachment.name}>
        <span className="msg-attachment-name">{attachment.name}</span>
        <span className="msg-attachment-size">image unavailable</span>
      </span>
    )
  }

  const caption = [
    attachment.generatedBy?.modelId,
    attachment.generatedBy?.size,
    formatBytes(attachment.sizeBytes),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <figure className="msg-genimage">
      {src ? (
        <img
          className="msg-genimage-img"
          src={src}
          alt={attachment.name}
          onClick={() => setEnlarged(true)}
        />
      ) : (
        <div className="msg-genimage-loading" aria-label="Loading image" />
      )}
      <figcaption className="msg-genimage-caption">
        <span title={attachment.name}>{caption}</span>
        <button type="button" className="btn btn-ghost msg-genimage-save" onClick={() => void saveAs()}>
          Save as…
        </button>
      </figcaption>
      {enlarged && src && (
        <div
          className="msg-genimage-overlay"
          role="dialog"
          aria-label={attachment.name}
          onClick={() => setEnlarged(false)}
        >
          <img src={src} alt={attachment.name} />
        </div>
      )}
    </figure>
  )
}
