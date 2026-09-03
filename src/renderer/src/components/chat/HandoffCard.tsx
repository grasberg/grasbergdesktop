/**
 * Bot-to-bot handoff rows (v48). One delivery produces up to three rows, all
 * carrying `message.handoff`: the sender-side marker ('out', a system row the
 * model never sees — its status follows the outbox row live), the incoming
 * turn in the target's chat ('in'), and the reply or failure routed back into
 * the sender's chat ('reply'). This card renders all three with bot identity
 * and a status pill instead of a plain bubble.
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { A2aOutboxStatus, AgentProfile, Message, MessageHandoff } from '@shared/types'
import { BotAvatarBadge } from '@/components/bots/BotAvatarBadge'
import { useCopied } from '@/hooks/useCopied'
import { useBotsStore } from '@/stores/bots'
import Markdown from './Markdown'

const STATUS_LABEL: Record<A2aOutboxStatus, string> = {
  queued: 'Queued',
  delivered: 'Delivered · replying…',
  replied: 'Replied',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/** A delegation is a run, not a message: its states read as work. */
const DELEGATE_STATUS_LABEL: Record<A2aOutboxStatus, string> = {
  queued: 'Queued',
  delivered: 'Working…',
  replied: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
}

/** The persisted rows keep a model-facing prefix; the card shows the body only. */
const PREFIX =
  /^(?:Message from|Reply from|Sent to|Message to|Delegated to|Delegated by) (?:🤖 )?[^:]+?(?: failed \([^)]*\))?: /u

export function stripHandoffPrefix(content: string): string {
  return content.replace(PREFIX, '')
}

const COLLAPSE_AT = 600

type Identity = Pick<AgentProfile, 'name' | 'avatar'>

function useIdentities(handoff: MessageHandoff): { from: Identity; to: Identity } {
  const roster = useBotsStore((s) => s.roster)
  const load = useBotsStore((s) => s.load)
  useEffect(() => {
    if (!roster) void load()
  }, [roster, load])
  const resolve = (id: string | null, fallback: string): Identity => {
    const found = id ? roster?.bots.find((row) => row.agent.id === id)?.agent : undefined
    return found ?? { name: fallback, avatar: null }
  }
  return {
    from: resolve(handoff.fromAgentId, handoff.fromName || 'Grasberg'),
    to: resolve(handoff.toAgentId, handoff.toName),
  }
}

function StatusPill({ handoff }: { handoff: MessageHandoff }): ReactElement {
  const reason = handoff.status === 'failed' && handoff.reason ? ` · ${handoff.reason}` : ''
  const labels = handoff.direction === 'delegate' ? DELEGATE_STATUS_LABEL : STATUS_LABEL
  return (
    <span className={`handoff-status is-${handoff.status}`}>
      {labels[handoff.status]}
      {reason}
    </span>
  )
}

function Body({ content }: { content: string }): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const long = content.length > COLLAPSE_AT
  const shown = long && !expanded ? `${content.slice(0, COLLAPSE_AT)}…` : content
  return (
    <div className="handoff-body">
      <Markdown content={shown} />
      {long ? (
        <button type="button" className="btn-link handoff-expand" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show all'}
        </button>
      ) : null}
    </div>
  )
}

export default function HandoffCard({ message }: { message: Message }): ReactElement {
  const handoff = message.handoff!
  const { from, to } = useIdentities(handoff)
  const body = stripHandoffPrefix(message.content)
  const [copied, copy] = useCopied()

  const delegate = handoff.direction === 'delegate'
  // The caller-side marker: a system row for outbox deliveries and delegations alike.
  if (handoff.direction === 'out' || (delegate && message.role === 'system')) {
    return (
      <div className="msg-row msg-row-meta msg-row-handoff">
        <div className="handoff-card handoff-card-out">
          <div className="handoff-head">
            {handoff.fromAgentId ? (
              <>
                <BotAvatarBadge agent={from} size={20} />
                <span className="handoff-arrow" aria-hidden="true">
                  →
                </span>
              </>
            ) : null}
            <BotAvatarBadge agent={to} size={20} />
            <span className="handoff-title">
              {delegate ? 'Delegated to' : 'Sent to'} {to.name}
            </span>
            <StatusPill handoff={handoff} />
          </div>
          <Body content={body} />
        </div>
      </div>
    )
  }

  const incoming = handoff.direction === 'in' || delegate
  const speaker = incoming
    ? handoff.fromAgentId
      ? from
      : { name: delegate ? 'You' : 'Event', avatar: null }
    : to
  const title = delegate
    ? `Delegated by ${handoff.fromAgentId ? from.name : 'the user'}`
    : incoming
      ? handoff.fromAgentId
        ? `${from.name} sent a message`
        : 'An event woke this bot'
      : handoff.status === 'failed'
        ? `Message to ${to.name} failed`
        : `${to.name} replied`
  return (
    <div className="msg-row msg-row-assistant msg-row-handoff-in">
      <div className={`handoff-card handoff-card-in${handoff.status === 'failed' ? ' is-failed' : ''}`}>
        <div className="handoff-head">
          <BotAvatarBadge agent={speaker} size={20} />
          <span className="handoff-title">{title}</span>
          <StatusPill handoff={handoff} />
          <button
            type="button"
            className="btn-link handoff-copy"
            onClick={() => copy(body)}
            aria-label="Copy message"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <Body content={body} />
      </div>
    </div>
  )
}
