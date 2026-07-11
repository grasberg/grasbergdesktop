/**
 * The latest conversations across EVERY mode — the cross-mode view the
 * mode-scoped sidebar can't show. Clicking a row switches the sidebar to that
 * mode and opens the task.
 */

import type { ConversationMode, ConversationSummary } from '@shared/types'
import { relativeTime } from '@/lib/format'
import { newConversation } from '@/lib/new-conversation'
import { useConversationsStore } from '@/stores/conversations'

const MODE_LABELS: Record<ConversationMode, string> = {
  chat: 'Chat',
  work: 'Work',
}

export default function RecentWorkCard({
  items,
  projectNameById,
}: {
  /** null while loading. */
  items: ConversationSummary[] | null
  projectNameById: Map<string, string>
}): React.JSX.Element {
  const open = (item: ConversationSummary): void => {
    const convs = useConversationsStore.getState()
    convs.setModeFilter(item.mode)
    convs.select(item.id)
  }

  return (
    <section className="card home-card" aria-label="Recent work">
      <div className="home-card-head">
        <h2 className="home-card-title">Recent work</h2>
      </div>
      {items === null ? (
        <div aria-hidden="true">
          <div className="home-skeleton" />
          <div className="home-skeleton" />
        </div>
      ) : items.length === 0 ? (
        <div className="home-empty">
          <p>No conversations yet.</p>
          <button type="button" className="btn btn-primary" onClick={() => newConversation('chat')}>
            Start a new chat
          </button>
        </div>
      ) : (
        <ul className="home-list">
          {items.map((item) => {
            const project = item.projectRef ? projectNameById.get(item.projectRef) : undefined
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className="home-row-btn"
                  title={`Open "${item.title}"`}
                  onClick={() => open(item)}
                >
                  <span className="badge">{MODE_LABELS[item.mode]}</span>
                  <span className="home-row-main">
                    <span className="home-row-title">{item.title}</span>
                    {project ? <span className="home-row-meta">{project}</span> : null}
                  </span>
                  <span className="home-row-time">{relativeTime(item.updatedAt)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
