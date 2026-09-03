/**
 * Deliveries (v48): the bot's durable bot-to-bot outbox, both directions,
 * live off push:botsChanged. Rendered inside the shared agent editor.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { A2aOutboxEntry, A2aOutboxStatus, AgentProfile } from '@shared/types'
import { relativeTime } from '@/lib/format'
import { useBotsStore } from '@/stores/bots'
import '@/components/agents/agent-form.css'

const DELIVERY_STATUS_LABEL: Record<A2aOutboxStatus, string> = {
  queued: 'Queued',
  delivered: 'Delivered · replying…',
  replied: 'Replied',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export default function DeliveriesCard({ agent }: { agent: AgentProfile }): ReactElement | null {
  const [entries, setEntries] = useState<A2aOutboxEntry[]>([])
  const roster = useBotsStore((s) => s.roster)
  const nameOf = useMemo(() => {
    const byId = new Map((roster?.bots ?? []).map((row) => [row.agent.id, row.agent.name]))
    return (id: string | null): string => (id ? (byId.get(id) ?? 'unknown bot') : 'event')
  }, [roster])

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.uld.bots.outbox(agent.id).then((res) => {
        if (alive && res.ok) setEntries(res.data)
      })
    }
    load()
    const unsubscribe = window.uld.bots.onChanged(() => load())
    return () => {
      alive = false
      unsubscribe()
    }
  }, [agent.id])

  if (entries.length === 0) return null
  return (
    <div className="bot-deliveries">
      <h4>Deliveries</h4>
      <ul className="bot-delivery-list">
        {entries.slice(0, 8).map((entry) => {
          const outbound = entry.fromAgentId === agent.id
          const other = outbound ? nameOf(entry.toAgentId) : nameOf(entry.fromAgentId)
          return (
            <li key={entry.id} className={`bot-delivery status-${entry.status}`}>
              <span className="bot-delivery-dir">{outbound ? `→ ${other}` : `← ${other}`}</span>
              <span className="bot-delivery-body" title={entry.body}>
                {entry.body.replace(/\s+/g, ' ').slice(0, 80)}
              </span>
              <span className="bot-delivery-status">{DELIVERY_STATUS_LABEL[entry.status]}</span>
              <time>{relativeTime(entry.updatedAt)}</time>
            </li>
          )
        })}
      </ul>
      <p className="bot-delivery-hint">
        Deliveries persist across restarts: anything still queued is delivered at the next
        launch, an interrupted reply is retried once.
      </p>
    </div>
  )
}
