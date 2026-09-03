/**
 * Telegram binding (v47): a bot's own external presence — token, pairing,
 * group gating. Rendered inside the shared agent editor.
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { AgentProfile, BotBinding } from '@shared/types'
import { unwrap } from '@/api/uld'
import { ConfirmButton } from '@/components/common/controls'
import { useBotsStore } from '@/stores/bots'
import { toastError } from '@/stores/ui'
import '@/components/agents/agent-form.css'

export default function BindingCard({ agent }: { agent: AgentProfile }): ReactElement {
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
