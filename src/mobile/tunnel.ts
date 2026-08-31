/**
 * The phone's tunnel: one WebSocket to the relay, speaking the frames in
 * @shared/remote-protocol. Device credentials and the frame key live in
 * localStorage on a separately trusted static-client origin. The relay is
 * supplied as data in the QR fragment and serves no executable client code.
 *
 * The pairing secret from the QR fragment is consumed once: proof → sealed
 * 'paired' reply → identity stored → fragment cleared from the URL so a
 * reload or a shared link can never replay it.
 */

import type { IpcResult } from '@shared/ipc'
import { REMOTE_PROTOCOL_VERSION } from '@shared/remote-protocol'
import type {
  InnerHelloRes,
  InnerReq,
  InnerRes,
  PairError,
  PairPaired,
  SealedFrame,
} from '@shared/remote-protocol'
import { deriveFrameKey, keyFromBase64, keyToBase64, openFrame, pairingProof, sealFrame } from './crypto'

const IDENTITY_KEY = 'grasberg.remote.identity.v1'
/** A request the desktop neither answers nor drops within this is dead. */
const REQUEST_TIMEOUT_MS = 90_000

export type TunnelState =
  | 'unpaired'
  | 'pairing'
  | 'connecting'
  | 'online'
  | 'offline'
  | 'error'

export interface Identity {
  relayUrl: string
  desktopId: string
  deviceId: string
  token: string
  /** Frame key, base64 — sealed/checked against the desktop on connect. */
  keyBase64: string
  /** Next authenticated request sequence; older saved identities start at 1. */
  nextRequestSeq: number
}

export function loadIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Identity
    if (
      !relayWsUrl(parsed.relayUrl) ||
      !parsed.desktopId ||
      !parsed.deviceId ||
      !parsed.token ||
      !parsed.keyBase64
    ) return null
    return {
      ...parsed,
      nextRequestSeq:
        Number.isSafeInteger(parsed.nextRequestSeq) && parsed.nextRequestSeq > 0
          ? parsed.nextRequestSeq
          : 1,
    }
  } catch {
    return null
  }
}

export function saveIdentity(identity: Identity): void {
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity))
}

