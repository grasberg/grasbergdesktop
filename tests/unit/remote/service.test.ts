import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHANNELS } from '@shared/ipc'
import type { IpcResult } from '@shared/ipc'
import { publishMainEvent } from '../../../src/main/events'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import type { IpcHandlerMap } from '../../../src/main/ipc/handler-map'
import {
  deriveFrameKey,
  hashToken,
  openFrame,
  pairingProof,
  sealFrame,
} from '../../../src/main/remote/crypto'
import {
  RemoteService,
  relayHttpOrigin,
} from '../../../src/main/remote/service'
import { relayWsUrl, type TunnelSocket } from '../../../src/main/remote/relay-client'
import type { PairPaired, InnerRes, InnerPush, SealedFrame } from '@shared/remote-protocol'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Minimal keystore: reversible base64 instead of safeStorage (no Electron). */
const fakeKeystore = {
  encryptKey: (plain: string) => ({
    encryptedBase64: Buffer.from(plain, 'utf8').toString('base64'),
    preview: '••••',
  }),
  decryptKey: (stored: string) => Buffer.from(stored, 'base64').toString('utf8'),
}

class FakeSocket implements TunnelSocket {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  readonly sent: Array<Record<string, unknown> | string> = []
  opened = false

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.emit('close', 1000, Buffer.from(''))
  }
  terminate(): void {
    this.emit('close', 1006, Buffer.from(''))
  }
  ping(): void {
    this.emit('pong')
  }
  on(event: 'open', cb: () => void): void
  on(event: 'close', cb: (code: number, reason: Buffer) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  on(event: 'message', cb: (data: unknown) => void): void
  on(event: 'pong', cb: () => void): void
  on(event: string, cb: (...args: never[]) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(cb as (...args: unknown[]) => void)
    this.listeners.set(event, list)
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args)
  }
  /** Relay delivers one JSON frame to the desktop. */
  deliver(frame: unknown): void {
    this.emit('message', JSON.stringify(frame))
  }
  /** Frames this socket sent, parsed, filtered by type. */
  of<T extends string>(type: T): Array<Record<string, unknown>> {
    return this.sent.filter(
      (f): f is Record<string, unknown> => typeof f === 'object' && (f as { t?: string }).t === type
    )
  }
}

const until = async (probe: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !probe(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(probe()).toBe(true)
}

// ---------------------------------------------------------------------------

let dir: string
let dbFile: string
let db: AppDatabase | null = null
let mobileDir: string
const sockets: FakeSocket[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-remote-test-'))
  dbFile = join(dir, 'app.db')
  db = openDatabase(dbFile)
  mobileDir = join(dir, 'mobile')
  mkdirSync(mobileDir)
  writeFileSync(join(mobileDir, 'index.html'), '<html>mobile app</html>')
  sockets.length = 0
})

afterEach(() => {
  try {
    db?.close()
  } catch {
    // already closed
  }
  db = null
  rmSync(dir, { recursive: true, force: true })
})

function makeService(handlers?: IpcHandlerMap): RemoteService {
  const map: IpcHandlerMap = handlers ?? new Map()
  return new RemoteService({
    db: db!,
    keystore: fakeKeystore,
    handlers: map,
    mobileDir,
    appVersion: '1.2.3-test',
    socketFactory: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    onChanged: () => undefined,
  })
}

/** Enabled + connected service with one socket ready, plus its settings. */
async function connectedService(): Promise<RemoteService> {
  const service = makeService()
  const status = service.setConfig({ enabled: true, relayUrl: 'https://relay.example.com' })
  expect(status.enabled).toBe(true)
  await until(() => sockets.length === 1)
  sockets[0].emit('open')
  await until(() => service.status().connected)
  return service
}

/** Pairs one phone through the socket; returns device + frame key. */
async function pairPhone(service: RemoteService): Promise<{ deviceId: string; token: string; key: Buffer }> {
  const status = service.pair(true)
  const secret = status.pairing!.url.split('#p=')[1]
  sockets[0].deliver({
    t: 'from',
    deviceId: null,
    from: 'conn-1',
    frame: { t: 'pair', proof: pairingProof(secret), name: 'Test phone', platform: 'ios' },
  })
  let paired: PairPaired | null = null
  for (const frame of sockets[0].of('to-pair')) {
    const sealed = frame.frame as SealedFrame
    if (sealed.t !== 'sec') continue
    const opened = openFrame<{ t: string } & PairPaired>(deriveFrameKey(secret), sealed)
    if (opened.t === 'paired') paired = opened
  }
  if (!paired) throw new Error('pairing reply missing')
  return { deviceId: paired.deviceId, token: paired.token, key: deriveFrameKey(secret) }
}

