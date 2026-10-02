/**
 * "Set up a personal agent" (v53, dots / Muse onboarding): name it, give it
 * a responsibility, decide how proactive it is, and point it at the sources
 * it should learn from first. Creating it opens its chat with a first
 * read-and-summarize task, so it starts by understanding before acting.
 */

import { useState, type ReactElement } from 'react'
import { unwrap } from '@/api/uld'
import ModelField from '@/components/chat/ModelField'
import { useBotsStore } from '@/stores/bots'
import { useConversationsStore } from '@/stores/conversations'
import { toastError } from '@/stores/ui'
import '@/components/agents/agent-form.css'
import '@/components/agents/personal-agent.css'

const EXAMPLES = [
  'Keep my inbox at zero: triage new mail, draft replies, flag what needs me.',
  'Plan my trips: watch prices, compare options, prepare bookings for my approval.',
  'Run my week: track deadlines and meetings, remind me early, prepare agendas.',
  'Watch my competitors: summarize pricing and product changes every morning.',
]

function personaFor(name: string, goal: string): string {
  return [
    `You are ${name}, the user's personal agent.`,
    goal ? `Your responsibility: ${goal}` : '',
    'Work like a trusted chief of staff: understand context before acting, keep the user informed ' +
      'with short, concrete updates, and track ongoing work as projects. Propose actions nobody ' +
      'asked for with suggest_action instead of doing them. Passwords, payments, account changes ' +
      'and anything irreversible are handed to the user with hand_off. Learn from feedback and ' +
      'remember the user’s preferences.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export default function AgentOnboarding({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }): ReactElement {
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('🦊')
  const [goal, setGoal] = useState('')
  const [rhythm, setRhythm] = useState('180')
  const [posture, setPosture] = useState<'read-only' | 'act'>('read-only')
  const [sources, setSources] = useState('')
  const [providerId, setProviderId] = useState<string | null>(null)
  const [modelId, setModelId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const valid = name.trim().length > 0 && goal.trim().length > 0

  const create = async (): Promise<void> => {
    if (!valid || creating) return
    setCreating(true)
    try {
      const agent = await unwrap(
        window.uld.agents.create({
          name: name.trim(),
          title: 'Personal agent',
          description: goal.trim().slice(0, 300),
          systemPrompt: personaFor(name.trim(), goal.trim()),
          goal: goal.trim(),
          providerId,
          modelId,
          avatar: emoji.trim() ? { emoji: emoji.trim(), color: null } : null,
          heartbeat: rhythm ? { everyMinutes: Number(rhythm), deliver: 'notify', posture } : null,
        })
      )
      await useBotsStore.getState().load()
      const { conversationId } = await unwrap(window.uld.bots.openChat(agent.id))
      const list = sources
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      const first = [
        'Hi! Before you take any action, learn how things work.',
        list.length > 0 ? `Read these sources first:\n${list.map((s) => `- ${s}`).join('\n')}` : '',
        'Then tell me briefly what you understood, which priorities you see, what you will keep an ' +
          'eye on, and which apps or logins you need. Record your first projects with ' +
          'update_project, and propose concrete first actions with suggest_action.',
      ]
        .filter(Boolean)
        .join('\n\n')
      await unwrap(window.uld.chat.send({ conversationId, content: first }))
      useConversationsStore.getState().select(conversationId)
      onDone()
    } catch (e) {
      toastError('Could not set up the agent', e)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="bot-form" aria-busy={creating}>
      <h3>Set up a personal agent</h3>
      <p className="bot-form-hint">
        An always-on helper that works toward one responsibility between conversations: it looks
        around on a schedule, proposes what to do, acts within your rules and hands you the steps
        that stay yours.
      </p>
      <fieldset className="bot-form-section">
        <legend>Who</legend>
        <div className="bot-form-grid">
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Concierge" maxLength={100} />
          </label>
          <label>
            Emoji
            <input value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={8} />
          </label>
        </div>
      </fieldset>
      <fieldset className="bot-form-section">
        <legend>Responsibility</legend>
        <label>
          What should it take care of?
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} maxLength={4000} placeholder={EXAMPLES[0]} />
        </label>
        <div className="pa-row">
          {EXAMPLES.map((example) => (
            <button key={example} type="button" className="btn-link" onClick={() => setGoal(example)}>
              {example.split(':')[0]}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="bot-form-section">
        <legend>Initiative</legend>
        <div className="bot-form-grid">
          <label>
            Check in on its own
            <select value={rhythm} onChange={(e) => setRhythm(e.target.value)}>
              <option value="">Never — only when I ask</option>
              <option value="60">Every hour</option>
              <option value="180">Every 3 hours</option>
              <option value="720">Twice a day</option>
            </select>
          </label>
          <label>
            When nobody asked, it may
            <select value={posture} onChange={(e) => setPosture(e.target.value as 'read-only' | 'act')} disabled={!rhythm}>
              <option value="read-only">Only look and propose (recommended)</option>
              <option value="act">Act within my rules</option>
            </select>
          </label>
        </div>
      </fieldset>
      <fieldset className="bot-form-section">
        <legend>Learn first</legend>
        <label>
          Sources to read before acting (one per line: links, notes, file paths)
          <textarea value={sources} onChange={(e) => setSources(e.target.value)} rows={3} placeholder={'https://example.com/about\nMy priorities this quarter: …'} />
        </label>
        <ModelField providerId={providerId} modelId={modelId} onChange={(p, m) => { setProviderId(p); setModelId(m) }} />
      </fieldset>
      <div className="bot-form-actions">
        <button type="button" className="primary" disabled={!valid || creating} onClick={() => void create()}>
          {creating ? 'Setting up…' : 'Create and start'}
        </button>
        <button type="button" disabled={creating} onClick={onCancel}>
          Cancel
        </button>
        <span className="bot-form-hint">
          Afterwards: connect apps (Settings → MCP servers), add channels and logins on its
          profile, and set rules in Settings → Tools.
        </span>
      </div>
    </div>
  )
}
