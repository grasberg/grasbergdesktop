/**
 * Outbound relay tunnel: one WebSocket from the desktop to the relay, held
 * open with reconnect/backoff. The relay routes three kinds of traffic over
 * it — frames to/from paired phones, pairing-role frames, and HTTP asset
 * requests for the phone's browser — all defined in @shared/remote-protocol.
 *
 * The desktop NEVER listens: this connection out is the whole network surface
 * of remote access, which is what lets it work behind CGNAT and firewalls.
 *
 * Send semantics are best-effort: a frame written while the socket is down is
 * dropped, not queued. Phones resynchronize by re-requesting state on
 * reconnect (the mobile store treats every push as a hint, requests as
 * truth), so losslessness here would only hide latency.
 */

import { REMOTE_PROTOCOL_VERSION, type RelayHelloDesktop } from '@shared/remote-protocol'

/** Narrow slice of the `ws` WebSocket the client needs (injectable in tests). */
export interface TunnelSocket {
  send(data: string): void
  close(): void
  terminate(): void
  on(event: 'open', cb: () => void): void
  on(event: 'close', cb: (code: number, reason: Buffer) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  on(event: 'message', cb: (data: unknown) => void): void
  on(event: 'pong', cb: () => void): void
  ping(): void
}

export type TunnelSocketFactory = (url: string) => TunnelSocket

export interface RelayClientDeps {
  /** Relay base URL (https/wss, or http/ws for loopback testing). */
  relayUrl: string
  desktopId: string
  /** Resolves the stored relay auth token (minting it on first call). */
  getToken: () => Promise<string>
  onState: (connected: boolean, error: string | null) => void
  /** A frame arrived from a phone (deviceId null = pairing-role connection). */
  onDeviceFrame: (deviceId: string | null, frame: unknown, fromConn: string) => void
  /** Relay saw a paired device connect/disconnect. */
  onDevicePresence: (deviceId: string, online: boolean) => void
  /**
   * The relay's snapshot of which devices are online right now — sent after
   * every (re)connect. Replaces the local online set wholesale, because
   * device-online/offline events missed during a tunnel flap are gone.
   */
  onDevicesOnline: (deviceIds: string[]) => void
  /** The phone's browser asked for a bundle asset. */
  onHttp: (req: { reqId: string; method: string; path: string }) => void
  socketFactory: TunnelSocketFactory
  /** Reconnect backoff base in milliseconds; small in tests, default 3 s. */
  backoffBaseMs?: number
}

const CONNECT_TIMEOUT_MS = 15_000
const PING_INTERVAL_MS = 30_000
const PONG_TIMEOUT_MS = 10_000
const BACKOFF_BASE_MS = 3_000
const BACKOFF_MAX_MS = 60_000

/** Normalizes a relay base URL to the WebSocket endpoint URL. */
export function relayWsUrl(relayUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(relayUrl)
  } catch {
    return null
  }
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:'
  const insecureLoopback =
    (parsed.protocol === 'http:' || parsed.protocol === 'ws:') &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]')
  if (!secure && !insecureLoopback) return null
  const wsProtocol = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'wss' : 'ws'
  return `${wsProtocol}://${parsed.host}/ws`
}

export class RelayClient {
  private socket: TunnelSocket | null = null
  private stopped = false
  private failures = 0
  private connectTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private pongTimer: NodeJS.Timeout | null = null
  private gotPong = false
  private error: string | null = null

  constructor(private readonly deps: RelayClientDeps) {}

  get connected(): boolean {
    return this.socket !== null
  }

  /** Starts the connect/reconnect loop (no-op if already running). */
  start(): void {
    if (this.socket || this.stopped) return
    this.stopped = false
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    if (this.socket) {
      const socket = this.socket
      this.socket = null
      this.deps.onState(false, null)
      try {
        socket.close()
      } catch {
        // Teardown only.
      }
    }
  }

  /** Sends one raw relay frame; dropped when the tunnel is down. */
  send(frame: unknown): void {
    if (!this.socket) return
    try {
      this.socket.send(JSON.stringify(frame))
    } catch {
      // A dead socket is replaced by the reconnect loop.
    }
  }

  /** Routes one frame to a specific device. */
  sendToDevice(deviceId: string, frame: unknown): void {
    this.send({ t: 'to', deviceId, frame })
  }

