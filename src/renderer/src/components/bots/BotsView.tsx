/**
 * Bot Mode (v46) — the Bots surface, modeled on Hermes Desktop's Bots pane.
 * Since v53 Bots is a main tab beside Chat and Work: the roster (bots and
 * group rooms, active-now strip, attention chips) is the SIDEBAR's list
 * (BotRosterList), and this main area shows the shared agent editor
 * (components/agents/AgentProfileForm), the personal-agent setup, the group
 * form, or a group-room view (serial reply-or-pass rounds run main-side; this
 * view just renders the shared transcript live off push events).
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { AgentProfile, BotGroup, BotGroupMode, Message } from '@shared/types'
import AgentProfileForm from '@/components/agents/AgentProfileForm'
import AgentOnboarding from './AgentOnboarding'
import Markdown from '@/components/chat/Markdown'
import { ConfirmButton } from '@/components/common/controls'
import { relativeTime } from '@/lib/format'
import { useBotsStore } from '@/stores/bots'
import { useSettingsStore } from '@/stores/settings'
import { BotAvatarBadge } from './BotAvatarBadge'
import { toastError } from '@/stores/ui'
import { navigateGuarded, useUnsavedChanges } from '@/hooks/useUnsavedChanges'
import { getChatDraft, loadChatDraft, saveChatDraft } from '@/lib/chat-drafts'
import './bots.css'

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
  const [busy, setBusy] = useState(false)
  const savingRef = useRef(false)
  const formValue = JSON.stringify({ name, memberIds, observerIds, activation, mode, leadAgentId })
  const [baseline] = useState(formValue)
  const guard = useUnsavedChanges(formValue !== baseline)
  const createGroup = useBotsStore((s) => s.createGroup)
  const updateGroup = useBotsStore((s) => s.updateGroup)
  const maxMembers = useSettingsStore((s) => s.settings?.botMode.groupMaxMembers ?? 6)

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
    memberIds.length <= maxMembers &&
    (mode !== 'ensemble' || lead !== null)

  const submit = async (): Promise<void> => {
    if (!valid || savingRef.current) return
    savingRef.current = true; setBusy(true)
    try {
    const saved = editing
      ? await updateGroup(editing.id, {
        name: name.trim(),
        memberIds,
        activation,
        observerIds: observers,
        mode,
        leadAgentId: lead,
      })
      : await createGroup(name.trim(), memberIds, activation, observers, mode, lead)
    if (saved) { guard.markSaved(); onDone() }
    } finally { savingRef.current = false; setBusy(false) }
  }

  return (
    <div className="bot-form">
      <h3>{editing ? `Edit ${editing.name}` : 'New group chat'}</h3>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'contents' }}>
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
          Members (2–{maxMembers} bots). Observers read the room but speak only when @mentioned.
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
        <button type="button" className="primary" disabled={!valid || busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : editing ? 'Save' : 'Create room'}
        </button>
        <button type="button" onClick={() => guard.discard(onDone)}>
          Cancel
        </button>
      </div>
      </fieldset>
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
  const [draft, setDraft] = useState(() => getChatDraft(group.conversationId).text)
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  useEffect(() => {
    let live = true
    setDraftLoaded(false)
    void loadChatDraft(group.conversationId).then(value => { if (live) { setDraft(value.text); setDraftLoaded(true) } }).catch(e => toastError('Could not restore room draft', e))
    return () => { live = false }
  }, [group.conversationId])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)
  const byId = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots])
  const members = group.memberIds
    .map((id) => byId.get(id))
    .filter((bot): bot is AgentProfile => bot !== undefined)

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages.length, active])

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || sendingRef.current || !draftLoaded) return
    sendingRef.current = true; setSending(true)
    stickToBottom.current = true
    try {
      if (await sendToGroup(group.id, text)) {
        setDraft(''); await saveChatDraft(group.conversationId, { text: '' }).catch(e => toastError('Could not clear saved room draft', e))
      }
    } finally { sendingRef.current = false; setSending(false) }
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
      <div className="bot-room-messages" ref={scrollRef} onScroll={(event) => { const el = event.currentTarget; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100 }}>
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
          disabled={!draftLoaded || sending}
          onChange={(e) => { setDraft(e.target.value); void saveChatDraft(group.conversationId, { text: e.target.value }).catch(error => toastError('Could not save room draft', error)) }}
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
        <button type="button" className="primary" disabled={!draft.trim() || !draftLoaded || sending} onClick={() => void send()}>
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
// The Bots surface (main area)
// ---------------------------------------------------------------------------

/**
 * The Bots main area. The roster itself is the sidebar's list while the Bots
 * tab is active (components/bots/BotRosterList), so this pane shows what was
 * picked there: a bot form, the personal-agent setup, a group room, or the
 * overview. A bot's own chat opens in the conversation surface.
 */