const fragmentParams = (): URLSearchParams => new URLSearchParams(location.hash.replace(/^#/, ''))

/** The desktopId carried inside the fragment, if this load came from a QR. */
export function desktopIdFromUrl(): string | null {
  const value = fragmentParams().get('desktop')
  return value && /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : null
}

/** The pairing secret from `#p=…`, if this page load came from a QR scan. */
export function pairingSecretFromUrl(): string | null {
  const value = fragmentParams().get('p')
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null
}

export function relayUrlFromUrl(): string | null {
  const value = fragmentParams().get('relay')
  return value && relayWsUrl(value) ? value : null
}

export function clearUrlSecret(): void {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search)
}

const relayWsUrl = (input: string): string | null => {
  try {
    const parsed = new URL(input)
    const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:'
    const loopback =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]'
    if (!secure && !(loopback && (parsed.protocol === 'http:' || parsed.protocol === 'ws:'))) {
      return null
    }
    parsed.protocol = secure ? 'wss:' : 'ws:'
    parsed.pathname = '/ws'
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

const guessPlatform = (): string => {
  const ua = navigator.userAgent
  if (/iPhone|iPad/i.test(ua)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  return 'web'
}

interface Pending {
  resolve: (result: IpcResult<unknown>) => void
}

export class Tunnel {
  state: TunnelState = 'connecting'
  error: string | null = null

  private socket: WebSocket | null = null
  private readonly key: ReturnType<typeof keyFromBase64>
  private readonly pending = new Map<string, Pending>()
  private reconnectTimer: number | null = null
  private failures = 0
  private closedByUser = false
  private sendQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly identity: Identity,
    private readonly onState: (state: TunnelState, error: string | null) => void,
    private readonly onPush: (channel: string, payload: unknown) => void
  ) {
    this.key = keyFromBase64(identity.keyBase64)
  }

  connect(): void {
    this.closedByUser = false
    this.setState('connecting', null)
    const url = relayWsUrl(this.identity.relayUrl)
    if (!url) {
      this.setState('error', 'The saved relay URL is invalid.')
      return
    }
    const socket = new WebSocket(url)
    this.socket = socket
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          v: REMOTE_PROTOCOL_VERSION,
          t: 'hello',
          role: 'device',
          desktopId: this.identity.desktopId,
          deviceId: this.identity.deviceId,
          token: this.identity.token,
        })
      )
    }
    socket.onmessage = (event) => this.handleMessage(String(event.data))
    socket.onclose = (event) => this.handleClose(event.code, event.reason)
    socket.onerror = () => {
      // onclose follows; nothing to do here.
    }
  }

  close(): void {
    this.closedByUser = true
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.close(1000)
    this.socket = null
  }

  /** Invokes one IPC channel on the desktop; resolves with its IpcResult. */
  async request<T>(channel: string, args: unknown[] = []): Promise<IpcResult<T>> {
    const socket = this.socket
    if (!socket || this.state !== 'online') {
      return {
        ok: false,
        error: { code: 'network', message: 'Not connected to the desktop.', retryable: true },
      }
    }
    const id = crypto.randomUUID()
    const seq = this.identity.nextRequestSeq
    this.identity.nextRequestSeq += 1
    // Persist before network I/O: a crash may skip a number, but can never
    // reuse one the desktop might already have executed.
    saveIdentity(this.identity)
    const inner: InnerReq = { t: 'req', id, seq, channel, args }
    const promise = new Promise<IpcResult<unknown>>((resolve) => {
      // A live-but-silent desktop must not leave the UI waiting forever; the
      // timer is cancelled by whichever of {reply, close} settles first.
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({
          ok: false,
          error: {
            code: 'timeout',
            message: 'The desktop did not answer in time.',
            retryable: true,
          },
        })
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer)
          resolve(result)
        },
      })
    })
    try {
      this.sendQueue = this.sendQueue.then(async () => {
        if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
          throw new Error('Connection lost before the request was sent.')
        }
        socket.send(JSON.stringify({ t: 'to', frame: await sealFrame(this.key, inner) }))
      })
      await this.sendQueue
    } catch {
      const pending = this.pending.get(id)
      this.pending.delete(id)
      pending?.resolve({
        ok: false,
        error: { code: 'network', message: 'Connection lost.', retryable: true },
      })
      this.sendQueue = Promise.resolve()
    }
    return promise as Promise<IpcResult<T>>
  }

  private setState(state: TunnelState, error: string | null): void {
    this.state = state
    this.error = error
    this.onState(state, error)
  }

  private async handleMessage(raw: string): Promise<void> {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    if (frame.t === 'welcome') {
      if (frame.ok) {
        // Sealed hello: confirms both sides hold the same frame key and
        // gives the app version for the header.
        void this.sendInner({ t: 'hello' })
      } else {
        this.setState('error', String(frame.message ?? 'The relay refused this device.'))
      }
      return
    }
    if (frame.t === 'presence') {
      if (frame.desktop === 'online') {
        this.failures = 0
        this.setState('online', null)
        void this.sendInner({ t: 'hello' })
      } else {
        this.setState('offline', null)
      }
      return
    }
    if (frame.t !== 'from') return
    const sealed = frame.frame as SealedFrame
    if (!sealed || sealed.t !== 'sec') return
    let inner: Record<string, unknown>
    try {
      inner = (await openFrame(this.key, sealed)) as Record<string, unknown>
    } catch {
      // Tampered or foreign ciphertext: ignore.
      return
    }
    if (inner.t === 'hello-res') {
      const res = inner as unknown as InnerHelloRes
      this.setState('online', null)
      this.onPush('__hello__', res.app)
      return
    }
    if (inner.t === 'res') {
      const res = inner as unknown as InnerRes
      const pending = this.pending.get(res.id)
      if (pending) {
        this.pending.delete(res.id)
        pending.resolve(res.result)
      }
      return
    }
    if (inner.t === 'push') {
      this.onPush(String(inner.channel), inner.payload)
    }
  }

  private async sendInner(payload: unknown): Promise<void> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ t: 'to', frame: await sealFrame(this.key, payload) }))
  }

  private handleClose(code: number, reason: string): void {
    for (const [, pending] of this.pending) {
      pending.resolve({ ok: false, error: { code: 'network', message: 'Connection lost.', retryable: true } })
    }
    this.pending.clear()
    if (this.closedByUser) return
    if (code === 4401) {
      // Either revoked on the desktop, or the relay lost its registration
      // (the desktop re-upserts those on its next connect — see the pairing
      // service's resend). Either way retrying THIS identity is pointless:
      // drop it and tell the user how to recover.
      localStorage.removeItem(IDENTITY_KEY)
      this.setState(
        'unpaired',
        'This device is not authorized. It was revoked on the desktop, or the relay lost its ' +
          'registration — reconnecting the desktop re-syncs it. If it persists, pair again ' +
          'from Settings → Bridges.'
      )
      return
    }
    this.setState('offline', reason || null)
    const backoff = Math.min(30_000, 3000 * 2 ** Math.min(this.failures, 4))
    this.failures += 1
    this.reconnectTimer = window.setTimeout(() => this.connect(), backoff)
  }
}

/**
 * Runs the one-shot pairing exchange over a `pairing`-role connection.
 * Resolves with the identity to store; throws with the relay/desktop's
 * human-readable reason on failure.
 */
export async function pairOverRelay(
  desktopId: string,
  secret: string,
  relayUrl: string
): Promise<PairPaired & { keyBase64: string; nextRequestSeq: number }> {
  const key = await deriveFrameKey(secret)
  const proof = await pairingProof(secret)
  return new Promise((resolve, reject) => {
    const url = relayWsUrl(relayUrl)
    if (!url) return reject(new Error('The pairing link has an invalid relay URL.'))
    const socket = new WebSocket(url)
    const fail = (message: string): void => {
      try {
        socket.close()
      } catch {
        // Already gone.
      }
      reject(new Error(message))
    }
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          v: REMOTE_PROTOCOL_VERSION,
          t: 'hello',
          role: 'pairing',
          desktopId,
        })
      )
    }
    socket.onmessage = async (event) => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (frame.t === 'welcome') {
        if (!frame.ok) {
          fail(String(frame.message ?? 'The relay refused the pairing connection.'))
          return
        }
        socket.send(
          JSON.stringify({
            t: 'to',
            frame: { t: 'pair', proof, name: 'My phone', platform: guessPlatform() },
          })
        )
        return
      }
      if (frame.t !== 'from') return
      const inner = frame.frame
      if ((inner as { t?: string })?.t === 'pair-error') {
        fail((inner as PairError).reason)
        return
      }
      if ((inner as { t?: string })?.t === 'sec') {
        try {
          const opened = await openFrame<PairPaired | InnerHelloRes>(key, inner as SealedFrame)
          if (opened.t === 'paired') {
            socket.close()
            resolve({ ...opened, keyBase64: keyToBase64(key), nextRequestSeq: 1 })
          }
        } catch (e) {
          fail(`Pairing reply could not be decrypted (${e instanceof Error ? e.message : 'error'}).`)
        }
      }
    }
    socket.onerror = () => fail('Could not reach the relay.')
  })
}
