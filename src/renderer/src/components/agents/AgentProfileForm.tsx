/**
 * The ONE editor for an agent profile / bot (v49). A bot is an `agents` row;
 * the Bots pane and Settings → Agents both render this form, so identity,
 * persona, model pin, capabilities (tools, rounds, enabled), heartbeat,
 * auto-compact, the messaging allowlist, the Telegram binding and the
 * deliveries log are edited in exactly one place.
 */

import { useEffect, useState, type ReactElement } from 'react'
import type {
  AgentProfile,
  AgentProfileInput,
  BotUsageSummary,
  WorkflowTriggerInfo,
  WorkflowWatchStatus,
} from '@shared/types'
import { formatCost } from '@shared/pricing'
import { unwrap } from '@/api/uld'
import BindingCard from '@/components/bots/BindingCard'
import BotRoutinesPanel from '@/components/bots/BotRoutinesPanel'
import { AVATAR_COLORS, BotAvatarBadge } from '@/components/bots/BotAvatarBadge'
import BotAvatarPicker from './BotAvatarPicker'
import DeliveriesCard from '@/components/bots/DeliveriesCard'
import { useBotsStore } from '@/stores/bots'
import { useProvidersStore } from '@/stores/providers'
import { useToolsStore } from '@/stores/tools'
import { toastError, useUiStore } from '@/stores/ui'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'
import ModelField from '@/components/chat/ModelField'
import './agent-form.css'

export interface AgentProfileFormProps {
  editing: AgentProfile | null
  /** Every other profile (the message_agent allowlist picker); self is filtered out. */
  teammates: AgentProfile[]
  /** Copy only — which surface hosts the form. */
  variant?: 'bots' | 'settings'
  onSaved: (agent: AgentProfile) => void
  onCancel: () => void
}

interface FormState {
  name: string
  title: string
  description: string
  systemPrompt: string
  providerId: string
  modelId: string
  emoji: string
  imageDataUrl: string | null
  color: string
  restrictTools: boolean
  toolIds: string[]
  /** '' = the delegate default (12). */
  maxRounds: string
  enabled: boolean
  /** '' = heartbeat off; otherwise the cadence in minutes. */
  heartbeatEvery: string
  heartbeatDeliver: 'chat' | 'notify'
  /** '' = no daily compact; otherwise the local hour 0–23. */
  resetDailyHour: string
  /** '' = no idle compact; otherwise minutes. */
  resetIdleMinutes: string
  restrictMessaging: boolean
  messageAllow: string[]
  /** Events → bot (v50). */
  webhookEnabled: boolean
  watchEnabled: boolean
  watchFolder: string
  watchGlob: string
  watchEvent: 'created' | 'changed'
}

function emptyForm(): FormState {
  return {
    name: '',
    title: '',
    description: '',
    systemPrompt: '',
    providerId: '',
    modelId: '',
    emoji: '',
    imageDataUrl: null,
    color: '',
    restrictTools: false,
    toolIds: [],
    maxRounds: '',
    enabled: true,
    heartbeatEvery: '',
    heartbeatDeliver: 'notify',
    resetDailyHour: '',
    resetIdleMinutes: '',
    restrictMessaging: false,
    messageAllow: [],
    webhookEnabled: false,
    watchEnabled: false,
    watchFolder: '',
    watchGlob: '',
    watchEvent: 'created',
  }
}

function formFrom(agent: AgentProfile): FormState {
  return {
    name: agent.name,
    title: agent.title,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    providerId: agent.providerId ?? '',
    modelId: agent.modelId ?? '',
    emoji: agent.avatar?.emoji ?? '',
    imageDataUrl: agent.avatar?.imageDataUrl ?? null,
    color: agent.avatar?.color ?? '',
    restrictTools: agent.toolIds !== null,
    toolIds: agent.toolIds ?? [],
    maxRounds: agent.maxRounds ? String(agent.maxRounds) : '',
    enabled: agent.enabled,
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
    webhookEnabled: agent.webhookEnabled,
    watchEnabled: agent.watch?.enabled ?? false,
    watchFolder: agent.watch?.folderPath ?? '',
    watchGlob: agent.watch?.glob ?? '',
    watchEvent: agent.watch?.event ?? 'created',
  }
}

