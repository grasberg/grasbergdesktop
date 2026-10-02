/**
 * Personal-agent panel (v53): everything that makes a bot a dots / Grok Bot /
 * Muse-style personal agent, shown on a saved bot's profile above the
 * advanced settings:
 *
 * - status: paused (by you or by the anomaly monitor) · pause / resume / reset
 * - "Needs you": open suggestions from proactive work and steps handed to you
 * - projects the bot tracks toward its goal
 * - its computer: live view of its browser, take over / hand back, and
 *   teach-a-task (record a demonstration → a reusable skill)
 * - channels: Slack, Discord and its own email address
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type {
  AgentProfile,
  BotChannel,
  BotChannelKind,
  BotProject,
  BotProjectStatus,
  BotSuggestion,
  BrowserFrame,
  TeachStatus,
} from '@shared/types'
import { unwrap } from '@/api/uld'
import { relativeTime } from '@/lib/format'
import { confirmAction } from '@/components/common/ConfirmDialog'
import { useBotsStore } from '@/stores/bots'
import { toastError, useUiStore } from '@/stores/ui'
import './personal-agent.css'

const toast = (message: string, kind: 'info' | 'success' | 'error' = 'info'): void =>
  useUiStore.getState().toast(message, kind)

// ---------------------------------------------------------------------------
// Status: pause / resume / reset
// ---------------------------------------------------------------------------

function StatusBar({ agent }: { agent: AgentProfile }): ReactElement {
  const [busy, setBusy] = useState(false)
  const run = async (what: 'pause' | 'resume' | 'reset'): Promise<void> => {
    if (what === 'reset') {
      const ok = await confirmAction(
        `Reset ${agent.name}?`,
        'Its chat, its own memories, its routines, projects and suggestions are deleted. The profile, persona, model, tools, channels and logins stay.',
        'Reset'
      )
      if (!ok) return
    }
    setBusy(true)
    try {
      if (what === 'pause') await unwrap(window.uld.bots.pause(agent.id))
      if (what === 'resume') await unwrap(window.uld.bots.resume(agent.id))
      if (what === 'reset') {
        await unwrap(window.uld.bots.reset(agent.id))
        toast(`${agent.name} starts fresh.`, 'success')
      }
      await useBotsStore.getState().load()
    } catch (e) {
      toastError(`Could not ${what} ${agent.name}`, e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={`pa-status${agent.paused ? ' paused' : ''}`}>
      <span className="pa-status-text">
        {agent.paused
          ? agent.pausedReason
            ? `⏸ ${agent.pausedReason}`
            : '⏸ Paused — no heartbeats, routines, deliveries or channel replies until you resume.'
          : '● Active — works between conversations within your rules.'}
      </span>
      <div className="pa-status-actions">
        {agent.paused ? (
          <button type="button" className="primary" disabled={busy} onClick={() => void run('resume')}>
            Resume
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => void run('pause')}>
            Pause
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => void run('reset')}>
          Reset…
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Needs you: suggestions + handoffs
// ---------------------------------------------------------------------------

export function SuggestionList({
  items,
  onChanged,
  showAgent,
}: {
  items: BotSuggestion[]
  onChanged: () => void
  showAgent?: (agentId: string | null) => string | null
}): ReactElement {
  const [busy, setBusy] = useState<string | null>(null)
  const act = async (item: BotSuggestion, accept: boolean): Promise<void> => {
    setBusy(item.id)
    try {
      if (accept) await unwrap(window.uld.bots.acceptSuggestion(item.id))
      else await unwrap(window.uld.bots.dismissSuggestion(item.id))
      onChanged()
    } catch (e) {
      toastError(accept ? 'Could not accept' : 'Could not dismiss', e)
    } finally {
      setBusy(null)
    }
  }
  const takeOver = async (item: BotSuggestion): Promise<void> => {
    try {
      await unwrap(window.uld.computer.takeOver(item.agentId))
    } catch (e) {
      toastError('Could not open the browser', e)
    }
  }
  return (
    <ul className="pa-suggestions">
      {items.map((item) => {
        const who = showAgent?.(item.agentId)
        return (
          <li key={item.id} className={`pa-suggestion kind-${item.kind}`}>
            <div className="pa-suggestion-head">
              <span className="pa-suggestion-kind">{item.kind === 'handoff' ? '✋ Your turn' : '💡 Suggestion'}</span>
              {who ? <span className="pa-suggestion-who">{who}</span> : null}
              <strong>{item.title}</strong>
              <time>{relativeTime(item.createdAt)}</time>
            </div>
            {item.reason ? <p className="pa-suggestion-reason">{item.reason}</p> : null}
            <p className="pa-suggestion-action">{item.action}</p>
            <div className="pa-suggestion-buttons">
              {item.kind === 'handoff' ? (
                <>
                  <button type="button" onClick={() => void takeOver(item)}>
                    Open agent browser
                  </button>
                  <button type="button" className="primary" disabled={busy === item.id} onClick={() => void act(item, true)}>
                    I did it
                  </button>
                </>
              ) : (
                <button type="button" className="primary" disabled={busy === item.id} onClick={() => void act(item, true)}>
                  Approve
                </button>
              )}
              <button type="button" disabled={busy === item.id} onClick={() => void act(item, false)}>
                Dismiss
              </button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function NeedsYouCard({ agent }: { agent: AgentProfile }): ReactElement | null {
  const [items, setItems] = useState<BotSuggestion[]>([])
  const load = useCallback((): void => {
    void window.uld.bots.suggestions(agent.id).then((res) => {
      if (res.ok) setItems(res.data.filter((s) => s.status === 'open'))
    })
  }, [agent.id])
  useEffect(() => {
    load()
    const offA = window.uld.bots.onSuggestionsChanged(() => load())
    const offB = window.uld.bots.onChanged(() => load())
    return () => {
      offA()
      offB()
    }
  }, [load])
  if (items.length === 0) return null
  return (
    <div className="pa-card">
      <h4>Needs you ({items.length})</h4>
      <SuggestionList items={items} onChanged={load} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const PROJECT_STATUS: BotProjectStatus[] = ['active', 'waiting', 'blocked', 'done']

function ProjectsCard({ agent }: { agent: AgentProfile }): ReactElement {
  const [projects, setProjects] = useState<BotProject[]>([])
  const load = useCallback((): void => {
    void window.uld.bots.projects(agent.id).then((res) => {
      if (res.ok) setProjects(res.data)
    })
  }, [agent.id])
  useEffect(() => {
    load()
    return window.uld.bots.onChanged(() => load())
  }, [load])
  const update = async (id: string, patch: { status?: BotProjectStatus }): Promise<void> => {
    try {
      await unwrap(window.uld.bots.updateProject(id, patch))
      load()
    } catch (e) {
      toastError('Could not update the project', e)
    }
  }
  const remove = async (id: string): Promise<void> => {
    try {
      await unwrap(window.uld.bots.deleteProject(id))
      load()
    } catch (e) {
      toastError('Could not delete the project', e)
    }
  }
  return (
    <div className="pa-card">
      <h4>Projects</h4>
      {projects.length === 0 ? (
        <p className="bot-form-hint">
          No projects yet. Give {agent.name} a goal and multi-step work — it tracks progress here
          with its update_project tool.
        </p>
      ) : (
        <ul className="pa-projects">
          {projects.map((project) => (
            <li key={project.id} className={`pa-project status-${project.status}`}>
              <div className="pa-project-head">
                <strong>{project.title}</strong>
                <select
                  value={project.status}
                  aria-label={`Status of ${project.title}`}
                  onChange={(e) => void update(project.id, { status: e.target.value as BotProjectStatus })}
                >
                  {PROJECT_STATUS.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
                <time>{relativeTime(project.updatedAt)}</time>
                <button type="button" className="btn-link" onClick={() => void remove(project.id)}>
                  Remove
                </button>
              </div>
              {project.summary ? <p>{project.summary}</p> : null}
              {project.nextStep ? <p className="pa-project-next">Next: {project.nextStep}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Its computer: live view, take over, teach a task
// ---------------------------------------------------------------------------

export function ComputerView({ agentId, label }: { agentId: string | null; label: string }): ReactElement {
  const [frame, setFrame] = useState<BrowserFrame | null>(null)
  const [watching, setWatching] = useState(false)
  const [teach, setTeach] = useState<TeachStatus | null>(null)
  const [teachUrl, setTeachUrl] = useState('')
  const [skillName, setSkillName] = useState('')
  const [skillAbout, setSkillAbout] = useState('')
  const [saving, setSaving] = useState(false)
  const timer = useRef<number | null>(null)

  const refresh = useCallback((): void => {
    void window.uld.computer.frame(agentId).then((res) => {
      if (res.ok) setFrame(res.data)
    })
  }, [agentId])

  useEffect(() => {
    refresh()
    void window.uld.teach.status().then((res) => {
      if (res.ok) setTeach(res.data && res.data.agentId === agentId ? res.data : null)
    })
    const offControl = window.uld.computer.onControl((event) => {
      if (event.agentId === agentId) refresh()
    })
    const offTeach = window.uld.teach.onChanged((status) =>
      setTeach(status && status.agentId === agentId ? status : null)
    )
    return () => {
      offControl()
      offTeach()
    }
  }, [agentId, refresh])

  useEffect(() => {
    if (!watching && !teach) return
    timer.current = window.setInterval(refresh, 1500)
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current)
      timer.current = null
    }
  }, [watching, teach, refresh])

  const takeOver = async (): Promise<void> => {
    try {
      await unwrap(window.uld.computer.takeOver(agentId))
      setWatching(true)
      refresh()
    } catch (e) {
      toastError('Could not take over', e)
    }
  }
  const handBack = async (): Promise<void> => {
    try {
      await unwrap(window.uld.computer.returnControl(agentId))
      refresh()
    } catch (e) {
      toastError('Could not hand back control', e)
    }
  }
  const startTeach = async (): Promise<void> => {
    try {
      const status = await unwrap(window.uld.teach.start(agentId, teachUrl.trim() || null))
      setTeach(status)
      toast('Recording — do the task in the window that opened, then come back and save it.', 'success')
    } catch (e) {
      toastError('Could not start recording', e)
    }
  }
  const stopTeach = async (cancel: boolean): Promise<void> => {
    setSaving(true)
    try {
      const skill = await unwrap(
        window.uld.teach.stop(cancel ? { cancel: true } : { name: skillName.trim(), description: skillAbout.trim() })
      )
      setTeach(null)
      setSkillName('')
      setSkillAbout('')
      if (skill) toast(`Skill "${skill.name}" saved — any agent can use it now.`, 'success')
    } catch (e) {
      toastError('Could not save the skill', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="pa-computer">
      <div className="pa-computer-screen">
        {frame?.dataUrl ? (
          <img src={frame.dataUrl} alt={`${label} — ${frame.title || frame.url}`} />
        ) : (
          <div className="pa-computer-empty">{frame?.open ? 'Loading…' : 'The browser is not open right now.'}</div>
        )}
        {frame?.userControl ? <span className="pa-computer-badge">You are in control</span> : null}
      </div>
      {frame?.open ? <p className="bot-form-hint pa-computer-url">{frame.title ? `${frame.title} — ` : ''}{frame.url}</p> : null}
      <div className="pa-row">
        <button type="button" onClick={() => setWatching((w) => !w)}>
          {watching ? 'Stop watching' : 'Watch live'}
        </button>
        {frame?.userControl ? (
          <button type="button" className="primary" onClick={() => void handBack()}>
            Hand back control
          </button>
        ) : (
          <button type="button" onClick={() => void takeOver()}>
            Take over
          </button>
        )}
      </div>
      <div className="pa-teach">
        <h5>Teach a task</h5>
        {teach ? (
          <>
            <p className="bot-form-hint">
              Recording since {relativeTime(teach.startedAt)}. Click through the task in the agent
              window (passwords are never recorded), then name the skill.
            </p>
            <div className="pa-row">
              <input value={skillName} onChange={(e) => setSkillName(e.target.value)} placeholder="Skill name, e.g. export-monthly-report" maxLength={100} />
            </div>
            <div className="pa-row">
              <input value={skillAbout} onChange={(e) => setSkillAbout(e.target.value)} placeholder="What it is for (optional)" maxLength={1024} />
            </div>
            <div className="pa-row">
              <button type="button" className="primary" disabled={saving || !skillName.trim()} onClick={() => void stopTeach(false)}>
                {saving ? 'Saving…' : 'Stop & save skill'}
              </button>
              <button type="button" disabled={saving} onClick={() => void stopTeach(true)}>
                Discard
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="bot-form-hint">
              Show it once: the agent's browser opens for you, Grasberg records your clicks and
              typing, and turns them into a reusable skill.
            </p>
            <div className="pa-row">
              <input value={teachUrl} onChange={(e) => setTeachUrl(e.target.value)} placeholder="Start page (optional), https://…" />
              <button type="button" onClick={() => void startTeach()}>
                Start recording
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ComputerCard({ agent }: { agent: AgentProfile }): ReactElement {
  return (
    <div className="pa-card">
      <h4>{agent.name}'s computer</h4>
      <ComputerView agentId={agent.id} label={`${agent.name}'s browser`} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Channels: Slack, Discord, email
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<BotChannelKind, string> = { slack: 'Slack', discord: 'Discord', email: 'Email' }

function splitList(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((v) => v.trim())
    .filter(Boolean)
}

function ChannelEditor({
  agent,
  kind,
  existing,
  onDone,
}: {
  agent: AgentProfile
  kind: BotChannelKind
  existing: BotChannel | null
  onDone: () => void
}): ReactElement {
  const config = (existing?.config ?? {}) as Record<string, unknown>
  const str = (key: string, fallback = ''): string => (typeof config[key] === 'string' ? (config[key] as string) : fallback)
  const num = (key: string, fallback: number): string => String(typeof config[key] === 'number' ? config[key] : fallback)
  const list = (key: string): string => (Array.isArray(config[key]) ? (config[key] as string[]).join(', ') : '')
  const [fields, setFields] = useState({
    botToken: '',
    appToken: '',
    password: '',
    allowedChannels: list('allowedChannels'),
    mentionOnly: config.mentionOnly !== false,
    address: str('address'),
    displayName: str('displayName', agent.name),
    imapHost: str('imapHost'),
    imapPort: num('imapPort', 993),
    smtpHost: str('smtpHost'),
    smtpPort: num('smtpPort', 465),
    smtpSecurity: str('smtpSecurity', 'tls'),
    username: str('username'),
    allowedSenders: list('allowedSenders'),
    pollMinutes: num('pollMinutes', 2),
  })
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<typeof fields>): void => setFields((f) => ({ ...f, ...patch }))

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const secrets: Record<string, string> = {}
      if (fields.botToken.trim()) secrets.botToken = fields.botToken.trim()
      if (fields.appToken.trim()) secrets.appToken = fields.appToken.trim()
      if (fields.password) secrets.password = fields.password
      const cfg: Record<string, unknown> =
        kind === 'email'
          ? {
              address: fields.address.trim(),
              displayName: fields.displayName.trim(),
              imapHost: fields.imapHost.trim(),
              imapPort: Number(fields.imapPort),
              smtpHost: fields.smtpHost.trim(),
              smtpPort: Number(fields.smtpPort),
              smtpSecurity: fields.smtpSecurity,
              username: fields.username.trim() || fields.address.trim(),
              allowedSenders: splitList(fields.allowedSenders).map((s) => s.toLowerCase()),
              pollMinutes: Number(fields.pollMinutes),
            }
          : { allowedChannels: splitList(fields.allowedChannels), mentionOnly: fields.mentionOnly }
      if (existing) await unwrap(window.uld.channels.update(existing.id, { config: cfg, secrets }))
      else await unwrap(window.uld.channels.create({ agentId: agent.id, kind, config: cfg, secrets }))
      onDone()
    } catch (e) {
      toastError(`Could not save the ${KIND_LABEL[kind]} channel`, e)
    } finally {
      setSaving(false)
    }
  }

  const has = (name: string): boolean => existing?.secretNames.includes(name) ?? false
  return (
    <div className="pa-channel-editor">
      {kind === 'slack' ? (
        <>
          <p className="bot-form-hint">
            Create a Slack app with Socket Mode on, bot scopes chat:write, im:history,
            app_mentions:read (+ users:read), and events message.im + app_mention. Install it, then
            paste both tokens.
          </p>
          <input type="password" value={fields.botToken} onChange={(e) => set({ botToken: e.target.value })} placeholder={has('botToken') ? 'Bot token saved — paste to replace' : 'Bot token (xoxb-…)'} />
          <input type="password" value={fields.appToken} onChange={(e) => set({ appToken: e.target.value })} placeholder={has('appToken') ? 'App token saved — paste to replace' : 'App-level token (xapp-…)'} />
        </>
      ) : null}
      {kind === 'discord' ? (
        <>
          <p className="bot-form-hint">
            In the Discord developer portal: create an application, add a bot, enable the MESSAGE
            CONTENT intent, invite it to your server, and paste its token.
          </p>
          <input type="password" value={fields.botToken} onChange={(e) => set({ botToken: e.target.value })} placeholder={has('botToken') ? 'Bot token saved — paste to replace' : 'Bot token'} />
        </>
      ) : null}
      {kind === 'slack' || kind === 'discord' ? (
        <>
          <input value={fields.allowedChannels} onChange={(e) => set({ allowedChannels: e.target.value })} placeholder="Approved channel ids (comma separated, optional)" />
          <label className="bot-form-inline">
            <input type="checkbox" checked={fields.mentionOnly} onChange={(e) => set({ mentionOnly: e.target.checked })} />
            <span>In channels, answer only when @mentioned</span>
          </label>
        </>
      ) : null}
      {kind === 'email' ? (
        <>
          <p className="bot-form-hint">
            Give {agent.name} a mailbox (a new address is best, or your own with an app password).
            Only mail from the senders you list becomes a task; replies are threaded. Reading
            never marks mail as read.
          </p>
          <div className="pa-grid">
            <input value={fields.address} onChange={(e) => set({ address: e.target.value })} placeholder="Address, e.g. concierge@example.com" />
            <input value={fields.displayName} onChange={(e) => set({ displayName: e.target.value })} placeholder="Display name" />
            <input value={fields.imapHost} onChange={(e) => set({ imapHost: e.target.value })} placeholder="IMAP host, e.g. imap.gmail.com" />
            <input value={fields.imapPort} onChange={(e) => set({ imapPort: e.target.value })} placeholder="993" />
            <input value={fields.smtpHost} onChange={(e) => set({ smtpHost: e.target.value })} placeholder="SMTP host, e.g. smtp.gmail.com" />
            <input value={fields.smtpPort} onChange={(e) => set({ smtpPort: e.target.value })} placeholder="465" />
            <select value={fields.smtpSecurity} onChange={(e) => set({ smtpSecurity: e.target.value })}>
              <option value="tls">SMTP over TLS (465)</option>
              <option value="starttls">STARTTLS (587)</option>
            </select>
            <input value={fields.username} onChange={(e) => set({ username: e.target.value })} placeholder="Username (defaults to the address)" />
            <input type="password" value={fields.password} onChange={(e) => set({ password: e.target.value })} placeholder={has('password') ? 'Password saved — type to replace' : 'App password'} />
            <select value={fields.pollMinutes} onChange={(e) => set({ pollMinutes: e.target.value })}>
              <option value="1">Check every minute</option>
              <option value="2">Every 2 minutes</option>
              <option value="5">Every 5 minutes</option>
              <option value="15">Every 15 minutes</option>
            </select>
          </div>
          <input value={fields.allowedSenders} onChange={(e) => set({ allowedSenders: e.target.value })} placeholder="Senders it takes tasks from, e.g. you@example.com" />
        </>
      ) : null}
      <div className="pa-row">
        <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : existing ? 'Save' : `Add ${KIND_LABEL[kind]}`}
        </button>
        <button type="button" disabled={saving} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function ChannelsCard({ agent }: { agent: AgentProfile }): ReactElement {
  const [channels, setChannels] = useState<BotChannel[]>([])
  const [editing, setEditing] = useState<{ kind: BotChannelKind; existing: BotChannel | null } | null>(null)
  const load = useCallback((): void => {
    void window.uld.channels.list(agent.id).then((res) => {
      if (res.ok) setChannels(res.data)
    })
  }, [agent.id])
  useEffect(() => {
    load()
    return window.uld.bots.onChanged((event) => {
      if (!event.agentId || event.agentId === agent.id) load()
    })
  }, [agent.id, load])
  const remove = async (channel: BotChannel): Promise<void> => {
    if (!(await confirmAction(`Remove ${KIND_LABEL[channel.kind]}?`, 'Its stored credentials are deleted too.', 'Remove'))) return
    try {
      await unwrap(window.uld.channels.remove(channel.id))
      load()
    } catch (e) {
      toastError('Could not remove the channel', e)
    }
  }
  const toggle = async (channel: BotChannel): Promise<void> => {
    try {
      await unwrap(window.uld.channels.update(channel.id, { enabled: !channel.enabled }))
      load()
    } catch (e) {
      toastError('Could not update the channel', e)
    }
  }
  const repair = async (channel: BotChannel): Promise<void> => {
    try {
      await unwrap(window.uld.channels.repair(channel.id))
      load()
    } catch (e) {
      toastError('Could not reset pairing', e)
    }
  }
  const missing = (['slack', 'discord', 'email'] as BotChannelKind[]).filter((kind) => !channels.some((c) => c.kind === kind))
  return (
    <div className="pa-card">
      <h4>Channels</h4>
      <p className="bot-form-hint">
        Talk to {agent.name} from Slack, Discord or email (Telegram is under advanced settings).
        Only you — and channels you approve — can give it work.
      </p>
      <ul className="pa-channels">
        {channels.map((channel) => (
          <li key={channel.id} className={`pa-channel status-${channel.status}`}>
            <div className="pa-row">
              <strong>{KIND_LABEL[channel.kind]}</strong>
              <span className="pa-channel-status">
                {channel.status}
                {channel.statusDetail ? ` — ${channel.statusDetail}` : ''}
              </span>
              <button type="button" className="btn-link" onClick={() => void toggle(channel)}>
                {channel.enabled ? 'Disable' : 'Enable'}
              </button>
              <button type="button" className="btn-link" onClick={() => setEditing({ kind: channel.kind, existing: channel })}>
                Edit
              </button>
              {channel.kind !== 'email' ? (
                <button type="button" className="btn-link" onClick={() => void repair(channel)}>
                  New pairing code
                </button>
              ) : null}
              <button type="button" className="btn-link" onClick={() => void remove(channel)}>
                Remove
              </button>
            </div>
            {channel.pairingCode ? (
              <p className="bot-binding-code">
                Send <code>{channel.pairingCode}</code> to the bot in a direct message from your own account to pair.
              </p>
            ) : channel.kind !== 'email' && channel.paired ? (
              <p className="bot-form-hint">Paired with your account.</p>
            ) : null}
          </li>
        ))}
      </ul>
      {editing ? (
        <ChannelEditor
          agent={agent}
          kind={editing.kind}
          existing={editing.existing}
          onDone={() => {
            setEditing(null)
            load()
          }}
        />
      ) : (
        <div className="pa-row">
          {missing.map((kind) => (
            <button key={kind} type="button" onClick={() => setEditing({ kind, existing: null })}>
              + {KIND_LABEL[kind]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

export default function PersonalAgentPanel({ agent }: { agent: AgentProfile }): ReactElement {
  return (
    <div className="pa-panel">
      <StatusBar agent={agent} />
      <NeedsYouCard agent={agent} />
      <ProjectsCard agent={agent} />
      <ComputerCard agent={agent} />
      <ChannelsCard agent={agent} />
    </div>
  )
}
