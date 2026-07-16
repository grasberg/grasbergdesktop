/**
 * The agent inbox: one Home card reviewing every background result — finished
 * background agent runs, workflow runs and scheduled-task runs — newest
 * first. Rows open their source (conversation or workflow) and are dismissed
 * with an explicit "Reviewed" click, which persists in inbox_state.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { InboxItem } from '@shared/types'
import { relativeTime } from '@/lib/format'
import { toNormalized, unwrap } from '@/api/uld'
import { toastError } from '@/stores/ui'
import { useUiStore } from '@/stores/ui'
import { useConversationsStore } from '@/stores/conversations'

const SHOWN = 8

export default function InboxCard(): ReactElement | null {
  const [items, setItems] = useState<InboxItem[] | null>(null)
  const [showReviewed, setShowReviewed] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    try {
      setItems(await unwrap(window.uld.inbox.list()))
    } catch (e) {
      // The inbox is a convenience surface; a load failure should not toast
      // repeatedly on every Home visit. Show the empty state instead.
      console.warn('inbox load failed:', toNormalized(e).message)
      setItems([])
    }
  }, [])

  useEffect(() => {
    void reload()
    // Background results land while Home is open: refresh on the pushes the
    // sources already emit instead of polling.
    const offWorkflow = window.uld.workflows.onRunFinished(() => void reload())
    const offTasks = window.uld.scheduledTasks.onChanged(() => void reload())
    return () => {
      offWorkflow()
      offTasks()
    }
  }, [reload])

  const markReviewed = async (item: InboxItem): Promise<void> => {
    try {
      await unwrap(window.uld.inbox.markReviewed(item.itemType, item.itemId))
      setItems(
        (prev) =>
          prev?.map((i) =>
            i.itemType === item.itemType && i.itemId === item.itemId
              ? { ...i, reviewedAt: Date.now() }
              : i
          ) ?? null
      )
    } catch (e) {
      toastError('Could not mark as reviewed', e)
    }
  }

  const open = (item: InboxItem): void => {
    if (item.conversationId) {
      useConversationsStore.getState().select(item.conversationId)
    } else if (item.workflowId) {
      useUiStore.getState().openWorkflows(true, item.workflowId)
    }
  }

  const unreviewed = items?.filter((i) => i.reviewedAt === null) ?? []
  const shown = showReviewed ? (items ?? []) : unreviewed
  if (items !== null && items.length === 0) return null

  return (
    <section className="card home-card" aria-label="Inbox">
      <div className="home-card-head">
        <h2 className="home-card-title">
          Inbox
          {unreviewed.length > 0 ? (
            <span className="inbox-count" aria-label={`${unreviewed.length} unreviewed`}>
              {unreviewed.length}
            </span>
          ) : null}
        </h2>
        <button
          type="button"
          className="btn btn-ghost home-card-action"
          onClick={() => setShowReviewed((v) => !v)}
        >
          {showReviewed ? 'Hide reviewed' : 'Show reviewed'}
        </button>
      </div>
      {items === null ? (
        <div aria-hidden="true">
          <div className="home-skeleton" />
          <div className="home-skeleton" />
        </div>
      ) : shown.length === 0 ? (
        <div className="home-empty">
          <p>All caught up — background results land here for review.</p>
        </div>
      ) : (
        <ul className="home-list">
          {shown.slice(0, SHOWN).map((item) => (
            <li key={`${item.itemType}:${item.itemId}`} className="inbox-row">
              <button
                type="button"
                className="home-row-btn"
                title={item.snippet || item.title}
                onClick={() => open(item)}
              >
                <span
                  className={`run-dot ${item.status === 'ok' ? 'ok' : 'error'}`}
                  aria-hidden="true"
                />
                <span className="home-row-main">
                  <span className="home-row-title">{item.sourceLabel}</span>
                  <span className="home-row-meta">{item.snippet || item.title}</span>
                </span>
                <span className="badge">
                  {item.itemType === 'agent_run'
                    ? 'agent'
                    : item.itemType === 'workflow_run'
                      ? 'workflow'
                      : 'scheduled'}
                </span>
                <span className="home-row-time">{relativeTime(item.finishedAt)}</span>
              </button>
              {item.reviewedAt === null ? (
                <button
                  type="button"
                  className="btn btn-ghost inbox-review-btn"
                  title="Mark as reviewed"
                  onClick={() => void markReviewed(item)}
                >
                  ✓
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