function toInput(form: FormState): AgentProfileInput {
  const idleMinutes = form.resetIdleMinutes ? Number.parseInt(form.resetIdleMinutes, 10) : null
  const dailyHour = form.resetDailyHour ? Number.parseInt(form.resetDailyHour, 10) : null
  const rounds = Math.floor(Number(form.maxRounds))
  return {
    name: form.name.trim(),
    title: form.title.trim(),
    description: form.description.trim(),
    systemPrompt: form.systemPrompt,
    providerId: form.providerId || null,
    modelId: form.modelId.trim() || null,
    toolIds: form.restrictTools ? form.toolIds : null,
    maxRounds: Number.isFinite(rounds) && rounds >= 1 ? Math.min(rounds, 40) : null,
    enabled: form.enabled,
    avatar:
      form.emoji.trim() || form.color || form.imageDataUrl
        ? { emoji: form.emoji.trim() || null, color: form.color || null, imageDataUrl: form.imageDataUrl }
        : null,
    heartbeat: form.heartbeatEvery
      ? { everyMinutes: Number.parseInt(form.heartbeatEvery, 10), deliver: form.heartbeatDeliver }
      : null,
    reset: dailyHour !== null || idleMinutes !== null ? { dailyHour, idleMinutes } : null,
    messageAllow: form.restrictMessaging ? form.messageAllow : null,
    webhookEnabled: form.webhookEnabled,
    watch: form.watchFolder
      ? {
          enabled: form.watchEnabled,
          folderPath: form.watchFolder,
          glob: form.watchGlob.trim(),
          event: form.watchEvent,
        }
      : null,
  }
}

/** Live wake URL + watch state for a saved bot, plus a manual test event. */
function BotEventsInfo({ agent }: { agent: AgentProfile }): ReactElement {
  const [trigger, setTrigger] = useState<WorkflowTriggerInfo | null>(null)
  const [watch, setWatch] = useState<WorkflowWatchStatus | null>(null)
  const [testing, setTesting] = useState(false)
  useEffect(() => {
    let alive = true
    void window.uld.agents.triggerInfo(agent.id).then((res) => {
      if (alive && res.ok) setTrigger(res.data)
    })
    void window.uld.agents.watchInfo(agent.id).then((res) => {
      if (alive && res.ok) setWatch(res.data)
    })
    return () => {
      alive = false
    }
  }, [agent.id, agent.webhookEnabled, agent.watch])
  const sendTest = async (): Promise<void> => {
    setTesting(true)
    try {
      await unwrap(window.uld.agents.wake(agent.id, 'Test event from the bot editor.'))
      useUiStore.getState().toast(`Test event queued for ${agent.name} — see its chat.`, 'success')
    } catch (e) {
      toastError('Could not send the test event', e)
    } finally {
      setTesting(false)
    }
  }
  return (
    <div className="bot-events-info">
      {agent.webhookEnabled ? (
        trigger?.url ? (
          <p className="bot-form-hint">
            Wake URL (POST, the body becomes the event): <code>{trigger.url}</code>
          </p>
        ) : (
          <p className="bot-form-hint">
            The trigger endpoint is off — switch it on under Workflows → trigger endpoint to get
            this bot's wake URL.
          </p>
        )
      ) : null}
      {agent.watch?.enabled ? (
        <p className="bot-form-hint">
          Folder watch: {watch?.watching ? 'live' : 'not running'}
          {watch?.lastError ? ` — ${watch.lastError}` : ''}
        </p>
      ) : null}
      <button type="button" disabled={testing} onClick={() => void sendTest()}>
        {testing ? 'Sending…' : 'Send test event'}
      </button>
    </div>
  )
}

/** Estimated spend attributable to the bot (its chat + runs stamped with its id). */
function BotSpendCard({ agent }: { agent: AgentProfile }): ReactElement | null {
  const [usage, setUsage] = useState<BotUsageSummary | null>(null)
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.uld.bots.usage(agent.id).then((res) => {
        if (alive && res.ok) setUsage(res.data)
      })
    }
    load()
    const unsubscribe = window.uld.bots.onChanged(() => load())
    return () => {
      alive = false
      unsubscribe()
    }
  }, [agent.id])
  if (!usage) return null
  const unpriced = usage.month.unpricedCount
  return (
    <div className="bot-spend">
      <h4>Estimated spend</h4>
      <div className="bot-spend-row">
        <span>
          <strong>{formatCost(usage.today.costUsd)}</strong> today
        </span>
        <span>
          <strong>{formatCost(usage.week.costUsd)}</strong> / 7 d
        </span>
        <span>
          <strong>{formatCost(usage.month.costUsd)}</strong> / 30 d
        </span>
      </div>
      <p className="bot-form-hint">
        Its chat plus routines, room turns and delegations run as this bot; estimates only
        {unpriced > 0 ? ` — ${unpriced} unpriced run${unpriced === 1 ? '' : 's'} excluded` : ''}.
      </p>
    </div>
  )
}

