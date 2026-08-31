/**
 * The morning brief card: the newest stored brief, Markdown-rendered at the
 * top of Home until dismissed. Generation happens main-side (BriefService);
 * this card only lists, renders and dismisses.
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { MorningBrief } from '@shared/types'
import { relativeTime } from '@/lib/format'
import { toNormalized, unwrap } from '@/api/uld'
import { toastError } from '@/stores/ui'
import Markdown from '@/components/chat/Markdown'

export default function BriefCard(): ReactElement | null {
  const [briefs, setBriefs] = useState<MorningBrief[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await unwrap(window.uld.brief.list())
        if (!cancelled) setBriefs(list)
      } catch (e) {
        // A load failure should not toast on every Home visit — hide the card.
        console.warn('brief load failed:', toNormalized(e).message)
        if (!cancelled) setBriefs([])
      }
    })()
    const off = window.uld.brief.onChanged(({ brief }) => {
      setBriefs((prev) => {
        const rest = (prev ?? []).filter((b) => b.id !== brief.id)
        return [brief, ...rest].sort((a, b) => b.generatedAt - a.generatedAt)
      })
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const latest = briefs?.[0]
  if (!latest || latest.dismissedAt !== null) return null

  const dismiss = async (): Promise<void> => {
    try {
      await unwrap(window.uld.brief.dismiss(latest.id))
      setBriefs(
        (prev) =>
          prev?.map((b) => (b.id === latest.id ? { ...b, dismissedAt: Date.now() } : b)) ?? null
      )
    } catch (e) {
      toastError('Could not dismiss the brief', e)
    }
  }

  return (
    <section className="card home-card home-card-brief" aria-label="Morning brief">
      <div className="home-card-head">
        <h2 className="home-card-title">
          Morning brief
          {latest.catchUp ? <span className="badge">catch-up</span> : null}
        </h2>
        <span className="home-row-time">{relativeTime(latest.generatedAt)}</span>
        <button
          type="button"
          className="btn btn-ghost home-card-action"
          onClick={() => void dismiss()}
        >
          Dismiss
        </button>
      </div>
      {latest.status === 'error' ? (
        <div className="home-empty">
          <p>Brief generation failed: {latest.error}</p>
        </div>
      ) : (
        <Markdown content={latest.content} />
      )}
    </section>
  )
}
