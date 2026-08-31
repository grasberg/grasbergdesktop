/**
 * Remote access service: owns the phone tunnel's lifecycle and everything a
 * phone can do with it.
 *
 * Security model, in one paragraph: the desktop makes exactly one outbound
 * connection — to the relay — and never listens. Phones reach it through that
 * relay; each one is paired by scanning a QR whose 256-bit secret is shown
 * once and kept in memory only. The phone proves the secret with an HMAC (the
 * secret never crosses the wire), and every frame after pairing is sealed
 * AES-256-GCM under a key derived from that secret, so the relay routes
 * ciphertext it cannot read. A paired phone speaks the renderer's own channel
 * dialect, gated by the router's explicit allowlist; revoking a device kills
 * its token on the relay and deletes its key locally, instantly.
 *
 * Like the trigger server, the service re-reads settings on every sync, so
 * flipping the toggle takes effect immediately and starts nothing on its own.
 */

import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import type { AppSettings, RemoteStatus } from '@shared/types'
import type { AppDatabase } from '../db/database'
import type { Keystore } from '../keys/keystore'
import { redactSecrets } from '../providers/redact'
import type { IpcHandlerMap } from '../ipc/handler-map'
import { subscribeMainEvents } from '../events'
import type {
  InnerHello,
  InnerReq,
  PairRequest,
  SealedFrame,
} from '@shared/remote-protocol'
import { PairingGuard } from './pairing'
import { RelayClient, relayWsUrl, type TunnelSocketFactory } from './relay-client'
import {
  createRemoteRouter,
  remotePushAllowed,
  REMOTE_PUSH_CHANNELS,
  type RemoteRequestInvoker,
} from './router'
import {
  deriveFrameKey,
  generateAccessToken,
  hashToken,
  keyFingerprint,
  openFrame,
  sealFrame,
} from './crypto'

const REMOTE_SCOPE = 'remote' as const
const RELAY_OWNER = 'relay'
const RELAY_TOKEN_NAME = 'token'
const DEVICE_KEY_NAME = 'frame_key'

export interface RemoteServiceDeps {
  db: AppDatabase
  keystore: Pick<Keystore, 'encryptKey' | 'decryptKey'>
  /** The same handler map ipcMain serves — the phone runs the identical code. */
  handlers: IpcHandlerMap
  appVersion: string
  socketFactory: TunnelSocketFactory
  /** Surfaced to the UI (toast) for tunnel errors. */
  notice?: (message: string, level: 'info' | 'error') => void
  /** Pushes CHANNELS.remoteChanged so the Bridges tab can refetch. */
  onChanged: () => void
}

/** The https:// origin a phone's browser opens for this relay URL, or null. */
export function relayHttpOrigin(relayUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(relayUrl)
  } catch {
    return null
  }
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:'
  const loopback =
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
  if (!secure && !(loopback && (parsed.protocol === 'http:' || parsed.protocol === 'ws:'))) {
    return null
  }
  return `${secure ? 'https' : 'http'}://${parsed.host}`
}

/** Trusted browser client URL policy (it must be separate from the relay). */
export function remoteClientUrl(input: string): string | null {
  try {
    const parsed = new URL(input)
    const loopback =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]'
    if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) return null
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

export class RemoteService {
  private readonly router: RemoteRequestInvoker
  /** False = private space; such conversations never reach a phone (v45). */
  private readonly isConversationRemotable: (conversationId: string) => boolean
  private readonly pairing: PairingGuard
  private tunnel: RelayClient | null = null
  private tunnelKey = ''
  private connected = false
  private tunnelError: string | null = null
  private readonly onlineDevices = new Set<string>()
  private readonly keyCache = new Map<string, Buffer>()
  private unsubscribeBus: (() => void) | null = null

  constructor(private readonly deps: RemoteServiceDeps) {
    this.isConversationRemotable = (id) => deps.db.conversations.getById(id)?.spaceId == null
    this.router = createRemoteRouter(deps.handlers, {
      isConversationRemotable: this.isConversationRemotable,
    })
    // Executable phone code comes from a separately trusted static origin;
    // the untrusted relay receives only transport frames.
    this.pairing = new PairingGuard((secret) => {
      const settings = deps.db.settings.get()
      const client = settings.remoteClientUrl ? remoteClientUrl(settings.remoteClientUrl) : null
      if (!client || !settings.remoteRelayUrl || !settings.remoteDesktopId) return ''
      const url = new URL(client)
      url.hash = new URLSearchParams({
        p: secret,
        relay: settings.remoteRelayUrl,
        desktop: settings.remoteDesktopId,
      }).toString()
      return url.toString()
    })
  }

  // -- lifecycle ------------------------------------------------------------

