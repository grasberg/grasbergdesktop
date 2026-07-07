/**
 * Settings → Bridges: run the assistant from a Telegram bot bound to a
 * conversation, and POST assistant replies to a generic outbound webhook.
 * The bot token is write-only (encrypted in main, never shown again).
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { ImBridgeStatus } from '@shared/types'
import { errorMessage } from '@/api/uld'
import { useConversationsStore } from '@/stores/conversations'
import { useUiStore } from '@/stores/ui'

export default function BridgesTab(): ReactElement {
  const summaries = useConversationsStore((s) => s.summaries)
  const convLoaded = useConversationsStore((s) => s.loaded)
  const loadConversations = useConversationsStore((s) => s.load)
  const toast = useUiStore((s) => s.toast)

  const [status, setStatus] = useState<ImBridgeStatus | null>(null)
  const [token, setToken] = useState('')
  const [conversationId, setConversationId] = useState<string>('')
  const [enabled, setEnabled] = useState(false)
  const [webhook, setWebhook] = useState('')
  const [busy, setBusy] = useState(false)

  const applyStatus = (s: ImBridgeStatus): void => {
    setStatus(s)
    setConversationId(s.telegramConversationId ?? '')
    setEnabled(s.telegramEnabled)
    setWebhook(s.webhookUrl ?? '')
  }

  useEffect(() => {
    if (!convLoaded) void loadConversations()
    void window.uld.im.status().then((res) => {
      if (res.ok) applyStatus(res.data)
    })
  }, [convLoaded, loadConversations])

  const saveTelegram = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.uld.im.setTelegram({
        token: token.trim() ? token.trim() : undefined,
        conversationId: conversationId || null,
        enabled,
      })
      if (!res.ok) throw res.error
      applyStatus(res.data)
      setToken('')
      toast('Telegram bridge updated.', 'success')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const saveWebhook = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.uld.im.setWebhook(webhook.trim() ? webhook.trim() : null)
      if (!res.ok) throw res.error
      applyStatus(res.data)
      toast('Webhook updated.', 'success')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="Bridges">
      <header className="tab-header">
        <div>
          <h3>Bridges</h3>
          <p className="field-hint">
            Reach the assistant from outside the app. These are opt-in and use your own
            credentials; nothing is sent anywhere until you configure it.
          </p>
        </div>
      </header>

      <h4 className="section-subhead">Telegram bot</h4>
      <p className="field-hint">
        Create a bot with @BotFather, paste its token, pick a conversation to route messages to, and
        enable. Incoming messages run a reply in that conversation and are sent back to Telegram.
      </p>
      <label className="field">
        <span className="field-label">Bot token</span>
        <input
          className="input"
          type="password"
          value={token}
          placeholder={status?.hasToken ? '•••••• (stored — type to replace)' : '123456:ABC-DEF…'}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">Conversation</span>
        <select
          className="select"
          value={conversationId}
          onChange={(e) => setConversationId(e.target.value)}
        >
          <option value="">Select a conversation…</option>
          {summaries.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </label>
      <label className="field-checkbox">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>
          Enable the Telegram bridge
          {status ? (
            <span className="field-hint">
              {status.telegramConnected ? 'Currently running.' : 'Not running.'}
            </span>
          ) : null}
        </span>
      </label>
      {status?.telegramPairingCode ? (
        <p className="field-hint" role="status">
          <strong>Pairing code: {status.telegramPairingCode}</strong>
          <br />
          Send this code as a message to your bot from Telegram to link your chat. Only the chat
          that sends the correct code is authorized; everyone else is refused.
        </p>
      ) : null}
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void saveTelegram()}>
        Save Telegram settings
      </button>

      <h4 className="section-subhead">Outbound webhook</h4>
      <p className="field-hint">
        POST a small JSON payload (conversation id, title, message text) to this URL whenever the
        assistant finishes a reply. https:// only (http allowed for localhost).
      </p>
      <label className="field">
        <span className="field-label">Webhook URL</span>
        <input
          className="input"
          value={webhook}
          placeholder="https://example.com/hook"
          onChange={(e) => setWebhook(e.target.value)}
        />
      </label>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void saveWebhook()}>
        Save webhook
      </button>
    </section>
  )
}