export default function BotsView(): ReactElement {
  const roster = useBotsStore((s) => s.roster)
  const load = useBotsStore((s) => s.load)
  const activeGroupId = useBotsStore((s) => s.activeGroupId)
  const panel = useBotsStore((s) => s.panel)
  const setPanel = useBotsStore((s) => s.setPanel)
  const close = (): void => setPanel({ kind: 'none' })

  useEffect(() => {
    void load()
  }, [load])

  const bots = useMemo(() => roster?.bots ?? [], [roster])
  const groups = useMemo(() => roster?.groups ?? [], [roster])
  const allAgents = useMemo(() => bots.map((row) => row.agent), [bots])
  const activeGroup = groups.find((row) => row.group.id === activeGroupId)

  return (
    <div className="bots-view">
      <div className="bots-detail">
        {panel.kind === 'onboard' ? (
          <AgentOnboarding onDone={close} onCancel={close} />
        ) : panel.kind === 'new-bot' || panel.kind === 'edit-bot' ? (
          <AgentProfileForm
            key={panel.kind === 'edit-bot' ? panel.agent.id : 'new'}
            variant="bots"
            editing={panel.kind === 'edit-bot' ? panel.agent : null}
            teammates={allAgents}
            onSaved={close}
            onCancel={close}
          />
        ) : panel.kind === 'new-group' || panel.kind === 'edit-group' ? (
          <GroupForm
            key={panel.kind === 'edit-group' ? panel.group.id : 'new-group'}
            bots={allAgents.filter((agent) => agent.enabled)}
            editing={panel.kind === 'edit-group' ? panel.group : null}
            onDone={close}
          />
        ) : activeGroup ? (
          <RoomView
            key={activeGroup.group.id}
            group={activeGroup.group}
            active={activeGroup.active}
            bots={allAgents}
            onEdit={() => navigateGuarded(() => setPanel({ kind: 'edit-group', group: activeGroup.group }), 'page')}
          />
        ) : (
          <div className="bots-placeholder">
            <h3>{bots.length > 0 ? 'Your bots' : 'Meet your bots'}</h3>
            <p>
              Pick a bot in the list to open its chat — each bot keeps its own persona, memory,
              model pin and routines, and bots can message each other with <code>message_agent</code>.
              Open a group room to watch bots deliberate in short reply-or-pass rounds — or
              answer all at once and let a lead synthesize, in an ensemble room.
            </p>
            <p className="bot-empty-hint">
              Routines: open Automation, create a scheduled task and pick the
              bot under "Run as" — results land in the bot's chat.
            </p>
            <div className="bots-placeholder-actions">
              <button type="button" className="btn btn-primary" onClick={() => setPanel({ kind: 'onboard' })}>
                Set up a personal agent
              </button>
              <button type="button" className="btn" onClick={() => setPanel({ kind: 'new-bot' })}>
                New bot
              </button>
              <button type="button" className="btn" onClick={() => setPanel({ kind: 'new-group' })}>
                New group
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
