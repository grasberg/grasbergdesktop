import { toNormalized } from '@/api/uld'
import { useConversationsStore } from '@/stores/conversations'
import { useUiStore } from '@/stores/ui'

export default function EmptyState(): React.JSX.Element {
  const newChat = (): void => {
    useConversationsStore
      .getState()
      .create('chat')
      .catch((e: unknown) => {
        useUiStore.getState().toast(`Could not create chat: ${toNormalized(e).message}`, 'error')
      })
  }

  const mod = navigator.platform.toLowerCase().includes('mac') ? 'Cmd' : 'Ctrl'

  return (
    <div className="empty-state">
      <svg width="56" height="56" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="1" y="1" width="22" height="22" rx="6" fill="var(--accent)" />
        <path
          d="M8 8 L16 8 M8 8 L8 16 M16 8 L8 16 M8 16 L16 16 M16 8 L16 16"
          stroke="var(--accent-text)"
          strokeWidth="1.1"
          opacity="0.5"
        />
        <circle cx="8" cy="8" r="2.1" fill="var(--accent-text)" />
        <circle cx="16" cy="8" r="2.1" fill="var(--accent-text)" opacity="0.8" />
        <circle cx="8" cy="16" r="2.1" fill="var(--accent-text)" opacity="0.8" />
        <circle cx="16" cy="16" r="2.1" fill="var(--accent-text)" opacity="0.6" />
      </svg>
      <h1 className="empty-title">Grasberg Desktop</h1>
      <p className="empty-subtitle">
        One local-first home for DeepSeek, GLM, MiniMax and any OpenAI-compatible model.
      </p>
      <button type="button" className="btn btn-primary" onClick={newChat}>
        Start a new chat
      </button>
      <p className="empty-hint">
        Tip: press <span className="kbd">{mod}</span>+<span className="kbd">K</span> to open the
        command palette.
      </p>
    </div>
  )
}