  /** Applies current settings: (re)connect the tunnel or tear it down. */
  sync(): void {
    const settings = this.deps.db.settings.get()
    const shouldRun =
      settings.remoteAccessEnabled &&
      settings.remoteRelayUrl !== null &&
      settings.remoteRelayUrl.trim().length > 0 &&
      settings.remoteClientUrl !== null &&
      remoteClientUrl(settings.remoteClientUrl) !== null &&
      relayWsUrl(settings.remoteRelayUrl) !== null &&
      process.env.SMOKE_TEST !== '1'
    if (!shouldRun) {
      this.stopTunnel()
      return
    }
    if (!settings.remoteDesktopId) {
      // Public routing id — minted once, first time the tunnel is enabled.
      // 128-bit (matches the relay's documented assumption): it gates the
      // anonymous pairing route, so it must not be guessable.
      this.deps.db.settings.update({ remoteDesktopId: randomBytes(16).toString('hex') })
    }
    // Re-read after the possible mint above: the snapshot's desktopId is
    // stale in exactly that case, and a key built from it would tear the
    // tunnel down again on the NEXT sync for no reason.
    const current = this.deps.db.settings.get()
    const key = `${current.remoteRelayUrl} ${current.remoteDesktopId}`
    if (this.tunnel && this.tunnelKey === key) return
    this.stopTunnel()
    this.tunnelKey = key
    this.tunnel = new RelayClient({
      relayUrl: current.remoteRelayUrl!,
      desktopId: current.remoteDesktopId!,
      getToken: () => this.ensureRelayToken(),
      socketFactory: this.deps.socketFactory,
      onState: (connected, error) => {
        this.connected = connected
        this.tunnelError = connected ? null : error ? redactSecrets(error) : null
        if (!connected) {
          this.onlineDevices.clear()
          this.notifyDevicesChanged()
        } else {
          // The relay forgets nothing, but a wiped/restarted relay forgets
          // device registrations — re-upsert every active device's token hash
          // so paired phones keep authenticating across relay flaps.
          this.resendDeviceRegistrations()
        }
        this.deps.onChanged()
      },
      onDeviceFrame: (deviceId, frame, fromConn) => {
        void this.handleDeviceFrame(deviceId, frame, fromConn)
      },
      onDevicePresence: (deviceId, online) => {
        if (online) {
          this.onlineDevices.add(deviceId)
          this.deps.db.remoteDevices.touch(deviceId)
        } else {
          this.onlineDevices.delete(deviceId)
        }
        this.notifyDevicesChanged()
      },
      onDevicesOnline: (deviceIds) => {
        // Replace, don't merge: the relay's snapshot is the authority on who
        // is connected RIGHT NOW, and events missed during a tunnel flap are
        // unrecoverable. Unknown ids (revoked mid-flap) simply drop out.
        this.onlineDevices.clear()
        for (const deviceId of deviceIds) {
          if (!this.deps.db.remoteDevices.getActiveById(deviceId)) continue
          this.onlineDevices.add(deviceId)
          this.deps.db.remoteDevices.touch(deviceId)
        }
        this.notifyDevicesChanged()
      },
    })
    this.tunnel.start()
    if (!this.unsubscribeBus) {
      this.unsubscribeBus = subscribeMainEvents((channel, payload) => {
        this.forwardPush(channel, payload)
      })
    }
  }

  /** Full teardown (app quit or feature disabled). */
  stopAll(): void {
    this.pairing.cancel()
    this.stopTunnel()
  }

  private stopTunnel(): void {
    this.tunnel?.stop()
    this.tunnel = null
    this.tunnelKey = ''
    this.connected = false
    this.onlineDevices.clear()
    this.keyCache.clear()
    if (this.unsubscribeBus) {
      this.unsubscribeBus()
      this.unsubscribeBus = null
    }
  }

  // -- IPC surface ------------------------------------------------------------

  status(): RemoteStatus {
    const settings = this.deps.db.settings.get()
    return {
      enabled: settings.remoteAccessEnabled,
      relayUrl: settings.remoteRelayUrl,
      clientUrl: settings.remoteClientUrl,
      connected: this.connected,
      error: this.tunnelError,
      desktopId: settings.remoteDesktopId,
      pairing: this.pairing.current(),
      devices: this.deps.db.remoteDevices.list().map((device) => ({
        ...device,
        online: this.onlineDevices.has(device.id),
      })),
    }
  }