// ---------------------------------------------------------------------------

describe('relay URL policy', () => {
  it('accepts https/wss anywhere and plaintext only on loopback', () => {
    expect(relayWsUrl('https://relay.example.com')).toBe('wss://relay.example.com/ws')
    expect(relayWsUrl('wss://relay.example.com/path')).toBe('wss://relay.example.com/ws')
    expect(relayWsUrl('http://127.0.0.1:8790')).toBe('ws://127.0.0.1:8790/ws')
    expect(relayWsUrl('http://localhost:8790')).toBe('ws://localhost:8790/ws')
    expect(relayWsUrl('http://evil.example.com')).toBeNull()
    expect(relayWsUrl('ftp://relay.example.com')).toBeNull()
    expect(relayWsUrl('not a url')).toBeNull()
  })

  it('derives the phone-facing http origin', () => {
    expect(relayHttpOrigin('https://relay.example.com')).toBe('https://relay.example.com')
    expect(relayHttpOrigin('wss://relay.example.com')).toBe('https://relay.example.com')
    expect(relayHttpOrigin('http://127.0.0.1:8790')).toBe('http://127.0.0.1:8790')
    expect(relayHttpOrigin('http://evil.example.com')).toBeNull()
  })
})

describe('RemoteService config', () => {
  it('refuses to enable without a relay URL', () => {
    const service = makeService()
    expect(() => service.setConfig({ enabled: true, relayUrl: null })).toThrow(/relay URL/)
  })

  it('refuses non-https, non-loopback relay URLs before storing them', () => {
    const service = makeService()
    expect(() => service.setConfig({ enabled: true, relayUrl: 'http://evil.example.com' })).toThrow(
      /https/
    )
    expect(db!.settings.get().remoteRelayUrl).toBeNull()
  })

  it('disabling keeps the URL but stops the tunnel', async () => {
    const service = await connectedService()
    const status = service.setConfig({ enabled: false })
    expect(status.enabled).toBe(false)
    expect(status.relayUrl).toBe('https://relay.example.com')
    expect(status.connected).toBe(false)
    // The socket was asked to close (FakeSocket.close emits 'close').
    expect(service.status().connected).toBe(false)
  })

  it('does nothing while disabled', () => {
    const service = makeService()
    service.sync()
    expect(sockets).toHaveLength(0)
    expect(service.status()).toMatchObject({ enabled: false, connected: false, desktopId: null })
  })
})

