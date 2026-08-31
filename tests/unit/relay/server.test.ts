import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket, type RawData } from 'ws'
import { RelayServer } from '../../../relay/src/server'

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex')

let dir: string
let relay: RelayServer
let port: number

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'uld-relay-test-'))
  relay = new RelayServer({ port: 0, host: '127.0.0.1', storePath: join(dir, 'store.json') })
  await relay.start()
  port = relay.port!
})

afterEach(async () => {
  await relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

const wsUrl = (): string => `ws://127.0.0.1:${port}/ws`

/** Resolves with the first message matching `pick`, failing on timeout. */
function nextMessage<T = Record<string, unknown>>(
  socket: WebSocket,
  pick: (frame: Record<string, unknown>) => boolean = () => true,
  timeoutMs = 3000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), timeoutMs)
    const onMessage = (data: RawData): void => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'))
      } catch {
        return
      }
      if (!pick(frame)) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(frame as T)
    }
    socket.on('message', onMessage)
  })
}

function connect(hello: Record<string, unknown>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl())
    socket.on('error', reject)
    socket.on('open', () => {
      socket.send(JSON.stringify({ v: 1, t: 'hello', ...hello }))
      nextMessage(socket, (f) => f.t === 'welcome')
        .then((welcome) => {
          if (!(welcome as { ok?: boolean }).ok) {
            socket.close()
            reject(new Error(`welcome refused: ${JSON.stringify(welcome)}`))
            return
          }
          resolve(socket)
        })
        .catch(reject)
    })
  })
}

const opened = (socket: WebSocket, code = 4401): Promise<number> =>
  new Promise((resolve) => socket.on('close', (c) => resolve(c))) as Promise<number>

