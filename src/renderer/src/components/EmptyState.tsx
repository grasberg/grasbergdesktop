import { modKeyLabel } from '@/lib/platform'
import { newConversation } from '@/lib/new-conversation'
import appIcon from '@/assets/icon.png'

export default function EmptyState(): React.JSX.Element {
  const newChat = (): void => {
    newConversation('chat')
  }

  return (
    <div className="empty-state">
      <img
        src={appIcon}
        width={56}
        height={56}
        alt=""
        aria-hidden="true"
        draggable={false}
        style={{ display: 'block' }}
      />
      <h1 className="empty-title">Grasberg</h1>
      <p className="empty-subtitle">
        One local-first home for DeepSeek, GLM, MiniMax and any OpenAI-compatible model.
      </p>
      <button type="button" className="btn btn-primary" onClick={newChat}>
        Start a new chat
      </button>
      <p className="empty-hint">
        Tip: press <span className="kbd">{modKeyLabel}</span>+<span className="kbd">K</span> to open the
        command palette.
      </p>
    </div>
  )
}
