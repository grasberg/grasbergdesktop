/**
 * Grasberg relay — the hosted half of the phone tunnel.
 *
 * Design role: a DUMB, untrusted-for-content router. The desktop connects
 * outbound and stays connected; phones connect here and everything they
 * exchange with the desktop is end-to-end encrypted (AES-256-GCM under keys
 * derived from the pairing QR). This server routes opaque JSON frames; it can
 * see metadata (who is connected) but
 * never message content.
 *
 * Trust model, deliberately narrow:
 * - Desktops self-register (trust on first use): an unknown desktopId + token
 *   claims the id; the token's SHA-256 is stored and must match afterwards.
 *   A desktopId is 128-bit random minted on the desktop and shown only inside
 *   its own QR codes — an attacker cannot claim a victim's id before them
 *   without already knowing it. If the store is wiped, ids re-register freely.
 * - Devices (phones) are registered BY the desktop at pairing time
 *   ('device-add' carries the token hash); a device hello must present the
 *   matching token. Revocation ('device-remove') deletes the hash and drops
 *   any live connection immediately.
 * - Pairing-role connections are anonymous but can ONLY reach the desktop
 *   they named, and the desktop treats their single 'pair' frame with the
 *   same suspicion as the Telegram bridge treats a stranger's first message.
 *
 * Persistence is one JSON file (hashes only) rewritten atomically on change.
 * Everything else is in-memory: no messages, no history, no content — ever.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { REMOTE_PROTOCOL_VERSION } from '@shared/remote-protocol'

/** One relayed desktop tunnel connection. */
interface DesktopConn {
  socket: WebSocket
  tokenHash: string
}

/** One paired phone, whether or not it is currently connected. */
interface DeviceEntry {
  tokenHash: string
  socket: WebSocket | null
}

/** Frame cap: large enough for tunneled asset responses (~5 MB base64). */
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const PING_INTERVAL_MS = 30_000
const PONG_GRACE_MS = 15_000

export interface RelayServerDeps {
  /** Listen port (0 = pick one; the bound port is reported by start()). */
  port: number
  /** Bind address — 0.0.0.0 in production, 127.0.0.1 for local testing. */
  host?: string
  /** JSON file for desktop/device token hashes; null keeps everything in memory. */
  storePath?: string
  /**
   * How long a fresh connection may sit without sending its hello. The ping
   * loop reaps dead TCP connections, but a client that ANSWERS pings and
   * never speaks would otherwise hold the socket open indefinitely — a cheap
   * resource pump. Short in tests, generous in production.
   */
  helloTimeoutMs?: number
  /** Exact trusted static-client origin allowed for browser WebSockets. */
  mobileOrigin?: string
  onError?: (message: string) => void
}

interface StoredState {
  desktops: Record<string, string>
  devices: Record<string, Record<string, string>>
}

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex')

function hashesMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(given, 'utf8')
  if (a.length !== b.length) {
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

export class RelayServer {
  private readonly desktops = new Map<string, DesktopConn>()
  private readonly devices = new Map<string, Map<string, DeviceEntry>>()
  /** Pairing-role connections by relay connection id (the return address). */
  private readonly pairConns = new Map<string, { socket: WebSocket; desktopId: string }>()
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private boundPort: number | null = null
  private readonly pongTimers = new WeakMap<WebSocket, NodeJS.Timeout>()
  private readonly state: StoredState = { desktops: {}, devices: {} }

  constructor(private readonly deps: RelayServerDeps) {
    if (deps.storePath) this.loadStore(deps.storePath)
  }

  get port(): number | null {
    return this.boundPort
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.handleHttp(req, res))
      server.on('error', (e: NodeJS.ErrnoException) => reject(e))
      const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
      server.on('upgrade', (req, socket, head) => {
        // Browser clients must come from the separately hosted trusted app.
        // No configured origin means browsers are refused.
        const origin = req.headers.origin
        if (origin) {
          try {
            const allowed = this.deps.mobileOrigin
              ? new URL(this.deps.mobileOrigin).origin
              : null
            if (!allowed || new URL(origin).origin !== allowed) {
              socket.destroy()
              return
            }
          } catch {
            socket.destroy()
            return
          }
        }
        const url = new URL(req.url ?? '/', 'http://relay')
        if (url.pathname !== '/ws') {
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          void this.handleSocket(ws)
        })
      })
      // Liveness: a ws-level ping loop; a silent connection is terminated so
      // half-open sockets (phone in a subway tunnel) free their routing slot.
      const pinger = setInterval(() => {
        for (const client of wss.clients) {
          if (this.pongTimers.has(client)) continue
          void client.ping()
          const timer = setTimeout(() => {
            this.pongTimers.delete(client)
            client.terminate()
          }, PONG_GRACE_MS)
          timer.unref?.()
          this.pongTimers.set(client, timer)
        }
      }, PING_INTERVAL_MS)
      pinger.unref?.()
      wss.on('close', () => clearInterval(pinger))
      this.wss = wss
      server.listen(this.deps.port, this.deps.host ?? '0.0.0.0', () => {
        this.server = server
        const address = server.address()
        this.boundPort = typeof address === 'object' && address !== null ? address.port : this.deps.port
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    for (const socket of this.wss?.clients ?? []) socket.terminate()
    this.wss?.close()
    this.wss = null
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
      this.server = null
    })
    this.boundPort = null
  }

  // -- WebSocket sessions -----------------------------------------------------

  private async handleSocket(socket: WebSocket): Promise<void> {
    socket.on('pong', () => {
      const timer = this.pongTimers.get(socket)
      if (timer) clearTimeout(timer)
      this.pongTimers.delete(socket)
    })
    socket.on('close', () => {
      const timer = this.pongTimers.get(socket)
      if (timer) clearTimeout(timer)
      this.pongTimers.delete(socket)
    })
    const hello = await this.readOne(socket)
    if (!hello) return socket.terminate()
    const parsed = hello as {
      v?: number
      t?: string
      role?: string
      desktopId?: string
      deviceId?: string
      token?: string
    }
    if (parsed.t !== 'hello' || parsed.v !== REMOTE_PROTOCOL_VERSION || !parsed.desktopId) {
      this.send(socket, { t: 'welcome', ok: false, message: 'Bad hello.' })
      return socket.close(4400, 'bad hello')
    }
    switch (parsed.role) {
      case 'desktop':
        this.acceptDesktop(socket, parsed.desktopId, parsed.token ?? '')
        return
      case 'device':
        this.acceptDevice(socket, parsed.desktopId, parsed.deviceId ?? '', parsed.token ?? '')
        return
      case 'pairing':
        this.acceptPairing(socket, parsed.desktopId)
        return
      default:
        this.send(socket, { t: 'welcome', ok: false, message: 'Unknown role.' })
        return socket.close(4400, 'unknown role')
    }
  }

  /**
   * Resolves with the first parsed JSON frame, or null when the socket died
   * or stayed silent past the hello deadline. Both paths terminate the
   * socket — a connection that never said hello was never a session.
   */
  private readOne(socket: WebSocket): Promise<unknown | null> {
    return new Promise((resolve) => {
      let settled = false
      const settle = (value: unknown | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.off('message', onMessage)
        socket.off('close', onClose)
        resolve(value)
      }
      const timer = setTimeout(() => {
        settle(null)
        socket.terminate()
      }, this.deps.helloTimeoutMs ?? 10_000)
      timer.unref?.()
      const onMessage = (data: RawData): void => {
        try {
          settle(JSON.parse(typeof data === 'string' ? data : data.toString('utf8')))
        } catch {
          settle(null)
        }
      }
      const onClose = (): void => settle(null)
      socket.on('message', onMessage)
      socket.on('close', onClose)
    })
  }

  private acceptDesktop(socket: WebSocket, desktopId: string, token: string): void {
    const tokenHash = sha256(token)
    const existing = this.desktops.get(desktopId)
    const knownHash = existing?.tokenHash ?? this.state.desktops[desktopId]
    if (knownHash && !hashesMatch(knownHash, tokenHash)) {
      this.send(socket, { t: 'welcome', ok: false, message: 'Token mismatch.' })
      socket.close(4401, 'token mismatch')
      return
    }
    // A reconnect replaces the old tunnel (network flap, app restart).
    if (existing?.socket) existing.socket.close(4000, 'replaced')
    this.desktops.set(desktopId, { socket, tokenHash })
    if (this.state.desktops[desktopId] !== tokenHash) {
      this.state.desktops[desktopId] = tokenHash
      this.persist()
    }
    this.send(socket, { t: 'welcome', ok: true })
    // The reconnecting desktop may have missed device-online events while it
    // was away (phones stay connected here) — hand it the current set so its
    // push fan-out recovers without waiting for the phones to reconnect.
    const online = [...(this.devices.get(desktopId)?.entries() ?? [])]
      .filter(([, entry]) => entry.socket !== null)
      .map(([deviceId]) => deviceId)
    if (online.length > 0) this.send(socket, { t: 'devices-online', deviceIds: online })
    this.broadcastPresence(desktopId, true)
    socket.on('message', (data) => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'))
      } catch {
        return
      }
      this.routeFromDesktop(desktopId, frame)
    })
    socket.on('close', () => {
      const current = this.desktops.get(desktopId)
      if (current && current.socket === socket) {
        this.desktops.delete(desktopId)
        this.broadcastPresence(desktopId, false)
      }
    })
  }

  private acceptDevice(
    socket: WebSocket,
    desktopId: string,
    deviceId: string,
    token: string
  ): void {
    const entry = this.devices.get(desktopId)?.get(deviceId)
    if (!entry || !hashesMatch(entry.tokenHash, sha256(token))) {
      this.send(socket, { t: 'welcome', ok: false, message: 'Unknown device.' })
      socket.close(4401, 'unknown device')
      return
    }
    entry.socket?.close(4000, 'replaced')
    entry.socket = socket
    this.send(socket, { t: 'welcome', ok: true })
    const desktop = this.desktops.get(desktopId)
    this.send(socket, { t: 'presence', desktop: desktop?.socket ? 'online' : 'offline' })
    if (desktop?.socket) this.send(desktop.socket, { t: 'device-online', deviceId })
    socket.on('message', (data) => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'))
      } catch {
        return
      }
      if (frame.t === 'to') {
        this.routeToDesktop(desktopId, deviceId, null, frame.frame)
      }
    })
    socket.on('close', () => {
      if (entry.socket === socket) {
        entry.socket = null
        this.send(this.desktops.get(desktopId)?.socket, { t: 'device-offline', deviceId })
      }
    })
  }

  private acceptPairing(socket: WebSocket, desktopId: string): void {
    const desktop = this.desktops.get(desktopId)
    if (!desktop) {
      this.send(socket, { t: 'welcome', ok: false, message: 'Desktop offline.' })
      socket.close(4404, 'desktop offline')
      return
    }
    const connId = randomUUID()
    this.pairConns.set(connId, { socket, desktopId })
    this.send(socket, { t: 'welcome', ok: true })
    socket.on('message', (data) => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'))
      } catch {
        return
      }
      if (frame.t === 'to') {
        this.routeToDesktop(desktopId, null, connId, frame.frame)
      }
    })
    socket.on('close', () => this.pairConns.delete(connId))
  }

  private routeFromDesktop(desktopId: string, frame: Record<string, unknown>): void {
    const devices = this.devices.get(desktopId)
    switch (frame.t) {
      case 'to': {
        const entry = devices?.get(String(frame.deviceId ?? ''))
        if (entry?.socket) this.send(entry.socket, { t: 'from', frame: frame.frame })
        break
      }
      case 'to-pair': {
        const conn = this.pairConns.get(String(frame.connId ?? ''))
        if (conn) this.send(conn.socket, { t: 'from', frame: frame.frame })
        break
      }
      case 'device-add': {
        const deviceId = String(frame.deviceId ?? '')
        const tokenHash = String(frame.tokenHash ?? '')
        if (!deviceId || tokenHash.length !== 64) return
        if (!devices) this.devices.set(desktopId, new Map())
        this.devices.get(desktopId)!.set(deviceId, { tokenHash, socket: null })
        this.state.devices[desktopId] = Object.fromEntries(
          [...this.devices.get(desktopId)!.entries()].map(([id, e]) => [id, e.tokenHash])
        )
        this.persist()
        break
      }
      case 'device-remove': {
        const deviceId = String(frame.deviceId ?? '')
        const entry = devices?.get(deviceId)
        entry?.socket?.close(4001, 'revoked')
        devices?.delete(deviceId)
        if (this.state.devices[desktopId]) {
          delete this.state.devices[desktopId][deviceId]
          this.persist()
        }
        break
      }
      default:
        break
    }
  }

  private routeToDesktop(
    desktopId: string,
    deviceId: string | null,
    fromConn: string | null,
    frame: unknown
  ): void {
    const desktop = this.desktops.get(desktopId)
    if (!desktop) return // frames to an offline desktop are dropped, not queued
    this.send(desktop.socket, { t: 'from', deviceId, from: fromConn ?? '', frame })
  }

  private broadcastPresence(desktopId: string, online: boolean): void {
    const devices = this.devices.get(desktopId)
    if (!devices) return
    for (const [, entry] of devices) {
      if (entry.socket) this.send(entry.socket, { t: 'presence', desktop: online ? 'online' : 'offline' })
    }
  }

  // -- HTTP health only ----------------------------------------------------------

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://relay')
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, desktops: this.desktops.size }))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Not found.')
  }

  // -- store ---------------------------------------------------------------------

  private loadStore(path: string): void {
    try {
      const raw = readFileSync(path, 'utf8')
      const parsed = JSON.parse(raw) as StoredState
      this.state.desktops = parsed.desktops ?? {}
      this.state.devices = parsed.devices ?? {}
    } catch {
      // Missing or corrupt store: start fresh (ids re-register TOFU-style).
    }
    // Warm the live maps so a restart does not lock out registered desktops.
    for (const [id, hash] of Object.entries(this.state.desktops)) {
      if (!this.desktops.has(id)) this.desktops.set(id, { socket: null as never, tokenHash: hash })
    }
    for (const [desktopId, devices] of Object.entries(this.state.devices)) {
      const map = new Map<string, DeviceEntry>()
      for (const [deviceId, hash] of Object.entries(devices)) {
        map.set(deviceId, { tokenHash: hash, socket: null })
      }
      this.devices.set(desktopId, map)
    }
  }

  private persist(): void {
    if (!this.deps.storePath) return
    try {
      const tmp = `${this.deps.storePath}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state), 'utf8')
      renameSync(tmp, this.deps.storePath)
    } catch (e) {
      this.deps.onError?.(`Could not persist the relay store: ${e instanceof Error ? e.message : e}`)
    }
  }

  private send(socket: WebSocket | null | undefined, frame: unknown): void {
    if (!socket || socket.readyState !== socket.OPEN) return
    try {
      socket.send(JSON.stringify(frame))
    } catch {
      // A dead socket is cleaned up by its close handler.
    }
  }
}
