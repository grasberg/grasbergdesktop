/**
 * Settings → Bridges: run the assistant from a Telegram bot bound to a
 * conversation, POST assistant replies to a generic outbound webhook, and
 * pair a phone through the relay tunnel for full remote access. Secrets are
 * write-only (encrypted in main, never shown again).
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import QRCode from 'qrcode'
import type { ImBridgeStatus, RemoteStatus, WorkflowTriggerInfo } from '@shared/types'
import { errorMessage } from '@/api/uld'
import { usePersistSettings } from '@/hooks/usePersistSettings'
import { useConversationsStore } from '@/stores/conversations'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { confirmAction } from '@/components/common/ConfirmDialog'
import { isRemoteClient } from '@/lib/client-platform'

/**
 * A fully valid in-range port, or null. Out-of-range and half-typed input is
 * rejected, never clamped: clamping "9" (mid-retype of 9000) to 1024 would
 * rebind main's listener on a port nobody asked for and 404 every trigger URL
 * already handed out.
 */
function parsePort(draft: string): number | null {
  const trimmed = draft.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const port = Number(trimmed)
  return port >= 1024 && port <= 65_535 ? port : null
}

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
  const [portDraft, setPortDraft] = useState('')

  // Remote access (phone tunnel). The pairing QR is rendered from the offer
  // URL; the secret inside the fragment never leaves this component + main.
  const [remote, setRemote] = useState<RemoteStatus | null>(null)
  const [relayDraft, setRelayDraft] = useState('')
  const [clientDraft, setClientDraft] = useState('')
  const [qrData, setQrData] = useState<string | null>(null)
  const remoteBusy = useRef(false)

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

  // Remote access: initial read + live refresh whenever tunnel/device state
  // changes (a phone paired, went online, was revoked…).
  const refreshRemote = (): void => {
    void window.uld.remote.status().then((res) => {
      if (res.ok) setRemote(res.data)
    })
  }
  useEffect(() => {
    refreshRemote()
    return window.uld.remote.onChanged(refreshRemote)
  }, [])
  useEffect(() => {
    if (remote && relayDraft === '' && remote.relayUrl) setRelayDraft(remote.relayUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote?.relayUrl])
  useEffect(() => {
    if (remote && clientDraft === '' && remote.clientUrl) setClientDraft(remote.clientUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote?.clientUrl])
  // (Re)renders the QR whenever a pairing offer appears or changes.
  useEffect(() => {
    const url = remote?.pairing?.url
    if (!url) {
      setQrData(null)
      return
    }
    let alive = true
    void QRCode.toDataURL(url, { margin: 1, width: 220 }).then((data) => {
      if (alive) setQrData(data)
    })
    return () => {
      alive = false
    }
  }, [remote?.pairing?.url])

  // Re-read whenever the endpoint's settings change: whether it actually bound
  // (the port may be taken) is main's answer, not something the toggle knows.
  const webhookEnabled = settings?.workflowWebhookEnabled
  const webhookPort = settings?.workflowWebhookPort
  useEffect(() => {
    void window.uld.workflows.triggerInfo().then((res) => {
      if (res.ok) setTrigger(res.data)
    })
  }, [webhookEnabled, webhookPort])

  useEffect(() => {
    if (webhookPort !== undefined) setPortDraft(String(webhookPort))
  }, [webhookPort])

  // Mirrors the current render's values for the unmount commit below, which
  // would otherwise read the draft captured on the very first render.
  const latest = useRef({ portDraft, webhookPort, persist })
  useEffect(() => {
    latest.current = { portDraft, webhookPort, persist }
  })

  // The port is a draft while typing and only saved on blur/Enter: persisting
  // per keystroke rebinds main's listener on every half-typed number.
  const commitPort = (): void => {
    const port = parsePort(portDraft)
    if (port === null || port === webhookPort) {
      setPortDraft(webhookPort === undefined ? '' : String(webhookPort))
      return
    }
    setPortDraft(String(port))
    void (async () => {
      await persist({ workflowWebhookPort: port })
      // persist reports a failure only as a toast, so the store — which rolls
      // the patch back — is the one witness of what was actually saved. Leave
      // the field alone if the user has typed on since.
      const saved = useSettingsStore.getState().settings?.workflowWebhookPort
      if (saved !== port && latest.current.portDraft === String(port)) {
        setPortDraft(saved === undefined ? '' : String(saved))
      }
    })()
  }

  // Escape closes Settings from a document-level handler without moving focus,
  // so the input can unmount having never fired onBlur. Commit on the way out
  // so a typed port is not silently dropped; an invalid draft is still lost.
  useEffect(
    () => () => {
      const { portDraft: draft, webhookPort: stored, persist: save } = latest.current
      const port = parsePort(draft)
      if (port !== null && port !== stored) void save({ workflowWebhookPort: port })
    },
    [],
  )

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

  const runRemote = async (action: () => Promise<void>): Promise<void> => {
    if (remoteBusy.current) return
    remoteBusy.current = true
    try {
      await action()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      remoteBusy.current = false
    }
  }

  const saveRemote = (enabledNext: boolean): void => {
    void runRemote(async () => {
      const trimmed = relayDraft.trim()
      const client = clientDraft.trim()
      const res = await window.uld.remote.setConfig({
        enabled: enabledNext,
        // An empty draft means "not typed yet", not "clear the stored URL":
        // the field is pre-filled from status once it loads, and sending null
        // here during that window would wipe a configured relay on a stray
        // uncheck. Only an explicitly typed URL is ever sent.
        ...(trimmed ? { relayUrl: trimmed } : {}),
        ...(client ? { clientUrl: client } : {}),
      })
      if (!res.ok) throw res.error
      setRemote(res.data)
      toast(enabledNext ? 'Remote access enabled.' : 'Remote access disabled.', 'success')
    })
  }

  const openPairing = (): void => {
    void runRemote(async () => {
      const res = await window.uld.remote.pair(true)
      if (!res.ok) throw res.error
      setRemote(res.data)
    })
  }

  const cancelPairing = (): void => {
    void runRemote(async () => {
      const res = await window.uld.remote.pair(false)
      if (!res.ok) throw res.error
      setRemote(res.data)
    })
  }

  const revokeDevice = (deviceId: string): void => {
    void runRemote(async () => {
      const res = await window.uld.remote.revoke(deviceId)
      if (!res.ok) throw res.error
      setRemote(res.data)
      toast('Device revoked.', 'success')
    })
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

      <h4 className="section-subhead">Remote access (phone)</h4>
      {isRemoteClient() && <p className="callout">Pairing, revoking devices and changing access are managed on the desktop. This device can use the permissions granted there.</p>}
      <fieldset disabled={isRemoteClient()} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <p className="field-hint">
        Use the full app from your phone: conversations, live streaming, approvals. The desktop
        opens no port — it dials out to a relay you host (see relay/ in the repository), and every
        frame is end-to-end encrypted. Host the built mobile client on a separate trusted HTTPS
        origin; the relay never serves executable code. Off by default.
      </p>
      <label className="field">
        <span className="field-label">Relay URL</span>
        <input
          className="input"
          value={relayDraft}
          placeholder="https://relay.example.com"
          onChange={(e) => setRelayDraft(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">Trusted mobile client URL</span>
        <input
          className="input"
          value={clientDraft}
          placeholder="https://mobile.example.com"
          onChange={(e) => setClientDraft(e.target.value)}
        />
        <span className="field-hint">
          Deploy out/mobile here. It must be a different origin from the relay.
        </span>
      </label>
      <label className="field-checkbox">
        <input
          type="checkbox"
          checked={remote?.enabled ?? false}
          onChange={(e) => saveRemote(e.target.checked)}
        />
        <span>
          Enable remote access
          {remote ? (
            <span className="field-hint">
              {remote.enabled
                ? remote.connected
                  ? 'Connected to the relay.'
                  : remote.error
                    ? `Not connected — ${remote.error}`
                    : 'Connecting…'
                : 'Off.'}
            </span>
          ) : null}
        </span>
      </label>
      {remote?.enabled ? (
        <>
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => saveRemote(true)}>
              Save relay settings
            </button>
            <button
              type="button"
              className="btn"
              onClick={openPairing}
              disabled={!remote.connected}
            >
              Pair a device
            </button>
            {remote.pairing ? (
              <button type="button" className="btn" onClick={cancelPairing}>
                Cancel pairing
              </button>
            ) : null}
          </div>
          {remote.pairing ? (
            <div className="remote-pairing">
              {qrData ? <img className="remote-qr" src={qrData} alt="Pairing QR code" /> : null}
              <p className="field-hint">
                Scan with the phone&apos;s camera. The code works once, expires in 15 minutes, and
                the connection is end-to-end encrypted — the relay never sees the pairing secret
                or your chats.
              </p>
            </div>
          ) : null}
          {remote.devices.length > 0 ? (
            <div className="remote-devices">
              <span className="field-label">Paired devices</span>
              <ul>
                {remote.devices.map((device) => (
                  <li key={device.id}>
                    <span className={`remote-dot${device.online ? ' on' : ''}`} aria-hidden />
                    <span className="remote-device-name">{device.name}</span>
                    <span className="field-hint">
                      {device.revokedAt
                        ? 'Revoked'
                        : device.online
                          ? 'Online'
                          : device.lastSeenAt
                            ? `Last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                            : 'Never connected'}
                    </span>
                    {!device.revokedAt ? (
                      <button type="button" className="btn btn-sm" onClick={() => void runRemote(async () => {
                        const access = device.access === 'full' ? 'limited' : 'full'
                        if (access === 'full' && !await confirmAction('Grant full app access?', `Allow “${device.name}” to manage providers, bots, libraries, automation and Work on this desktop, including file changes and terminal commands? Private-space chats and stored credentials stay excluded. You can return this device to limited access here at any time.`, 'Grant full access')) return
                        const result = await window.uld.remote.setAccess(device.id, access)
                        if (!result.ok) throw result.error
                        setRemote(result.data)
                        toast(access === 'full' ? 'Full access granted to this device.' : 'Device returned to limited access.', 'success')
                      })}>{device.access === 'full' ? 'Full access · Limit access' : 'Limited · Grant full access'}</button>
                    ) : null}
                    {!device.revokedAt ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => revokeDevice(device.id)}
                      >
                        Revoke
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="field-hint">No devices paired yet.</p>
          )}
        </>
      ) : null}

      </fieldset>
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
              value={portDraft}
              onChange={(e) => setPortDraft(e.target.value)}
              onBlur={commitPort}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitPort()
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