  /**
   * Enables/disables the tunnel and/or points it at a relay. The URL policy
   * matches every outbound URL in the app: https (or wss) anywhere, plaintext
   * only on loopback — enforced here, before it is ever stored.
   */
  setConfig(input: {
    enabled: boolean
    relayUrl?: string | null
    clientUrl?: string | null
  }): RemoteStatus {
    const patch: Partial<AppSettings> = { remoteAccessEnabled: input.enabled }
    if (input.relayUrl !== undefined) {
      const trimmed = input.relayUrl?.trim() ?? ''
      if (trimmed.length === 0) {
        if (input.enabled) throw new Error('A relay URL is required to enable remote access.')
        patch.remoteRelayUrl = null
      } else {
        if (relayWsUrl(trimmed) === null) {
          throw new Error('The relay URL must be https:// (or http on localhost).')
        }
        patch.remoteRelayUrl = trimmed
      }
    }
    if (input.clientUrl !== undefined) {
      const trimmed = input.clientUrl?.trim() ?? ''
      if (trimmed.length === 0) {
        if (input.enabled) throw new Error('A trusted mobile client URL is required.')
        patch.remoteClientUrl = null
      } else {
        const normalized = remoteClientUrl(trimmed)
        if (!normalized) throw new Error('The mobile client URL must be https:// (or localhost).')
        patch.remoteClientUrl = normalized
      }
    }
    const current = this.deps.db.settings.get()
    const relay = patch.remoteRelayUrl ?? current.remoteRelayUrl
    const client = patch.remoteClientUrl ?? current.remoteClientUrl
    if (input.enabled && (!relay || !client)) {
      throw new Error('Both a relay URL and a trusted mobile client URL are required.')
    }
    if (relay && client && relayHttpOrigin(relay) === new URL(client).origin) {
      throw new Error('The mobile client must be hosted on a different origin from the relay.')
    }
    this.deps.db.settings.update(patch)
    if (!input.enabled) this.pairing.cancel()
    this.sync()
    this.deps.onChanged()
    return this.status()
  }

  /** Opens a pairing offer (QR) or cancels the current one. */
  pair(open: boolean): RemoteStatus {
    if (!open) {
      this.pairing.cancel()
      this.deps.onChanged()
      return this.status()
    }
    const settings = this.deps.db.settings.get()
    if (
      !settings.remoteAccessEnabled ||
      !settings.remoteRelayUrl ||
      !settings.remoteClientUrl ||
      !settings.remoteDesktopId
    ) {
      throw new Error('Enable remote access and connect a relay first.')
    }
    const client = remoteClientUrl(settings.remoteClientUrl)
    if (!client || relayHttpOrigin(settings.remoteRelayUrl) === new URL(client).origin) {
      throw new Error('Pairing requires a trusted mobile client on a separate origin.')
    }
    this.pairing.issue()
    this.deps.onChanged()
    return this.status()
  }

  /** Revokes one device: relay token dropped, local key deleted, session cut. */
  revokeDevice(deviceId: string): RemoteStatus {
    this.deps.db.remoteDevices.revoke(deviceId)
    this.deps.db.secrets.remove(REMOTE_SCOPE, deviceId, DEVICE_KEY_NAME)
    this.keyCache.delete(deviceId)
    this.tunnel?.send({ t: 'device-remove', deviceId })
    this.onlineDevices.delete(deviceId)
    this.deps.onChanged()
    return this.status()
  }

  // -- tunnel traffic ---------------------------------------------------------

  private async handleDeviceFrame(
    deviceId: string | null,
    frame: unknown,
    fromConn: string
  ): Promise<void> {
    if (deviceId === null) {
      this.handlePairFrame(frame, fromConn)
      return
    }
    const device = this.deps.db.remoteDevices.getActiveById(deviceId)
    if (!device) return
    const key = this.deviceKey(deviceId)
    if (!key) return
    let inner: InnerHello | InnerReq
    try {
      inner = openFrame<InnerHello | InnerReq>(key, frame as SealedFrame)
    } catch {
      // Wrong key or tampered ciphertext: nothing sane to answer.
      return
    }
    if (inner.t === 'hello') {
      this.tunnel?.sendToDevice(deviceId, sealFrame(key, { t: 'hello-res', app: { name: 'Grasberg', version: this.deps.appVersion } }))
      return
    }
    if (inner.t === 'req') {
      // The sequence is inside the authenticated ciphertext. The atomic DB
      // claim survives reconnects/restarts, so a captured mutating frame can
      // never be executed twice.
      if (!this.deps.db.remoteDevices.claimRequestSequence(deviceId, inner.seq)) return
      const result = await this.router(inner.channel, inner.args)
      this.tunnel?.sendToDevice(deviceId, sealFrame(key, { t: 'res', id: inner.id, result }))
      return
    }
    // Unknown inner types are ignored — newer phone, older desktop.
  }

