/**
 * Settings → Bridges: run the assistant from a Telegram bot bound to a
 * conversation, and POST assistant replies to a generic outbound webhook.
 * The bot token is write-only (encrypted in main, never shown again).
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { ImBridgeStatus, WorkflowTriggerInfo } from '@shared/types'
import { errorMessage } from '@/api/uld'
import { usePersistSettings } from '@/hooks/usePersistSettings'
import { useConversationsStore } from '@/stores/conversations'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

export default function BridgesTab(): ReactElement {
  const summaries = useConversationsStore((s) => s.summaries)
  const convLoaded = useConversationsStore((s) => s.loaded)
  const loadConversations = useConversationsStore((s) => s.load)
  const toast = useUiStore((s) => s.toast)
  const settings = useSettingsStore((s) => s.settings)
  const persist = usePersistSettings()

  const [status, setStatus] = useState<ImBridgeStatus | null>(null)
  const [token, setToken] = useState('')
  const [conversationId, setConversationId] = useState<string>('')
  const [enabled, setEnabled] = useState(false)
  const [webhook, setWebhook] = useState('')
  const [busy, setBusy] = useState(false)
  const [trigger, setTrigger] = useState<WorkflowTriggerInfo | null>(null)

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

  // Re-read whenever the endpoint's settings change: whether it actually bound
  // (the port may be taken) is main's answer, not something the toggle knows.
  const webhookEnabled = settings?.workflowWebhookEnabled
  const webhookPort = settings?.workflowWebhookPort
  useEffect(() => {
    void window.uld.workflows.triggerInfo().then((res) => {
      if (res.ok) setTrigger(res.data)
    })
  }, [webhookEnabled, webhookPort])

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

      <h4 className="section-subhead">Approve from Telegram</h4>
      <p className="field-hint">
        Off by default. When on, a tool call waiting for approval is also sent to the paired chat
        with Allow/Deny buttons — so a scheduled task can ask instead of failing while you are
        away. Answer on either surface; the first one wins. Only the paired chat is obeyed, and an
        unanswered request is declined after three minutes.
      </p>
      <label className="field-checkbox">
        <input
          type="checkbox"
          checked={settings?.remoteApprovalsEnabled ?? false}
          disabled={!status?.telegramConnected}
          onChange={(e) => void persist({ remoteApprovalsEnabled: e.target.checked })}
        />
        <span>
          Let me approve tool calls from Telegram
          {!status?.telegramConnected ? (
            <span className="field-hint">Connect and pair the bridge above first.</span>
          ) : null}
        </span>
      </label>

      <h4 className="section-subhead">Trigger endpoint (incoming)</h4>
      <p className="field-hint">
        The other direction: lets an outside event start a workflow — a git hook, a CI job, a
        script. Off by default. It listens on 127.0.0.1 only (nothing on your network can reach
        it), requires the token below, and starts only the workflows you switched on individually
        in the workflow builder.
      </p>
      <label className="field-checkbox">
        <input
          type="checkbox"
          checked={settings?.workflowWebhookEnabled ?? false}
          onChange={(e) => void persist({ workflowWebhookEnabled: e.target.checked })}
        />
        <span>
          Accept workflow triggers on this machine
          {trigger && settings?.workflowWebhookEnabled ? (
            <span className="field-hint">
              {trigger.running ? `Listening on 127.0.0.1:${trigger.port}.` : 'Not listening.'}
            </span>
          ) : null}
        </span>
      </label>
      {settings?.workflowWebhookEnabled ? (
        <>
          <label className="field">
            <span className="field-label">Port</span>
            <input
              className="input"
              type="number"
              min={1024}
              max={65535}
              value={settings.workflowWebhookPort}
              onChange={(e) => {
                const port = Number.parseInt(e.target.value, 10)
                if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
                  void persist({ workflowWebhookPort: port })
                }
              }}
            />
          </label>
          <label className="field">
            <span className="field-label">URL to POST to</span>
            {/* Read-only: the token is shown here and nowhere else, so it never
                has to be copied out of a settings file or a backup. */}
            <input
              className="input mono"
              readOnly
              value={trigger?.url ?? 'Not listening.'}
              onFocus={(e) => e.currentTarget.select()}
            />
            <p className="field-hint">
              Replace <code>&lt;workflow-id&gt;</code> with the id shown in the workflow builder.
              The request body is handed to the workflow&apos;s Input node.
            </p>
          </label>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void (async () => {
                const res = await window.uld.workflows.triggerRegenerate()
                if (res.ok) {
                  setTrigger(res.data)
                  toast('New token issued — old URLs stopped working.', 'success')
                } else {
                  toast(errorMessage(res.error), 'error')
                }
              })()
            }}
          >
            Issue a new token
          </button>
        </>
      ) : null}

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