/** Polls until true (small helper for the frame-tap assertions above). */
const until_ = async (probe: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !probe(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(probe()).toBe(true)
}

const DESKTOP = 'desk-1234'
const TOKEN = 'a'.repeat(64)

async function connectedDesktop(): Promise<WebSocket> {
  return connect({ role: 'desktop', desktopId: DESKTOP, token: TOKEN })
}

describe('relay server', () => {
  it('answers healthz', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('accepts browser sockets only from the configured trusted client origin', async () => {
    const refused = new WebSocket(wsUrl(), { origin: 'https://mobile.example.com' })
    const refusedResult = await new Promise<'open' | 'error'>((resolve) => {
      refused.once('open', () => resolve('open'))
      refused.once('error', () => resolve('error'))
    })
    expect(refusedResult).toBe('error')

    await relay.stop()
    relay = new RelayServer({
      port: 0,
      host: '127.0.0.1',
      storePath: join(dir, 'store.json'),
      mobileOrigin: 'https://mobile.example.com',
    })
    await relay.start()
    port = relay.port!
    const allowed = new WebSocket(wsUrl(), { origin: 'https://mobile.example.com' })
    await new Promise((resolve, reject) => {
      allowed.once('open', resolve)
      allowed.once('error', reject)
    })
    allowed.close()
  })

  it('registers a desktop trust-on-first-use and accepts the same token again', async () => {
    const first = await connectedDesktop()
    const second = await connectedDesktop() // same id + token replaces silently
    expect(second.readyState).toBe(WebSocket.OPEN)
    // The replaced connection is closed with the 'replaced' code.
    first.close(1000)
  })

  it('refuses a desktop with a wrong token for a claimed id', async () => {
    await connectedDesktop()
    const socket = new WebSocket(wsUrl())
    await new Promise((resolve) => socket.on('open', resolve))
    socket.send(JSON.stringify({ v: 1, t: 'hello', role: 'desktop', desktopId: DESKTOP, token: 'b'.repeat(64) }))
    const welcome = await nextMessage<{ ok: boolean }>(socket, (f) => f.t === 'welcome')
    expect(welcome.ok).toBe(false)
    const code = await opened(socket, 4401)
    expect(code).toBe(4401)
  })

  it('refuses a device hello before the desktop registers it', async () => {
    await connectedDesktop()
    const socket = new WebSocket(wsUrl())
    await new Promise((resolve) => socket.on('open', resolve))
    socket.send(
      JSON.stringify({ v: 1, t: 'hello', role: 'device', desktopId: DESKTOP, deviceId: 'dev-1', token: 't' })
    )
    const welcome = await nextMessage<{ ok: boolean }>(socket, (f) => f.t === 'welcome')
    expect(welcome.ok).toBe(false)
    expect(await opened(socket)).toBe(4401)
  })

  it('routes device-add → device connect → frames both ways', async () => {
    const desktop = await connectedDesktop()
    const deviceToken = 'c'.repeat(64)
    desktop.send(
      JSON.stringify({ t: 'device-add', deviceId: 'dev-1', tokenHash: sha256(deviceToken) })
    )
    // device-add is fire-and-forget on the wire; give the handler a tick.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const device = await connect({ role: 'device', desktopId: DESKTOP, deviceId: 'dev-1', token: deviceToken })
    // The desktop learns the device came online.
    const online = await nextMessage(desktop, (f) => f.t === 'device-online')
    expect(online).toMatchObject({ deviceId: 'dev-1' })

    // device → desktop
    device.send(JSON.stringify({ t: 'to', frame: { t: 'sec', hello: 'from-phone' } }))
    const inbound = await nextMessage(desktop, (f) => f.t === 'from')
    expect(inbound.deviceId).toBe('dev-1')
    expect(inbound.frame).toMatchObject({ t: 'sec', hello: 'from-phone' })

    // desktop → device
    desktop.send(JSON.stringify({ t: 'to', deviceId: 'dev-1', frame: { t: 'sec', hi: 'desktop' } }))
    const outbound = await nextMessage(device, (f) => f.t === 'from')
    expect(outbound.frame).toMatchObject({ t: 'sec', hi: 'desktop' })
    device.close()
  })

  it('refuses a device with a wrong token even after registration', async () => {
    const desktop = await connectedDesktop()
    desktop.send(
      JSON.stringify({ t: 'device-add', deviceId: 'dev-2', tokenHash: sha256('right') })
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    const socket = new WebSocket(wsUrl())
    await new Promise((resolve) => socket.on('open', resolve))
    socket.send(
      JSON.stringify({ v: 1, t: 'hello', role: 'device', desktopId: DESKTOP, deviceId: 'dev-2', token: 'wrong' })
    )
    const welcome = await nextMessage<{ ok: boolean }>(socket, (f) => f.t === 'welcome')
    expect(welcome.ok).toBe(false)
    expect(await opened(socket)).toBe(4401)
  })

  it('tells an online device when the desktop drops, and back when it returns', async () => {
    const desktop = await connectedDesktop()
    desktop.send(JSON.stringify({ t: 'device-add', deviceId: 'dev-3', tokenHash: sha256('t3') }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const device = await connect({ role: 'device', desktopId: DESKTOP, deviceId: 'dev-3', token: 't3' })
    await nextMessage(desktop, (f) => f.t === 'device-online')

    desktop.close(1000)
    const offline = await nextMessage(device, (f) => f.t === 'presence')
    expect(offline).toMatchObject({ desktop: 'offline' })

    const back = await connectedDesktop()
    const onlineAgain = await nextMessage(device, (f) => f.t === 'presence')
    expect(onlineAgain).toMatchObject({ desktop: 'online' })
    device.close()
  })

  it('routes pairing connections to the desktop with a return address', async () => {
    const desktop = await connectedDesktop()
    const phone = await connect({ role: 'pairing', desktopId: DESKTOP })
    phone.send(JSON.stringify({ t: 'to', frame: { t: 'pair', proof: 'abc' } }))
    const inbound = await nextMessage<{ deviceId: unknown; from: string }>(desktop, (f) => f.t === 'from')
    expect(inbound.deviceId).toBeNull()
    expect(typeof inbound.from).toBe('string')

    desktop.send(JSON.stringify({ t: 'to-pair', connId: inbound.from, frame: { t: 'pair-error', reason: 'nope' } }))
    const reply = await nextMessage(phone, (f) => f.t === 'from')
    expect(reply.frame).toMatchObject({ t: 'pair-error', reason: 'nope' })
    phone.close()
  })

  it('refuses pairing connections while the desktop is offline', async () => {
    const socket = new WebSocket(wsUrl())
    await new Promise((resolve) => socket.on('open', resolve))
    socket.send(JSON.stringify({ v: 1, t: 'hello', role: 'pairing', desktopId: 'ghost' }))
    const welcome = await nextMessage<{ ok: boolean; message?: string }>(socket, (f) => f.t === 'welcome')
    expect(welcome.ok).toBe(false)
    expect(welcome.message).toContain('offline')
    expect(await opened(socket, 4404)).toBe(4404)
  })

  it('device-remove drops the device connection and revokes its token', async () => {
    const desktop = await connectedDesktop()
    desktop.send(JSON.stringify({ t: 'device-add', deviceId: 'dev-4', tokenHash: sha256('t4') }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const device = await connect({ role: 'device', desktopId: DESKTOP, deviceId: 'dev-4', token: 't4' })
    await nextMessage(desktop, (f) => f.t === 'device-online')

    desktop.send(JSON.stringify({ t: 'device-remove', deviceId: 'dev-4' }))
    expect(await opened(device, 4001)).toBe(4001)
    // The token no longer works.
    const retry = new WebSocket(wsUrl())
    await new Promise((resolve) => retry.on('open', resolve))
    retry.send(
      JSON.stringify({ v: 1, t: 'hello', role: 'device', desktopId: DESKTOP, deviceId: 'dev-4', token: 't4' })
    )
    const welcome = await nextMessage<{ ok: boolean }>(retry, (f) => f.t === 'welcome')
    expect(welcome.ok).toBe(false)
  })

  it('never serves executable desktop assets', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/unknown-desktop/`)
    expect(res.status).toBe(404)
  })

  it('persists hashes: a restarted relay still knows the desktop token', async () => {
    await connectedDesktop()
    await relay.stop()
    const restarted = new RelayServer({ port: 0, host: '127.0.0.1', storePath: join(dir, 'store.json') })
    await restarted.start()
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${restarted.port}/ws`)
      await new Promise((resolve) => socket.on('open', resolve))
      socket.send(JSON.stringify({ v: 1, t: 'hello', role: 'desktop', desktopId: DESKTOP, token: 'b'.repeat(64) }))
      const welcome = await nextMessage<{ ok: boolean }>(socket, (f) => f.t === 'welcome')
      expect(welcome.ok).toBe(false) // wrong token is still wrong after restart
      socket.close()
    } finally {
      await restarted.stop()
    }
  })

  it('terminates a connection that never sends its hello', async () => {
    const strict = new RelayServer({
      port: 0,
      host: '127.0.0.1',
      helloTimeoutMs: 60,
      storePath: join(dir, 'strict.json'),
    })
    await strict.start()
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${strict.port}/ws`)
      await new Promise((resolve) => socket.on('open', resolve))
      // Say nothing. The hello deadline must reap the socket.
      const code = await opened(socket)
      expect(code).toBe(1006) // terminated, not a protocol close
    } finally {
      await strict.stop()
    }
  })

  it('hands a reconnecting desktop the devices-online snapshot', async () => {
    const first = await connectedDesktop()
    first.send(JSON.stringify({ t: 'device-add', deviceId: 'dev-9', tokenHash: sha256('t9') }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const device = await connect({ role: 'device', desktopId: DESKTOP, deviceId: 'dev-9', token: 't9' })
    await nextMessage(first, (f) => f.t === 'device-online')

    first.close(1000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    // The phone stays connected at the relay while the desktop flaps.
    expect(device.readyState).toBe(WebSocket.OPEN)

    const second = new WebSocket(wsUrl())
    // welcome and the snapshot travel in the same socket flush — a listener
    // attached after awaiting the welcome would MISS the snapshot (it is
    // emitted before any microtask can subscribe). Tap everything up front.
    const frames: Array<Record<string, unknown>> = []
    second.on('message', (data) => {
      try {
        frames.push(JSON.parse(typeof data === 'string' ? data : data.toString('utf8')))
      } catch {
        // Ignore non-JSON.
      }
    })
    await new Promise((resolve) => second.on('open', resolve))
    second.send(JSON.stringify({ v: 1, t: 'hello', role: 'desktop', desktopId: DESKTOP, token: TOKEN }))
    await until_(() => frames.some((f) => f.t === 'devices-online'))
    expect(frames.find((f) => f.t === 'welcome')).toMatchObject({ ok: true })
    // The snapshot after a flap is what rebuilds the desktop's push fan-out
    // without the phone reconnecting.
    expect(frames.find((f) => f.t === 'devices-online')).toMatchObject({ deviceIds: ['dev-9'] })
    device.close()
  })

})