export default function AgentProfileForm({
  editing,
  teammates,
  variant = 'bots',
  onSaved,
  onCancel,
}: AgentProfileFormProps): ReactElement {
  const [form, setForm] = useState<FormState>(editing ? formFrom(editing) : emptyForm())
  const [baseline] = useState(() => JSON.stringify(editing ? formFrom(editing) : emptyForm()))
  const { markSaved, discard } = useUnsavedChanges(JSON.stringify(form) !== baseline, variant === 'settings' ? 'settings' : 'page')
  const [saving, setSaving] = useState(false)
  const [loadingAvatar, setLoadingAvatar] = useState(false)
  const [dreaming, setDreaming] = useState(false)
  const providers = useProvidersStore((s) => s.providers)
  const loadProviders = useProvidersStore((s) => s.load)
  const toolDefs = useToolsStore((s) => s.tools)
  const toolsLoaded = useToolsStore((s) => s.loaded)

  useEffect(() => {
    if (providers.length === 0) void loadProviders()
    if (!toolsLoaded) void useToolsStore.getState().load()
  }, [providers.length, loadProviders, toolsLoaded])

  const set = (patch: Partial<FormState>): void => setForm((f) => ({ ...f, ...patch }))
  const toggleIn = (key: 'toolIds' | 'messageAllow', id: string): void =>
    set({ [key]: form[key].includes(id) ? form[key].filter((x) => x !== id) : [...form[key], id] })

  const valid = form.name.trim().length > 0 && form.systemPrompt.trim().length > 0

  const submit = async (): Promise<void> => {
    if (!valid || saving || loadingAvatar) return
    setSaving(true)
    try {
      const input = toInput(form)
      const saved = editing
        ? await unwrap(window.uld.agents.update(editing.id, input))
        : await unwrap(window.uld.agents.create(input))
      await useBotsStore.getState().load()
      markSaved()
      onSaved(saved)
    } catch (e) {
      toastError(editing ? 'Failed to save the bot' : 'Failed to create the bot', e)
    } finally {
      setSaving(false)
    }
  }

  const consolidateMemory = async (): Promise<void> => {
    if (!editing || dreaming) return
    setDreaming(true)
    try {
      const result = await unwrap(window.uld.memories.dream(editing.id))
      const toast = useUiStore.getState().toast
      if (!result.ran) toast(`${editing.name} has too few memories to consolidate yet.`)
      else if (result.updated + result.removed + result.created === 0)
        toast(`${editing.name}'s memory is already well consolidated.`, 'success')
      else toast(`${editing.name}: ${result.before} → ${result.after} memories.`, 'success')
    } catch (e) {
      toastError('Consolidation failed', e)
    } finally {
      setDreaming(false)
    }
  }

  const preview = { name: form.name.trim() || 'Bot', avatar: { emoji: form.emoji.trim() || null, color: form.color || null, imageDataUrl: form.imageDataUrl } }

  return (
    <div className="bot-form" inert={saving} aria-busy={saving}>
      <h3>
        <BotAvatarBadge agent={preview} size={28} />{' '}
        {editing ? `Edit ${editing.name}` : variant === 'settings' ? 'New agent' : 'New bot'}
      </h3>

      <fieldset className="bot-form-section">
        <legend>Identity</legend>
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
          <BotAvatarPicker name={preview.name} avatar={preview.avatar} disabled={saving}
            onBusyChange={setLoadingAvatar} onChange={(patch) => set({
              ...(patch.emoji !== undefined ? { emoji: patch.emoji ?? '' } : {}),
              ...(patch.imageDataUrl !== undefined ? { imageDataUrl: patch.imageDataUrl } : {}),
            })} />
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
        <span className="bot-form-hint">
          The assistant reaches it with <code>delegate(agent="{form.name.trim() || 'name'}")</code>;
          teammates address it as @{form.name.trim().toLowerCase().replace(/\s+/g, '-') || 'name'}.
        </span>
      </fieldset>

      <fieldset className="bot-form-section">
        <legend>Persona &amp; model</legend>
        <label>
          System prompt (persona)
          <textarea
            value={form.systemPrompt}
            onChange={(e) => set({ systemPrompt: e.target.value })}
            rows={6}
            placeholder="You are a meticulous researcher…"
          />
        </label>
        <ModelField providerId={form.providerId || null} modelId={form.modelId || null} onChange={(providerId, modelId) => set({ providerId: providerId ?? '', modelId: modelId ?? '' })} />
      </fieldset>

      <details className="bot-advanced"><summary>Advanced settings · tools, routines, messaging &amp; events</summary>
      <fieldset className="bot-form-section">
        <legend>Capabilities</legend>
        <label className="bot-form-inline">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          <span>Enabled — disabled bots are skipped by delegate, rooms, routines and teammates</span>
        </label>
        <label className="bot-form-inline">
          <span>Max tool rounds</span>
          <input
            type="number"
            min={1}
            max={40}
            value={form.maxRounds}
            onChange={(e) => set({ maxRounds: e.target.value })}
            placeholder="12"
          />
          <span className="bot-form-hint">empty = default 12</span>
        </label>
        <label className="bot-form-inline">
          <input
            type="checkbox"
            checked={form.restrictTools}
            onChange={(e) => set({ restrictTools: e.target.checked })}
          />
          <span>Restrict tools — off = the standard sub-agent toolset; on = only the tools picked below</span>
        </label>
        {form.restrictTools ? (
          <div className="bot-form-tools">
            {toolDefs
              .filter((t) => t.enabled && t.id !== 'delegate')
              .map((t) => (
                <label key={t.id}>
                  <input
                    type="checkbox"
                    checked={form.toolIds.includes(t.id)}
                    onChange={() => toggleIn('toolIds', t.id)}
                  />
                  <code>{t.name}</code>
                </label>
              ))}
          </div>
        ) : null}
      </fieldset>

      <fieldset className="bot-form-section">
        <legend>Rhythm</legend>
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
      </fieldset>

      <fieldset className="bot-form-section">
        <legend>Messaging</legend>
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
                      onChange={() => toggleIn('messageAllow', mate.id)}
                    />
                    <BotAvatarBadge agent={mate} size={20} />
                    <span>{mate.name}</span>
                  </label>
                ))
            : null}
        </div>
      </fieldset>

      <fieldset className="bot-form-section">
        <legend>Events</legend>
        <label className="bot-form-inline">
          <input
            type="checkbox"
            checked={form.webhookEnabled}
            onChange={(e) => set({ webhookEnabled: e.target.checked })}
          />
          <span>
            Accept wake-ups from the local trigger endpoint (POST /agent/…) — the request body
            arrives as an untrusted event in this bot's chat
          </span>
        </label>
        <div className="bot-form-grid">
          <label>
            Watched folder
            <div className="bot-form-inline">
              <input value={form.watchFolder} readOnly placeholder="None" />
              <button
                type="button"
                onClick={() =>
                  void window.uld.app.pickFolder().then((res) => {
                    if (res.ok && res.data) set({ watchFolder: res.data, watchEnabled: true })
                  })
                }
              >
                Pick…
              </button>
              {form.watchFolder ? (
                <button
                  type="button"
                  onClick={() => set({ watchFolder: '', watchEnabled: false, watchGlob: '' })}
                >
                  Clear
                </button>
              ) : null}
            </div>
          </label>
          <label>
            File filter (glob, optional)
            <input
              value={form.watchGlob}
              onChange={(e) => set({ watchGlob: e.target.value })}
              placeholder="*.csv"
              maxLength={200}
              disabled={!form.watchFolder}
            />
          </label>
          <label>
            Wake on
            <select
              value={form.watchEvent}
              onChange={(e) => set({ watchEvent: e.target.value as 'created' | 'changed' })}
              disabled={!form.watchFolder}
            >
              <option value="created">New files</option>
              <option value="changed">Changed files</option>
            </select>
          </label>
          <label className="bot-form-inline">
            <input
              type="checkbox"
              checked={form.watchEnabled}
              disabled={!form.watchFolder}
              onChange={(e) => set({ watchEnabled: e.target.checked })}
            />
            <span>Watch enabled</span>
          </label>
        </div>
        <span className="bot-form-hint">
          An event is one turn in the bot's chat with its normal tools and approvals; the payload
          is wrapped as untrusted content — a guardrail, not a boundary, so keep risky tools
          approval-gated.
        </span>
        {editing ? <BotEventsInfo agent={editing} /> : null}
      </fieldset>

      {editing ? <BotRoutinesPanel agent={editing} /> : null}
      {editing ? <BindingCard agent={editing} /> : null}
      {editing ? <DeliveriesCard agent={editing} /> : null}
      {editing ? <BotSpendCard agent={editing} /> : null}
      </details>

      <div className="bot-form-actions">
        <button
          type="button"
          className="primary"
          disabled={!valid || saving || loadingAvatar}
          onClick={() => void submit()}
        >
          {saving ? 'Saving…' : editing ? 'Save' : variant === 'settings' ? 'Add agent' : 'Create bot'}
        </button>
        <button type="button" disabled={saving} onClick={() => discard(onCancel)}>
          Cancel
        </button>
        {editing ? (
          <button
            type="button"
            disabled={dreaming}
            title="Consolidate this bot's own memories (its shared-pool view is untouched)"
            onClick={() => void consolidateMemory()}
          >
            {dreaming ? 'Dreaming…' : 'Consolidate memory'}
          </button>
        ) : null}
        <span className="bot-form-hint">
          The bot reads its own memories plus the shared pool, writes only its own (Settings →
          Memory); routines are scheduled tasks run as this bot.
        </span>
      </div>
    </div>
  )
}
