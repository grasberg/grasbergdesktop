/**
 * One-click entry points: a new task in any mode, or a new workflow.
 */

import type { ConversationMode } from '@shared/types'
import { newConversation } from '@/lib/new-conversation'
import { useUiStore } from '@/stores/ui'

const ACTIONS: ReadonlyArray<{ mode: ConversationMode; label: string }> = [
  { mode: 'chat', label: 'New chat' },
  { mode: 'work', label: 'New work task' },
]

export default function QuickActionsCard(): React.JSX.Element {
  return (
    <section className="card home-card" aria-label="Quick actions">
      <div className="home-card-head">
        <h2 className="home-card-title">Start something</h2>
      </div>
      <div className="home-actions">
        {ACTIONS.map((a) => (
          <button
            type="button"
            key={a.mode}
            className="btn"
            onClick={() => newConversation(a.mode)}
          >
            {a.label}
          </button>
        ))}
        <button
          type="button"
          className="btn"
          onClick={() => useUiStore.getState().openWorkflows(true)}
        >
          New workflow
        </button>
      </div>
    </section>
  )
}