describe('RemoteService tunnel protocol', () => {
  it('hellos the relay with the desktop id and a persisted token', async () => {
    const service = await connectedService()
    const hello = sockets[0].sent.find(
      (f) => typeof f === 'object' && (f as { t?: string }).t === 'hello'
    ) as Record<string, string>
    expect(hello.role).toBe('desktop')
    expect(hello.desktopId).toBe(service.status().desktopId)
    expect(hello.token).toMatch(/^[0-9a-f]{64}$/)
    // The token is stored encrypted and hashed — never plaintext in settings.
    expect(db!.secrets.has('remote', 'relay', 'token')).toBe(true)
  })

  it('pairs a phone: device row, relay device-add, sealed paired reply', async () => {
    const service = await connectedService()
    const { deviceId, token, key } = await pairPhone(service)

    const devices = service.status().devices
    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({ id: deviceId, name: 'Test phone (ios)' })
    expect(devices[0].keyFingerprint).toMatch(/^[0-9a-f]{16}$/)

    const adds = sockets[0].of('device-add')
    expect(adds).toHaveLength(1)
    expect(adds[0].deviceId).toBe(deviceId)
    expect(adds[0].tokenHash).toBe(hashToken(token))

    // The frame key lives encrypted under the device id.
    expect(db!.secrets.has('remote', deviceId, 'frame_key')).toBe(true)
    // The pairing offer is consumed after one success.
    expect(service.status().pairing).toBeNull()
    // The reply was sealed under the key derived from the QR secret.
    expect(key.length).toBe(32)
  })

  it('answers a wrong pairing proof and burns the offer after five tries', async () => {
    const service = await connectedService()
    service.pair(true)
    for (let attempt = 0; attempt < 5; attempt++) {
      sockets[0].deliver({
        t: 'from',
        deviceId: null,
        from: 'conn-x',
        frame: { t: 'pair', proof: pairingProof('wrong-' + attempt), name: 'Evil', platform: '' },
      })
    }
    const errors = sockets[0]
      .of('to-pair')
      .map((f) => f.frame)
      .filter((f) => (f as { t?: string }).t === 'pair-error')
    expect(errors).toHaveLength(5)
    expect((errors[4] as { reason: string }).reason).toMatch(/Too many attempts/)
    expect(service.status().pairing).toBeNull()
    expect(service.status().devices).toHaveLength(0)
  })

  it('routes a sealed request through the allowlisted handler and seals the reply', async () => {
    const handlers: IpcHandlerMap = new Map()
    handlers.set(CHANNELS.appGetInfo, () => ({ version: '9.9.9', platform: 'linux' }))
    const service = makeService(handlers)
    service.setConfig({ enabled: true, relayUrl: 'https://relay.example.com' })
    await until(() => sockets.length === 1)
    sockets[0].emit('open')
    await until(() => service.status().connected)
    const { deviceId, key } = await pairPhone(service)

    sockets[0].deliver({
      t: 'from',
      deviceId,
      from: 'conn-2',
      frame: sealFrame(key, { t: 'req', id: 'req-1', channel: CHANNELS.appGetInfo, args: [] }),
    })
    await until(() => sockets[0].of('to').some((f) => f.deviceId === deviceId))
    const sealed = sockets[0]
      .of('to')
      .find((f) => f.deviceId === deviceId)!.frame as { t: string }
    expect(sealed.t).toBe('sec')
    const reply = openFrame<InnerRes>(key, sealed as never)
    expect(reply.id).toBe('req-1')
    expect(reply.result).toEqual<IpcResult<unknown>>({
      ok: true,
      data: { version: '9.9.9', platform: 'linux' },
    })
  })

  it('drops a sealed request for a channel outside the allowlist into an error result', async () => {
    const handlers: IpcHandlerMap = new Map()
    handlers.set(CHANNELS.settingsGet, () => ({ secret: 'nope' }))
    const service = makeService(handlers)
    service.setConfig({ enabled: true, relayUrl: 'https://relay.example.com' })
    await until(() => sockets.length === 1)
    sockets[0].emit('open')
    await until(() => service.status().connected)
    const { deviceId, key } = await pairPhone(service)

    sockets[0].deliver({
      t: 'from',
      deviceId,
      from: 'conn-2',
      frame: sealFrame(key, { t: 'req', id: 'req-2', channel: CHANNELS.settingsGet, args: [] }),
    })
    await until(() => sockets[0].of('to').some((f) => f.deviceId === deviceId))
    const sealed = sockets[0].of('to').find((f) => f.deviceId === deviceId)!.frame as never
    const reply = openFrame<InnerRes>(key, sealed)
    expect(reply.result.ok).toBe(false)
  })

  it('forwards allowed pushes to online devices only, sealed', async () => {
    const service = await connectedService()
    const { deviceId, key } = await pairPhone(service)

    // Offline: the push must not be routed.
    publishMainEvent(CHANNELS.streamEvent, { streamId: 's1' })
    expect(sockets[0].of('to')).toHaveLength(0)

    sockets[0].deliver({ t: 'device-online', deviceId })
    await until(() => service.status().devices[0]?.online === true)
    publishMainEvent(CHANNELS.streamEvent, { streamId: 's1', conversationId: 'c1' })
    await until(() => sockets[0].of('to').length > 0)
    const push = openFrame<InnerPush>(key, sockets[0].of('to')[0].frame as never)
    expect(push.t).toBe('push')
    expect(push.channel).toBe(CHANNELS.streamEvent)

    // Non-forwarded channels never leave the machine.
    const before = sockets[0].of('to').length
    publishMainEvent(CHANNELS.terminalData, { data: 'psst' })
    expect(sockets[0].of('to')).toHaveLength(before)
  })

  it('rebuilds the online set from the relay snapshot (devices-online)', async () => {
    const service = await connectedService()
    const { deviceId, key } = await pairPhone(service)

    // Simulate a tunnel flap: the local set was cleared (state false), the
    // phone never reconnected, and the relay's snapshot is what heals it.
    sockets[0].deliver({ t: 'devices-online', deviceIds: [] })
    await until(() => service.status().devices[0]?.online === false)
    expect(service.status().devices[0]?.online).toBe(false)

    sockets[0].deliver({ t: 'devices-online', deviceIds: [deviceId] })
    await until(() => service.status().devices[0]?.online === true)

    // And pushes flow again — the whole point of the snapshot.
    publishMainEvent(CHANNELS.streamEvent, { streamId: 's2', conversationId: 'c1' })
    await until(() => sockets[0].of('to').length > 0)
    const push = openFrame<InnerPush>(key, sockets[0].of('to').at(-1)!.frame as never)
    expect(push.t).toBe('push')

    // Unknown ids (revoked mid-flap) are dropped, not resurrected.
    sockets[0].deliver({ t: 'devices-online', deviceIds: [deviceId, 'ghost'] })
    await until(() => service.status().devices[0]?.online === true)
    expect(service.status().devices).toHaveLength(1)
  })

  it('mints pairing QR URLs of origin/desktopId/#secret shape', async () => {
    const service = await connectedService()
    const status = service.pair(true)
    const desktopId = service.status().desktopId!
    expect(status.pairing?.url).toMatch(
      new RegExp(`^https://relay\\.example\\.com/${desktopId}/#p=[A-Za-z0-9_-]{43}$`)
    )
  })

  it('re-upserts device registrations on every tunnel connect', async () => {
    const service = await connectedService()
    const { deviceId, token } = await pairPhone(service)
    expect(service.status().devices).toHaveLength(1)

    // A second service over the SAME database dials a fresh tunnel (what
    // happens after a relay restart or app relaunch): the stored device's
    // token hash must reach the relay again so the phone keeps authenticating.
    const second = makeService()
    second.setConfig({ enabled: true, relayUrl: 'https://relay.example.com' })
    await until(() => sockets.length === 2)
    sockets[1].emit('open')
    await until(() => second.status().connected)
    const adds = sockets[1].of('device-add')
    expect(adds).toHaveLength(1)
    expect(adds[0]).toMatchObject({ deviceId, tokenHash: hashToken(token) })
    second.stopAll()
  })

  it('serves tunnelled asset requests from the mobile bundle', async () => {
    const service = await connectedService()
    sockets[0].deliver({ t: 'http', reqId: 'r9', method: 'GET', path: '/' })
    await until(() => sockets[0].of('http-res').length > 0)
    const res = sockets[0].of('http-res')[0]
    expect(res.status).toBe(200)
    expect(res.contentType).toBe('text/html; charset=utf-8')
    expect(Buffer.from(res.body as string, 'base64').toString()).toContain('mobile app')
  })

  it('revoking a device drops its key, notifies the relay and cuts it off', async () => {
    const service = await connectedService()
    const { deviceId } = await pairPhone(service)
    sockets[0].deliver({ t: 'device-online', deviceId })
    await until(() => service.status().devices[0]?.online === true)

    const status = service.revokeDevice(deviceId)
    expect(status.devices[0].revokedAt).not.toBeNull()
    expect(status.devices[0].online).toBe(false)
    expect(db!.secrets.has('remote', deviceId, 'frame_key')).toBe(false)
    expect(db!.remoteDevices.getActiveById(deviceId)).toBeNull()
    expect(sockets[0].of('device-remove')).toHaveLength(1)

    // A frame from the revoked device is ignored entirely.
    sockets[0].deliver({
      t: 'from',
      deviceId,
      from: 'conn-3',
      frame: sealFrame(deriveFrameKey('irrelevant'), { t: 'req', id: 'x', channel: CHANNELS.convList, args: [] }),
    })
    expect(sockets[0].of('to')).toHaveLength(0)
  })

  it('stopAll cancels the pairing offer and disconnects', async () => {
    const service = await connectedService()
    service.pair(true)
    expect(service.status().pairing).not.toBeNull()
    service.stopAll()
    expect(service.status().pairing).toBeNull()
    expect(service.status().connected).toBe(false)
  })
})
