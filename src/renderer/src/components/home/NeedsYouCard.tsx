/**
 * "Needs you" (v53): every open suggestion from proactive work and every step
 * an agent handed back — across all bots and ordinary conversations — on
 * Home, so nothing waits unseen. Live off the suggestion pushes.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { BotSuggestion } from '@shared/types'
import { SuggestionList } from '@/components/agents/PersonalAgentPanel'
import { useBotsStore } from '@/stores/bots'
import '@/components/agents/personal-agent.css'

export default function NeedsYouCard(): ReactElement | null {
  const [items, setItems] = useState<BotSuggestion[]>([])
  const roster = useBotsStore((s) => s.roster)
  const nameOf = useMemo(() => {
    const byId = new Map((roster?.bots ?? []).map((row) => [row.agent.id, row.agent.name]))
    return (agentId: string | null): string | null => (agentId ? (byId.get(agentId) ?? 'A bot') : 'Assistant')
  }, [roster])

  const load = useCallback((): void => {
    void window.uld.bots.suggestions(null).then((res) => {
      if (res.ok) setItems(res.data)
    })
  }, [])

  useEffect(() => {
    load()
    if (!roster) void useBotsStore.getState().load()
    const offA = window.uld.bots.onSuggestionsChanged(() => load())
    const offB = window.uld.bots.onChanged(() => load())
    return () => {
      offA()
      offB()
    }
  }, [load, roster])

  if (items.length === 0) return null
  return (
    <section className="card home-card pa-home" aria-label="Needs you">
      <div className="home-card-head">
        <h2 className="home-card-title">Needs you · {items.length}</h2>
      </div>
      <SuggestionList items={items.slice(0, 8)} onChanged={load} showAgent={nameOf} />
    </section>
  )
}
