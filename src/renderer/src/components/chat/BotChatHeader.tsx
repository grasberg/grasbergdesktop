/**
 * Header of a bot's canonical chat (v49): who you are talking to, its live
 * attention state, a way back to the roster — and the "seen" stamp. The
 * definition of "the user is looking at this chat" lives here, where both
 * facts are known: the window is focused AND this bot chat is the open
 * conversation. Every new message re-stamps while that holds, so the badge
 * never lights up for what is already on screen.
 */

import { useEffect, type ReactElement } from 'react'
import { BotAvatarBadge } from '@/components/bots/BotAvatarBadge'
import { useBotsStore } from '@/stores/bots'
import { useChatStore } from '@/stores/chat'
import { useUiStore } from '@/stores/ui'

export default function BotChatHeader({
  agentId,
  fallbackTitle,
}: {
  agentId: string
  fallbackTitle: string
}): ReactElement {
  const row = useBotsStore((s) => s.roster?.bots.find((bot) => bot.agent.id === agentId) ?? null)
  const roster = useBotsStore((s) => s.roster)
  const load = useBotsStore((s) => s.load)
  const markSeen = useBotsStore((s) => s.markSeen)
  const lastMessageId = useChatStore((s) => s.messages.at(-1)?.id ?? null)

  useEffect(() => {
    if (!roster) void load()
  }, [roster, load])

  useEffect(() => {
    const stamp = (): void => {
      if (document.hasFocus()) void markSeen(agentId)
    }
    stamp()
    window.addEventListener('focus', stamp)
    return () => window.removeEventListener('focus', stamp)
  }, [agentId, lastMessageId, markSeen])

  const agent = row?.agent ?? null
  const attention = row?.attention ?? 'idle'
  return (
    <div className="chat-bot-header">
      <BotAvatarBadge agent={agent ?? { name: fallbackTitle, avatar: null }} size={28} />
      <div className="chat-bot-header-text">
        <h1 className="chat-title" title={agent?.name ?? fallbackTitle}>
          {agent?.name ?? fallbackTitle}
        </h1>
        {agent?.title ? <span className="chat-bot-header-role">{agent.title}</span> : null}
      </div>
      {attention === 'working' ? (
        <span className="chat-bot-header-state is-working">working</span>
      ) : attention === 'needs_you' ? (
        <span className="chat-bot-header-state is-needs-you">needs you</span>
      ) : null}
      <button
        type="button"
        className="btn btn-ghost chat-bot-header-back"
        onClick={() => useUiStore.getState().setView('bots')}
      >
        Bots
      </button>
    </div>
  )
}
