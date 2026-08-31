import { useEffect, useState, type ReactElement } from 'react'
import type { ConversationCostSummary } from '@shared/types'
import { PRICING_DISCLAIMER, formatCost } from '@shared/pricing'
import { useChatStore } from '@/stores/chat'

/**
 * Header HUD (v44): this conversation's month-to-date estimated cost —
 * messages plus its headless (arena) runs. Refetched when a stream ends.
 */
export default function CostBadge({
  conversationId,
}: {
  conversationId: string
}): ReactElement | null {
  const streaming = useChatStore((s) => s.streaming)
  const [summary, setSummary] = useState<ConversationCostSummary | null>(null)

  useEffect(() => {
    setSummary(null)
  }, [conversationId])

  useEffect(() => {
    if (streaming) return
    let stale = false
    void window.uld.usage.conversationCost(conversationId).then((res) => {
      if (!stale && res.ok) setSummary(res.data)
    })
    return () => {
      stale = true
    }
  }, [conversationId, streaming])

  // Nothing to say about a conversation with no spend and no cap.
  if (!summary || (summary.estimatedCostUsd <= 0 && summary.budgetUsd === null)) return null

  const over = summary.budgetUsd !== null && summary.estimatedCostUsd >= summary.budgetUsd
  return (
    <span
      className={`badge chat-cost-badge${over ? ' over' : ''}`}
      title={`${PRICING_DISCLAIMER} Unpriced models excluded.`}
    >
      ≈ {formatCost(summary.estimatedCostUsd)} this month
      {summary.budgetUsd !== null ? ` / ${formatCost(summary.budgetUsd)} cap` : ''}
    </span>
  )
}
