/**
 * Bot Mode (v46) — the Bots surface, modeled on Hermes Desktop's Bots pane:
 * an activity-ordered roster of named bots and group rooms with an active-now
 * strip, search, hide-with-eye-toggle, attention chips (v49), the shared
 * agent editor (components/agents/AgentProfileForm), and a group-room view
 * (serial reply-or-pass rounds run main-side; this view just renders the
 * shared transcript live off push events).
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { AgentProfile, BotAttention, BotGroup, BotGroupMode, Message } from '@shared/types'
import { unwrap } from '@/api/uld'
import AgentProfileForm from '@/components/agents/AgentProfileForm'
import Markdown from '@/components/chat/Markdown'
import { ConfirmButton } from '@/components/common/controls'
import { relativeTime } from '@/lib/format'
import { useBotsStore } from '@/stores/bots'
import { BotAvatarBadge } from './BotAvatarBadge'
import { toastError } from '@/stores/ui'
import './bots.css'

// ---------------------------------------------------------------------------
// Attention chip (v49): needs you / new / working
// ---------------------------------------------------------------------------

function AttentionChip({ attention }: { attention: BotAttention }): ReactElement | null {
  if (attention === 'needs_you') return <span className="bots-needs-you">needs you</span>
  if (attention === 'unread') return <span className="bots-unread-chip">new</span>
  return null
}

// ---------------------------------------------------------------------------
// Group form
// ---------------------------------------------------------------------------

function GroupForm({
  bots,
  editing,
  onDone,
}: {
  bots: AgentProfile[]
  editing: BotGroup | null
  onDone: () => void
}): ReactElement {
  const [name, setName] = useState(editing?.name ?? '')
  const [memberIds, setMemberIds] = useState<string[]>(editing?.memberIds ?? [])
  const [observerIds, setObserverIds] = useState<string[]>(editing?.observerIds ?? [])
  const [activation, setActivation] = useState<'always' | 'mention'>(
    editing?.activation ?? 'always'
  )
  const [mode, setMode] = useState<BotGroupMode>(editing?.mode ?? 'roundtable')
  const [leadAgentId, setLeadAgentId] = useState<string>(editing?.leadAgentId ?? '')
  const createGroup = useBotsStore((s) => s.createGroup)
  const updateGroup = useBotsStore((s) => s.updateGroup)

  const toggle = (id: string): void =>
    setMemberIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))
  const toggleObserver = (id: string): void =>
    setObserverIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))

  const observers = observerIds.filter((id) => memberIds.includes(id))
  const leadCandidates = memberIds.filter((id) => !observers.includes(id))
  const lead = mode === 'ensemble' && leadCandidates.includes(leadAgentId) ? leadAgentId : null
  const valid =
    name.trim().length > 0 &&
    memberIds.length >= 2 &&
    memberIds.length <= 6 &&
    (mode !== 'ensemble' || lead !== null)

  const submit = async (): Promise<void> => {
    if (!valid) return
    if (editing) {
      await updateGroup(editing.id, {
        name: name.trim(),
        memberIds,
        activation,
        observerIds: observers,
        mode,
        leadAgentId: lead,
      })
    } else {
      await createGroup(name.trim(), memberIds, activation, observers, mode, lead)
    }
    onDone()
  }

  return (
    <div className="bot-form">
      <h3>{editing ? `Edit ${editing.name}` : 'New group chat'}</h3>
      <label>
        Room name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Product council"
          maxLength={200}
        />
      </label>
      <label>
        Mode
        <select value={mode} onChange={(e) => setMode(e.target.value as BotGroupMode)}>
          <option value="roundtable">Round table — short reply-or-pass rounds</option>
          <option value="ensemble">Ensemble — everyone answers at once, the lead synthesizes</option>
        </select>
      </label>
      {mode === 'ensemble' ? (
        <label>
          Lead (writes the reply you read)
          <select value={lead ?? ''} onChange={(e) => setLeadAgentId(e.target.value)}>
            <option value="">Pick a member…</option>
            {leadCandidates.map((id) => {
              const bot = bots.find((candidate) => candidate.id === id)
              return bot ? (
                <option key={id} value={id}>
                  {bot.name}
                </option>
              ) : null
            })}
          </select>
        </label>
      ) : (
        <label>
          Activation
          <select
            value={activation}
            onChange={(e) => setActivation(e.target.value as 'always' | 'mention')}
          >
            <option value="always">Open rounds — everyone may reply or pass</option>
            <option value="mention">Mention only — a bot speaks when @named</option>
          </select>
        </label>
      )}
      <div className="bot-member-pick">
        <span className="bot-form-hint">
          Members (2–6 bots). Observers read the room but speak only when @mentioned.
        </span>
        {bots.map((bot) => (
          <div key={bot.id} className="bot-member-row">
            <label className="bot-member-check">
              <input
                type="checkbox"
                checked={memberIds.includes(bot.id)}
                onChange={() => toggle(bot.id)}
              />
              <BotAvatarBadge agent={bot} size={20} />
              <span>{bot.name}</span>
            </label>
            {memberIds.includes(bot.id) ? (
              <label className="bot-member-check bot-observer-check">
                <input
                  type="checkbox"
                  checked={observerIds.includes(bot.id)}
                  onChange={() => toggleObserver(bot.id)}
                />
                <span>observer</span>
              </label>
            ) : null}
          </div>
        ))}
        {bots.length < 2 ? (
          <span className="bot-form-hint">Create at least two bots first.</span>
        ) : null}
      </div>
      <div className="bot-form-actions">
        <button type="button" className="primary" disabled={!valid} onClick={() => void submit()}>
          {editing ? 'Save' : 'Create room'}
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Group room view
// ---------------------------------------------------------------------------

function RoomView({
  group,
  active,
  bots,
  onEdit,
}: {
  group: BotGroup
  active: boolean
  bots: AgentProfile[]
  onEdit: () => void
}): ReactElement {
  const messages = useBotsStore((s) => s.groupMessages)
  const sendToGroup = useBotsStore((s) => s.sendToGroup)
  const stopGroup = useBotsStore((s) => s.stopGroup)
  const deleteGroup = useBotsStore((s) => s.deleteGroup)
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const byId = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots])
  const members = group.memberIds
    .map((id) => byId.get(id))
    .filter((bot): bot is AgentProfile => bot !== undefined)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, active])

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    await sendToGroup(group.id, text)
  }

  return (
    <section className="bot-room" aria-label={`Group chat ${group.name}`}>
      <header className="bot-room-header">
        <div className="bot-room-title">
          <strong>{group.name}</strong>
          {group.mode === 'ensemble' ? (
            <span className="bots-row-title" title="Every member answers at once; the lead synthesizes">
              ensemble · lead {byId.get(group.leadAgentId ?? '')?.name ?? '—'}
            </span>
          ) : null}
          <span className="bot-room-members">
            {members.map((member) => (
              <span key={member.id} className="bot-room-member" title={member.title || member.name}>
                <BotAvatarBadge agent={member} size={22} />
                {member.name}
              </span>
            ))}
          </span>
        </div>
        <div className="bot-room-actions">
          {active ? (
            <button type="button" onClick={() => void stopGroup(group.id)}>
              Stop
            </button>
          ) : null}
          <button type="button" onClick={onEdit}>
            Edit
          </button>
          <ConfirmButton
            label="Disband"
            prompt="Disband this room? The transcript is deleted permanently."
            onConfirm={() => void deleteGroup(group.id)}
          />
        </div>
      </header>
      <div className="bot-room-messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <p className="bot-empty-hint">
            Say something to the room. @mention a bot to address it directly; the members reply
            in up to three short rounds and pass when they have nothing to add.
          </p>
        ) : null}
        {messages.map((message) => (
          <RoomMessage key={message.id} message={message} byId={byId} />
        ))}
        {active ? <p className="bot-room-typing">The bots are deliberating…</p> : null}
      </div>
      <div className="bot-room-composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={
            active
              ? 'Deliberating — a message sent now joins the discussion'
              : `Message ${group.name}`
          }
          rows={2}
        />
        <button type="button" className="primary" disabled={!draft.trim()} onClick={() => void send()}>
          Send
        </button>
      </div>
    </section>
  )
}

function RoomMessage({
  message,
  byId,
}: {
  message: Message
  byId: Map<string, AgentProfile>
}): ReactElement {
  const bot = message.agentId ? byId.get(message.agentId) : undefined
  const isUser = message.role === 'user'
  return (
    <article className={`bot-room-message${isUser ? ' from-user' : ''}`}>
      <div className="bot-room-message-head">
        {bot ? <BotAvatarBadge agent={bot} size={22} /> : null}
        <strong>{isUser ? 'You' : (bot?.name ?? 'Bot')}</strong>
        <time>{relativeTime(message.createdAt)}</time>
      </div>
      <div className="bot-room-message-body">
        <Markdown content={message.content} />
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------
// The Bots surface
// ---------------------------------------------------------------------------

type Panel =
  | { kind: 'none' }
  | { kind: 'new-bot' }
  | { kind: 'edit-bot'; agent: AgentProfile }
  | { kind: 'new-group' }
  | { kind: 'edit-group'; group: BotGroup }

export default function BotsView(): ReactElement {
  const roster = useBotsStore((s) => s.roster)
  const loaded = useBotsStore((s) => s.loaded)
  const load = useBotsStore((s) => s.load)
  const openBotChat = useBotsStore((s) => s.openBotChat)
  const activeGroupId = useBotsStore((s) => s.activeGroupId)
  const selectGroup = useBotsStore((s) => s.selectGroup)
  const setHidden = useBotsStore((s) => s.setHidden)
  const showHidden = useBotsStore((s) => s.showHidden)
  const setShowHidden = useBotsStore((s) => s.setShowHidden)
  const [search, setSearch] = useState('')
  const [panel, setPanel] = useState<Panel>({ kind: 'none' })

  useEffect(() => {
    void load()
  }, [load])

  const bots = useMemo(() => roster?.bots ?? [], [roster])
  const groups = useMemo(() => roster?.groups ?? [], [roster])
  const allAgents = useMemo(() => bots.map((row) => row.agent), [bots])
  const anyHidden = bots.some((row) => row.agent.hidden)
  const activeNow = bots.filter((row) => row.active && !row.agent.hidden)

  const query = search.trim().toLowerCase()
  const visibleBots = bots.filter(
    (row) =>
      (showHidden || !row.agent.hidden) &&
      (!query ||
        row.agent.name.toLowerCase().includes(query) ||
        row.agent.title.toLowerCase().includes(query))
  )
  const visibleGroups = groups.filter(
    (row) => !query || row.group.name.toLowerCase().includes(query)
  )

  // One activity-ordered roster: group rows standalone among the bot DMs.
  const rows = useMemo(() => {
    const merged: Array<
      | { kind: 'bot'; at: number; row: (typeof visibleBots)[number] }
      | { kind: 'group'; at: number; row: (typeof visibleGroups)[number] }
    > = [
      ...visibleBots.map((row) => ({
        kind: 'bot' as const,
        at: row.lastMessageAt ?? row.agent.createdAt,
        row,
      })),
      ...visibleGroups.map((row) => ({
        kind: 'group' as const,
        at: row.lastMessageAt ?? row.group.createdAt,
        row,
      })),
    ]
    return merged.sort((a, b) => b.at - a.at)
  }, [visibleBots, visibleGroups])

  const activeGroup = groups.find((row) => row.group.id === activeGroupId)

  return (
    <div className="bots-view">
      <aside className="bots-roster" aria-label="Bots">
        <header className="bots-roster-header">
          <h2>Bots</h2>
          <div className="bots-roster-actions">
            {anyHidden ? (
              <button
                type="button"
                className={`icon-btn${showHidden ? ' active' : ''}`}
                title={showHidden ? 'Conceal hidden bots' : 'Reveal hidden bots'}
                onClick={() => setShowHidden(!showHidden)}
              >
                👁
              </button>
            ) : null}
            <button type="button" onClick={() => setPanel({ kind: 'new-group' })}>
              New group
            </button>
            <button type="button" className="primary" onClick={() => setPanel({ kind: 'new-bot' })}>
              New bot
            </button>
          </div>
        </header>
        <input
          type="search"
          className="bots-search"
          placeholder="Search bots"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {activeNow.length > 0 ? (
          <div className="bots-active-strip" aria-label="Active now">
            {activeNow.map((row) => (
              <button
                key={row.agent.id}
                type="button"
                className="bots-active-chip"
                title={`${row.agent.name} is working`}
                onClick={() => void openBotChat(row.agent.id)}
              >
                <BotAvatarBadge agent={row.agent} size={22} />
                <span>{row.agent.name}</span>
              </button>
            ))}
          </div>
        ) : null}
        <ul className="bots-list">
          {rows.map((entry) =>
            entry.kind === 'bot' ? (
              <li
                key={`bot-${entry.row.agent.id}`}
                className={`bots-row${entry.row.agent.hidden ? ' hidden-bot' : ''}${entry.row.agent.enabled ? '' : ' disabled-bot'}${entry.row.attention === 'unread' || entry.row.attention === 'needs_you' ? ' has-attention' : ''}`}
              >
                <button
                  type="button"
                  className="bots-row-main"
                  onClick={() => void openBotChat(entry.row.agent.id)}
                >
                  <span className="bots-row-avatar">
                    <BotAvatarBadge agent={entry.row.agent} />
                    {entry.row.attention === 'working' ? (
                      <span className="bots-active-dot" title="Working" />
                    ) : null}
                  </span>
                  <span className="bots-row-text">
                    <span className="bots-row-name">
                      {entry.row.agent.name}
                      {entry.row.agent.title ? (
                        <span className="bots-row-title">{entry.row.agent.title}</span>
                      ) : null}
                      <AttentionChip attention={entry.row.attention} />
                    </span>
                    <span className="bots-row-snippet">
                      {entry.row.snippet ?? 'No messages yet — say hi.'}
                    </span>
                  </span>
                  {entry.row.lastMessageAt ? (
                    <time>{relativeTime(entry.row.lastMessageAt)}</time>
                  ) : null}
                </button>
                <span className="bots-row-menu">
                  <button
                    type="button"
                    title="Edit bot"
                    onClick={() => setPanel({ kind: 'edit-bot', agent: entry.row.agent })}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    title={entry.row.agent.hidden ? 'Unhide bot' : 'Hide bot (display only)'}
                    onClick={() => void setHidden(entry.row.agent.id, !entry.row.agent.hidden)}
                  >
                    {entry.row.agent.hidden ? '🙈' : '—'}
                  </button>
                  <ConfirmButton
                    label="✕"
                    prompt={`Delete ${entry.row.agent.name}? Its chat and memberships go too.`}
                    onConfirm={async () => {
                      try {
                        await unwrap(window.uld.agents.delete(entry.row.agent.id))
                        await load()
                      } catch (e) {
                        toastError('Failed to delete bot', e)
                      }
                    }}
                  />
                </span>
              </li>
            ) : (
              <li
                key={`group-${entry.row.group.id}`}
                className={`bots-row group-row${entry.row.group.id === activeGroupId ? ' selected' : ''}`}
              >
                <button
                  type="button"
                  className="bots-row-main"
                  onClick={() => selectGroup(entry.row.group.id)}
                >
                  <span className="bots-row-avatar group-avatar">👥</span>
                  <span className="bots-row-text">
                    <span className="bots-row-name">
                      {entry.row.group.name}
                      <span className="bots-row-title">
                        {entry.row.group.memberIds.length} bots
                        {entry.row.group.mode === 'ensemble' ? ' · ensemble' : ''}
                      </span>
                      <AttentionChip attention={entry.row.attention} />
                    </span>
                    <span className="bots-row-snippet">
                      {entry.row.active
                        ? 'Deliberating…'
                        : (entry.row.snippet ?? 'A quiet room.')}
                    </span>
                  </span>
                  {entry.row.lastMessageAt ? (
                    <time>{relativeTime(entry.row.lastMessageAt)}</time>
                  ) : null}
                </button>
              </li>
            )
          )}
          {loaded && rows.length === 0 ? (
            <li className="bot-empty-hint">
              {query
                ? 'No bots match.'
                : 'No bots yet. Create one — a bot keeps its own chat, memory, model and routines.'}
            </li>
          ) : null}
        </ul>
      </aside>
      <main className="bots-detail">
        {panel.kind === 'new-bot' || panel.kind === 'edit-bot' ? (
          <AgentProfileForm
            key={panel.kind === 'edit-bot' ? panel.agent.id : 'new'}
            variant="bots"
            editing={panel.kind === 'edit-bot' ? panel.agent : null}
            teammates={allAgents}
            onSaved={() => setPanel({ kind: 'none' })}
            onCancel={() => setPanel({ kind: 'none' })}
          />
        ) : panel.kind === 'new-group' || panel.kind === 'edit-group' ? (
          <GroupForm
            bots={allAgents.filter((agent) => agent.enabled)}
            editing={panel.kind === 'edit-group' ? panel.group : null}
            onDone={() => setPanel({ kind: 'none' })}
          />
        ) : activeGroup ? (
          <RoomView
            group={activeGroup.group}
            active={activeGroup.active}
            bots={allAgents}
            onEdit={() => setPanel({ kind: 'edit-group', group: activeGroup.group })}
          />
        ) : (
          <div className="bots-placeholder">
            <h3>Your bot roster</h3>
            <p>
              Click a bot to open its chat — each bot keeps its own persona, memory, model pin
              and routines, and bots can message each other with <code>message_agent</code>.
              Open a group room to watch 2–6 bots deliberate in short reply-or-pass rounds.
            </p>
            <p className="bot-empty-hint">
              Routines: schedule a task in the composer's Scheduled Tasks popover and pick the
              bot under "Run as" — results land in the bot's chat.
            </p>
            <button type="button" className="primary" onClick={() => setPanel({ kind: 'new-bot' })}>
              New bot
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
