/**
 * Bot Mode (v46) — the Bots surface, modeled on Hermes Desktop's Bots pane:
 * an activity-ordered roster of named bots and group rooms with an active-now
 * strip, search, hide-with-eye-toggle, a compact bot editor, and a group-room
 * view (serial reply-or-pass rounds run main-side; this view just renders the
 * shared transcript live off push events).
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type {
  A2aOutboxEntry,
  A2aOutboxStatus,
  AgentProfile,
  BotBinding,
  BotGroup,
  Message,
} from '@shared/types'
import { unwrap } from '@/api/uld'
import Markdown from '@/components/chat/Markdown'
import { ConfirmButton } from '@/components/common/controls'
import { relativeTime } from '@/lib/format'
import { useBotsStore } from '@/stores/bots'
import { AVATAR_COLORS, BotAvatarBadge } from './BotAvatarBadge'
import { useProvidersStore } from '@/stores/providers'
import { toastError } from '@/stores/ui'
import './bots.css'

// ---------------------------------------------------------------------------
// Bot editor (compact — the full editor stays in Settings → Agents)
// ---------------------------------------------------------------------------

interface BotFormState {
  name: string
  title: string
  description: string
  systemPrompt: string
  providerId: string
  modelId: string
  emoji: string
  color: string
  /** '' = heartbeat off; otherwise the cadence in minutes. */
  heartbeatEvery: string
  heartbeatDeliver: 'chat' | 'notify'
  /** '' = no daily compact; otherwise the local hour 0–23. */
  resetDailyHour: string
  /** '' = no idle compact; otherwise minutes. */
  resetIdleMinutes: string
  restrictMessaging: boolean
  messageAllow: string[]
}

function emptyForm(): BotFormState {
  return {
    name: '',
    title: '',
    description: '',
    systemPrompt: '',
    providerId: '',
    modelId: '',
    emoji: '',
    color: '',
    heartbeatEvery: '',
    heartbeatDeliver: 'notify',
    resetDailyHour: '',
    resetIdleMinutes: '',
    restrictMessaging: false,
    messageAllow: [],
  }
}

function formFrom(agent: AgentProfile): BotFormState {
  return {
    name: agent.name,
    title: agent.title,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    providerId: agent.providerId ?? '',
    modelId: agent.modelId ?? '',
    emoji: agent.avatar?.emoji ?? '',
    color: agent.avatar?.color ?? '',
    heartbeatEvery: agent.heartbeat ? String(agent.heartbeat.everyMinutes) : '',
    heartbeatDeliver: agent.heartbeat?.deliver ?? 'notify',
    resetDailyHour:
      agent.reset?.dailyHour !== null && agent.reset?.dailyHour !== undefined
        ? String(agent.reset.dailyHour)
        : '',
    resetIdleMinutes:
      agent.reset?.idleMinutes !== null && agent.reset?.idleMinutes !== undefined
        ? String(agent.reset.idleMinutes)
        : '',
    restrictMessaging: agent.messageAllow !== null,
    messageAllow: agent.messageAllow ?? [],
  }
}