  /**
   * One pairing attempt from an unauthenticated connection. Only the proof
   * arrives (never the secret); success mints the device's identity and
   * returns it SEALED, which is also the proof that both sides derived the
   * same frame key.
   */
  private handlePairFrame(frame: unknown, fromConn: string): void {
    const request = frame as PairRequest
    if (!request || request.t !== 'pair' || typeof request.proof !== 'string') return
    const verdict = this.pairing.verify(request.proof)
    if (!verdict.ok) {
      const reasons: Record<typeof verdict.reason, string> = {
        'no-offer': 'No pairing offer is open — open one in the desktop app.',
        expired: 'That pairing offer expired — open a new one in the desktop app.',
        burned: 'Too many attempts — open a new pairing offer in the desktop app.',
        wrong: 'That pairing proof is not valid.',
      }
      this.tunnel?.sendToPairConn(fromConn, { t: 'pair-error', reason: reasons[verdict.reason] })
      this.deps.onChanged()
      return
    }
    const name = typeof request.name === 'string' && request.name.trim() ? request.name.trim().slice(0, 60) : 'Phone'
    const platform = typeof request.platform === 'string' ? request.platform.slice(0, 40) : ''
    const token = generateAccessToken()
    const key = deriveFrameKey(verdict.secret)
    const device = this.deps.db.remoteDevices.create({
      name: platform ? `${name} (${platform})` : name,
      tokenHash: hashToken(token),
      keyFingerprint: keyFingerprint(key),
    })
    const { encryptedBase64 } = this.deps.keystore.encryptKey(key.toString('base64'))
    this.deps.db.secrets.set(REMOTE_SCOPE, device.id, DEVICE_KEY_NAME, encryptedBase64, device.keyFingerprint)
    this.keyCache.set(device.id, key)
    // The relay must accept the new token before the phone tries it.
    this.tunnel?.send({ t: 'device-add', deviceId: device.id, tokenHash: hashToken(token) })
    this.tunnel?.sendToPairConn(
      fromConn,
      sealFrame(key, {
        t: 'paired',
        deviceId: device.id,
        token,
        desktopName: hostname(),
      })
    )
    this.deps.notice?.(`Phone paired (${device.name}).`, 'info')
    this.deps.onChanged()
  }

  /** Forwards one bus push to every online device, sealed per device. */
  private forwardPush(channel: string, payload: unknown): void {
    if (!this.tunnel || this.onlineDevices.size === 0) return
    if (!REMOTE_PUSH_CHANNELS.has(channel)) return
    // Private-space frames (stream text, approvals, list refreshes naming the
    // conversation) are dropped before sealing — they must never leave the box.
    if (!remotePushAllowed(channel, payload, this.isConversationRemotable)) return
    for (const deviceId of this.onlineDevices) {
      const key = this.deviceKey(deviceId)
      if (!key) continue
      this.tunnel.sendToDevice(deviceId, sealFrame(key, { t: 'push', channel, payload }))
    }
  }

  private notifyDevicesChanged(): void {
    // The wiring layer pushes CHANNELS.remoteChanged (and the renderer
    // refreshes remote:status); the tunnel itself never learns about it.
    this.deps.onChanged()
  }

  /**
   * Re-upserts every active device's token hash on the relay. Idempotent by
   * construction (the relay stores hashes), sent on every tunnel connect so a
   * relay that lost its store (restart, wipe) heals without re-pairing.
   */
  private resendDeviceRegistrations(): void {
    for (const { id, tokenHash } of this.deps.db.remoteDevices.listActiveTokens()) {
      this.tunnel?.send({ t: 'device-add', deviceId: id, tokenHash })
    }
  }

  // -- secrets ----------------------------------------------------------------

  private async ensureRelayToken(): Promise<string> {
    const cipher = this.deps.db.secrets.getCipher(REMOTE_SCOPE, RELAY_OWNER, RELAY_TOKEN_NAME)
    if (cipher) return this.deps.keystore.decryptKey(cipher.encryptedValue)
    const token = generateAccessToken()
    const { encryptedBase64 } = this.deps.keystore.encryptKey(token)
    this.deps.db.secrets.set(REMOTE_SCOPE, RELAY_OWNER, RELAY_TOKEN_NAME, encryptedBase64, 'relay')
    return token
  }

  /** The device's frame key, cached after first decrypt; null when revoked. */
  private deviceKey(deviceId: string): Buffer | null {
    const cached = this.keyCache.get(deviceId)
    if (cached) return cached
    const cipher = this.deps.db.secrets.getCipher(REMOTE_SCOPE, deviceId, DEVICE_KEY_NAME)
    if (!cipher) return null
    try {
      const key = Buffer.from(this.deps.keystore.decryptKey(cipher.encryptedValue), 'base64')
      if (key.length !== 32) return null
      this.keyCache.set(deviceId, key)
      return key
    } catch {
      return null
    }
  }
}