  /** Replies to an unauthenticated pairing connection by its relay id. */
  sendToPairConn(connId: string, frame: unknown): void {
    this.send({ t: 'to-pair', connId, frame })
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    const url = relayWsUrl(this.deps.relayUrl)
    if (!url) {
      this.error = 'The relay URL is not valid (it must be https://, or http on localhost).'
      this.deps.onState(false, this.error)
      return
    }
    let token: string
    try {
      token = await this.deps.getToken()
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Could not read the relay credential.'
      this.deps.onState(false, this.error)
      return
    }
    if (this.stopped) return
    const socket = this.deps.socketFactory(url)
    let settled = false
    const connectTimer = setTimeout(() => {
      if (!settled) {
        settled = true
        try {
          socket.terminate()
        } catch {
          // Already gone.
        }
        this.onDisconnected('The relay did not answer in time.')
      }
    }, CONNECT_TIMEOUT_MS)
    connectTimer.unref?.()

    socket.on('open', () => {
      if (this.stopped) {
        socket.terminate()
        return
      }
      settled = true
      clearTimeout(connectTimer)
      this.socket = socket
      this.failures = 0
      this.error = null
      const hello: RelayHelloDesktop = {
        v: REMOTE_PROTOCOL_VERSION,
        t: 'hello',
        role: 'desktop',
        desktopId: this.deps.desktopId,
        token,
      }
      socket.send(JSON.stringify(hello))
      this.deps.onState(true, null)
      this.startPing()
    })
    socket.on('message', (data) => {
      if (this.socket !== socket) return
      this.handleMessage(typeof data === 'string' ? data : String(data))
    })
    socket.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(connectTimer)
        this.onDisconnected(err.message)
      } else if (this.socket === socket) {
        // ws emits error before close for the same failure; close handles it.
      }
    })
    socket.on('close', () => {
      if (!settled) {
        settled = true
        clearTimeout(connectTimer)
        this.onDisconnected(null)
      } else if (this.socket === socket) {
        this.onDisconnected(null)
      }
    })
    socket.on('pong', () => {
      this.gotPong = true
    })
  }

  private handleMessage(raw: string): void {
    let frame: {
      t?: string
      deviceId?: string | null
      deviceIds?: unknown
      from?: string
      frame?: unknown
      reqId?: string
      method?: string
      path?: string
    }
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    switch (frame.t) {
      case 'from':
        this.deps.onDeviceFrame(frame.deviceId ?? null, frame.frame, frame.from ?? '')
        break
      case 'device-online':
        if (frame.deviceId) this.deps.onDevicePresence(frame.deviceId, true)
        break
      case 'device-offline':
        if (frame.deviceId) this.deps.onDevicePresence(frame.deviceId, false)
        break
      case 'devices-online': {
        const ids = Array.isArray(frame.deviceIds) ? frame.deviceIds : []
        this.deps.onDevicesOnline(ids.filter((id): id is string => typeof id === 'string'))
        break
      }
      case 'http':
        if (frame.reqId && frame.path) {
          this.deps.onHttp({
            reqId: frame.reqId,
            method: frame.method ?? 'GET',
            path: frame.path,
          })
        }
        break
      default:
        // welcome/pong/error bookkeeping stays relay-internal.
        break
    }
  }

  private startPing(): void {
    this.stopPing()
    this.gotPong = true
    this.pingTimer = setInterval(() => {
      const socket = this.socket
      if (!socket) return
      if (!this.gotPong) {
        this.dropSilentRelay(socket)
        return
      }
      this.gotPong = false
      try {
        socket.ping()
      } catch {
        // Close handler picks this up.
        return
      }
      // Independent of the interval: a relay that stays silent past the pong
      // grace is dropped as soon as the grace expires, not one interval later.
      this.pongTimer = setTimeout(() => {
        if (this.socket === socket && !this.gotPong) this.dropSilentRelay(socket)
      }, PONG_TIMEOUT_MS)
      this.pongTimer.unref?.()
    }, PING_INTERVAL_MS)
    this.pingTimer.unref?.()
  }

  /** A relay that stopped answering pings: drop it and let backoff retry. */
  private dropSilentRelay(socket: TunnelSocket): void {
    if (this.socket !== socket) return
    this.socket = null
    this.stopPing()
    try {
      socket.terminate()
    } catch {
      // Already gone.
    }
    this.onDisconnected('The relay stopped responding.')
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.pingTimer = null
    this.pongTimer = null
  }

  private onDisconnected(reason: string | null): void {
    if (this.socket) {
      this.socket = null
      this.stopPing()
      this.deps.onState(false, reason ?? this.error)
    }
    if (this.stopped) return
    // Backoff with jitter so many desktops cannot synchronize on a restart.
    const base = this.deps.backoffBaseMs ?? BACKOFF_BASE_MS
    const backoff = Math.min(BACKOFF_MAX_MS, base * 2 ** this.failures)
    const delay = Math.round(backoff * (0.8 + Math.random() * 0.4))
    this.failures = Math.min(this.failures + 1, 12)
    this.connectTimer = setTimeout(() => void this.connect(), delay)
    this.connectTimer.unref?.()
  }

  private clearTimers(): void {
    this.stopPing()
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
  }
}