function BotForm({
  editing,
  teammates,
  onDone,
}: {
  editing: AgentProfile | null
  /** Other bots, for the messaging allowlist. */
  teammates: AgentProfile[]
  onDone: () => void
}): ReactElement {
  const [form, setForm] = useState<BotFormState>(editing ? formFrom(editing) : emptyForm())
  const [saving, setSaving] = useState(false)
  const providers = useProvidersStore((s) => s.providers)
  const load = useBotsStore((s) => s.load)
  const enabledProviders = providers.filter((p) => p.enabled)

  const set = (patch: Partial<BotFormState>): void => setForm((f) => ({ ...f, ...patch }))

  const submit = async (): Promise<void> => {
    if (!form.name.trim() || !form.systemPrompt.trim() || saving) return
    setSaving(true)
    const idleMinutes = form.resetIdleMinutes ? Number.parseInt(form.resetIdleMinutes, 10) : null
    const dailyHour = form.resetDailyHour ? Number.parseInt(form.resetDailyHour, 10) : null
    const payload = {
      name: form.name.trim(),
      title: form.title.trim(),
      description: form.description.trim(),
      systemPrompt: form.systemPrompt,
      providerId: form.providerId || null,
      modelId: form.modelId.trim() || null,
      avatar:
        form.emoji.trim() || form.color
          ? { emoji: form.emoji.trim() || null, color: form.color || null }
          : null,
      heartbeat: form.heartbeatEvery
        ? {
            everyMinutes: Number.parseInt(form.heartbeatEvery, 10),
            deliver: form.heartbeatDeliver,
          }
        : null,
      reset:
        dailyHour !== null || idleMinutes !== null
          ? { dailyHour, idleMinutes }
          : null,
      messageAllow: form.restrictMessaging ? form.messageAllow : null,
    }
    try {
      if (editing) await unwrap(window.uld.agents.update(editing.id, payload))
      else await unwrap(window.uld.agents.create(payload))
      await load()
      onDone()
    } catch (e) {
      toastError(editing ? 'Failed to update bot' : 'Failed to create bot', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bot-form">
      <h3>{editing ? `Edit ${editing.name}` : 'New bot'}</h3>
      <div className="bot-form-grid">
        <label>
          Name
          <input
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Researcher"
            maxLength={100}
          />
        </label>
        <label>
          Role
          <input
            value={form.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="Finds and verifies sources"
            maxLength={200}
          />
        </label>
        <label>
          Emoji (avatar)
          <input
            value={form.emoji}
            onChange={(e) => set({ emoji: e.target.value })}
            placeholder="🔎"
            maxLength={4}
          />
        </label>
        <label>
          Color
          <div className="bot-color-row">
            {AVATAR_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`bot-color-swatch${form.color === color ? ' selected' : ''}`}
                style={{ background: color }}
                aria-label={`Color ${color}`}
                onClick={() => set({ color: form.color === color ? '' : color })}
              />
            ))}
          </div>
        </label>
      </div>
      <label>
        Description (teammates see this in their roster)
        <input
          value={form.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="What this bot is for"
          maxLength={1024}
        />
      </label>
      <label>
        Persona (system prompt)
        <textarea
          value={form.systemPrompt}
          onChange={(e) => set({ systemPrompt: e.target.value })}
          rows={5}
          placeholder="You are a meticulous researcher…"
        />
      </label>
      <div className="bot-form-grid">
        <label>
          Provider (optional pin)
          <select value={form.providerId} onChange={(e) => set({ providerId: e.target.value })}>
            <option value="">Default provider</option>
            {enabledProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model id (optional pin)
          <input
            value={form.modelId}
            onChange={(e) => set({ modelId: e.target.value })}
            placeholder="Provider default"
            maxLength={200}
          />
        </label>
      </div>
      <div className="bot-form-grid">
        <label>
          Heartbeat (periodic check-in; quiet turns are discarded)
          <select
            value={form.heartbeatEvery}
            onChange={(e) => set({ heartbeatEvery: e.target.value })}
          >
            <option value="">Off</option>
            <option value="30">Every 30 minutes</option>
            <option value="60">Every hour</option>
            <option value="180">Every 3 hours</option>
            <option value="360">Every 6 hours</option>
            <option value="720">Twice a day</option>
          </select>
        </label>
        <label>
          When a heartbeat surfaces something
          <select
            value={form.heartbeatDeliver}
            onChange={(e) => set({ heartbeatDeliver: e.target.value as 'chat' | 'notify' })}
            disabled={!form.heartbeatEvery}
          >
            <option value="notify">Keep in chat + notify me</option>
            <option value="chat">Keep in chat only</option>
          </select>
        </label>
        <label>
          Auto-compact daily at (hour)
          <select
            value={form.resetDailyHour}
            onChange={(e) => set({ resetDailyHour: e.target.value })}
          >
            <option value="">Off</option>
            {Array.from({ length: 24 }, (_, hour) => (
              <option key={hour} value={String(hour)}>
                {String(hour).padStart(2, '0')}:00
              </option>
            ))}
          </select>
        </label>
        <label>
          Auto-compact after idle
          <select
            value={form.resetIdleMinutes}
            onChange={(e) => set({ resetIdleMinutes: e.target.value })}
          >
            <option value="">Off</option>
            <option value="60">1 hour quiet</option>
            <option value="240">4 hours quiet</option>
            <option value="720">12 hours quiet</option>
            <option value="1440">A day quiet</option>
          </select>
        </label>
      </div>
      <div className="bot-member-pick">
        <label className="bot-member-check">
          <input
            type="checkbox"
            checked={form.restrictMessaging}
            onChange={(e) => set({ restrictMessaging: e.target.checked })}
          />
          <span>Restrict who this bot can message (message_agent allowlist)</span>
        </label>
        {form.restrictMessaging
          ? teammates
              .filter((mate) => mate.id !== editing?.id)
              .map((mate) => (
                <label key={mate.id} className="bot-member-check bot-member-indent">
                  <input
                    type="checkbox"
                    checked={form.messageAllow.includes(mate.id)}
                    onChange={() =>
                      set({
                        messageAllow: form.messageAllow.includes(mate.id)
                          ? form.messageAllow.filter((id) => id !== mate.id)
                          : [...form.messageAllow, mate.id],
                      })
                    }
                  />
                  <BotAvatarBadge agent={mate} size={20} />
                  <span>{mate.name}</span>
                </label>
              ))
          : null}
      </div>
      {editing ? <BindingCard agent={editing} /> : null}
      {editing ? <DeliveriesCard agent={editing} /> : null}
      <div className="bot-form-actions">
        <button
          type="button"
          className="primary"
          disabled={!form.name.trim() || !form.systemPrompt.trim() || saving}
          onClick={() => void submit()}
        >
          {editing ? 'Save' : 'Create bot'}
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
        <span className="bot-form-hint">
          Tools and memory live in Settings → Agents; every bot also answers to{' '}
          <code>delegate(agent="…")</code>.
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Deliveries (v48): the bot's durable bot-to-bot outbox, both directions
// ---------------------------------------------------------------------------

const DELIVERY_STATUS_LABEL: Record<A2aOutboxStatus, string> = {
  queued: 'Queued',
  delivered: 'Delivered · replying…',
  replied: 'Replied',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

function DeliveriesCard({ agent }: { agent: AgentProfile }): ReactElement | null {
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

// ---------------------------------------------------------------------------
// Telegram binding (v47): the bot's own external presence
// ---------------------------------------------------------------------------

function BindingCard({ agent }: { agent: AgentProfile }): ReactElement {
  const [binding, setBinding] = useState<BotBinding | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const roster = useBotsStore((s) => s.roster)

  useEffect(() => {
    let alive = true
    void window.uld.bots.binding(agent.id).then((res) => {
      if (alive && res.ok) setBinding(res.data)
    })
    return () => {
      alive = false
    }
    // roster refreshes on push:botsChanged — re-pull the binding with it so
    // pairing completed from the phone shows up live.
  }, [agent.id, roster])

  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toastError('Telegram binding action failed', e)
    } finally {
      setBusy(false)
    }
  }

  const connect = (): Promise<void> =>
    run(async () => {
      const updated = await unwrap(window.uld.bots.bindingSetToken(agent.id, token.trim()))
      setBinding(updated)
      setToken('')
    })

  return (
    <div className="bot-binding">
      <h4>Telegram presence</h4>
      {!binding || !binding.hasToken ? (
        <>
          <p className="bot-form-hint">
            Give this bot its own Telegram bot: create one with @BotFather, paste its token here,
            then DM the bot the pairing code. In groups it stays silent until you send
            /allowgroup, and replies only when @mentioned (switch with /activation always).
          </p>
          <div className="bot-binding-row">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="123456789:AA…  (bot token)"
              maxLength={200}
            />
            <button
              type="button"
              className="primary"
              disabled={!token.trim() || busy}
              onClick={() => void connect()}
            >
              Connect
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="bot-binding-status">
            Status:{' '}
            <strong>
              {binding.status === 'running'
                ? binding.paired
                  ? 'running · paired'
                  : 'running · waiting for pairing'
                : binding.status}
            </strong>
            {binding.statusDetail ? ` — ${binding.statusDetail}` : ''}
          </p>
          {!binding.paired && binding.pairingCode ? (
            <p className="bot-binding-code">
              DM the bot this code: <code>{binding.pairingCode}</code>
            </p>
          ) : null}
          {!binding.paired && !binding.pairingCode ? (
            <p className="bot-form-hint">The pairing code expired — generate a new one below.</p>
          ) : null}
          {binding.groups.length > 0 ? (
            <ul className="bot-binding-groups">
              {binding.groups.map((group) => (
                <li key={group.id}>
                  <span>{group.title}</span>
                  <select
                    value={group.activation}
                    onChange={(e) =>
                      void run(async () => {
                        const updated = await unwrap(
                          window.uld.bots.bindingUpdateGroup(agent.id, group.id, {
                            activation: e.target.value as 'mention' | 'always',
                          })
                        )
                        setBinding(updated)
                      })
                    }
                  >
                    <option value="mention">On @mention</option>
                    <option value="always">Every message</option>
                  </select>
                  <button
                    type="button"
                    title="Remove this group"
                    onClick={() =>
                      void run(async () => {
                        const updated = await unwrap(
                          window.uld.bots.bindingUpdateGroup(agent.id, group.id, { remove: true })
                        )
                        setBinding(updated)
                      })
                    }
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="bot-form-hint">
              No groups yet — add the bot to a Telegram group and send /allowgroup there.
            </p>
          )}
          <div className="bot-binding-row">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const updated = await unwrap(
                    window.uld.bots.bindingSetEnabled(agent.id, !binding.enabled)
                  )
                  setBinding(updated)
                })
              }
            >
              {binding.enabled ? 'Pause' : 'Resume'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const updated = await unwrap(window.uld.bots.bindingRepair(agent.id))
                  setBinding(updated)
                })
              }
            >
              New pairing code
            </button>
            <ConfirmButton
              label="Disconnect"
              prompt="Remove the Telegram bot token and all group approvals?"
              onConfirm={() =>
                void run(async () => {
                  await unwrap(window.uld.bots.bindingClearToken(agent.id))
                  setBinding(null)
                })
              }
            />
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Group editor
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
  const createGroup = useBotsStore((s) => s.createGroup)
  const updateGroup = useBotsStore((s) => s.updateGroup)

  const toggle = (id: string): void =>
    setMemberIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))
  const toggleObserver = (id: string): void =>
    setObserverIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))

  const valid = name.trim().length > 0 && memberIds.length >= 2 && memberIds.length <= 6

  const submit = async (): Promise<void> => {
    if (!valid) return
    const observers = observerIds.filter((id) => memberIds.includes(id))
    if (editing) {
      await updateGroup(editing.id, {
        name: name.trim(),
        memberIds,
        activation,
        observerIds: observers,
      })
    } else {
      await createGroup(name.trim(), memberIds, activation, observers)
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
        Activation
        <select
          value={activation}
          onChange={(e) => setActivation(e.target.value as 'always' | 'mention')}
        >
          <option value="always">Open rounds — everyone may reply or pass</option>
          <option value="mention">Mention only — a bot speaks when @named</option>
        </select>
      </label>
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
  const loadProviders = useProvidersStore((s) => s.load)
  const [search, setSearch] = useState('')
  const [panel, setPanel] = useState<Panel>({ kind: 'none' })

  useEffect(() => {
    void load()
    void loadProviders()
  }, [load, loadProviders])

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
                className={`bots-row${entry.row.agent.hidden ? ' hidden-bot' : ''}${entry.row.agent.enabled ? '' : ' disabled-bot'}`}
              >
                <button
                  type="button"
                  className="bots-row-main"
                  onClick={() => void openBotChat(entry.row.agent.id)}
                >
                  <span className="bots-row-avatar">
                    <BotAvatarBadge agent={entry.row.agent} />
                    {entry.row.active ? <span className="bots-active-dot" /> : null}
                  </span>
                  <span className="bots-row-text">
                    <span className="bots-row-name">
                      {entry.row.agent.name}
                      {entry.row.agent.title ? (
                        <span className="bots-row-title">{entry.row.agent.title}</span>
                      ) : null}
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
                      </span>
                      {entry.row.group.needsUser ? (
                        <span className="bots-needs-you">needs you</span>
                      ) : null}
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
          <BotForm
            editing={panel.kind === 'edit-bot' ? panel.agent : null}
            teammates={allAgents}
            onDone={() => setPanel({ kind: 'none' })}
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
