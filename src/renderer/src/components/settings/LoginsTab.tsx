/**
 * Settings → Logins (v53): the credential vault. Saved logins let an agent
 * sign in to a site in its browser without ever seeing the password — main
 * types it into the page. A login is shared by all agents or kept for one bot.
 * Passwords go to main once, are encrypted with the OS keystore, and are
 * never shown again.
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { BrowserLogin } from '@shared/types'
import { unwrap } from '@/api/uld'
import { ConfirmButton } from '@/components/common/controls'
import { useBotsStore } from '@/stores/bots'
import { toastError, useUiStore } from '@/stores/ui'
import './settings.css'

export default function LoginsTab(): ReactElement {
  const [logins, setLogins] = useState<BrowserLogin[]>([])
  const [origin, setOrigin] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [agentId, setAgentId] = useState('')
  const [saving, setSaving] = useState(false)
  const roster = useBotsStore((s) => s.roster)
  const bots = roster?.bots.map((row) => row.agent) ?? []

  const load = (): void => {
    void window.uld.logins.list().then((res) => {
      if (res.ok) setLogins(res.data)
    })
  }
  useEffect(() => {
    load()
    if (!roster) void useBotsStore.getState().load()
  }, [roster])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await unwrap(
        window.uld.logins.save({
          origin: origin.trim(),
          username: username.trim(),
          password,
          agentId: agentId || null,
        })
      )
      setPassword('')
      setUsername('')
      setOrigin('')
      load()
      useUiStore.getState().toast('Login saved.', 'success')
    } catch (e) {
      toastError('Could not save the login', e)
    } finally {
      setSaving(false)
    }
  }
  const remove = async (id: string): Promise<void> => {
    try {
      await unwrap(window.uld.logins.remove(id))
      load()
    } catch (e) {
      toastError('Could not delete the login', e)
    }
  }
  const botName = (id: string | null): string => (id ? (bots.find((b) => b.id === id)?.name ?? 'a deleted bot') : 'All agents')

  return (
    <section aria-label="Logins">
      <header className="tab-header">
        <div>
          <h3>Logins</h3>
          <p className="field-hint">
            Sites your agents may sign in to on your behalf. When an agent reaches a login page it
            asks the app to fill it — the password is typed into the page by Grasberg and never
            shown to the model, logged or sent anywhere else. Payments and password changes still
            stay with you.
          </p>
        </div>
      </header>

      <div className="card logins-form">
        <div className="tools-rule-form">
          <input className="input" value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="Site, e.g. https://www.opentable.com" />
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username or email" autoComplete="off" />
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoComplete="new-password" />
          <select className="select" value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Who may use it">
            <option value="">All agents</option>
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                Only {bot.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-primary" disabled={saving || !origin.trim() || !username.trim() || !password} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save login'}
          </button>
        </div>
      </div>

      {logins.length === 0 ? (
        <div className="empty-state card">
          <p>No saved logins. Without one, an agent that needs to sign in hands the step to you.</p>
        </div>
      ) : (
        <table className="tools-table">
          <thead>
            <tr>
              <th scope="col">Site</th>
              <th scope="col">Username</th>
              <th scope="col">Used by</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {logins.map((login) => (
              <tr key={login.id}>
                <td className="mono">{login.origin}</td>
                <td>{login.username}</td>
                <td>{botName(login.agentId)}</td>
                <td>
                  <ConfirmButton label="Delete" prompt="Delete this login?" onConfirm={() => remove(login.id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
