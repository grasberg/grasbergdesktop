import { describe, expect, it } from 'vitest'
import { RelayClient, type TunnelSocket, type TunnelSocketFactory } from '../../../src/main/remote/relay-client'

/**
 * Minimal socket double: records sent frames, lets the test drive events.
 * `ping()` answers pong synchronously so the liveness loop stays quiet.
 */
class FakeSocket implements TunnelSocket {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  readonly sent: string[] = []
  terminated = false

  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.emit('close', 1000, Buffer.from(''))
  }
  terminate(): void {
    this.terminated = true
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
}

const until = async (probe: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !probe(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(probe()).toBe(true)
}

function makeClient(): { client: RelayClient; sockets: FakeSocket[]; states: Array<{ connected: boolean; error: string | null }> } {
  const sockets: FakeSocket[] = []
  const states: Array<{ connected: boolean; error: string | null }> = []
  const factory: TunnelSocketFactory = () => {
    const socket = new FakeSocket()
    sockets.push(socket)
    return socket
  }
  const client = new RelayClient({
    relayUrl: 'https://relay.example.com',
    desktopId: 'desk',
    getToken: async () => 't'.repeat(64),
    onState: (connected, error) => states.push({ connected, error }),
    onDeviceFrame: () => undefined,
    onDevicePresence: () => undefined,
    onDevicesOnline: () => undefined,
    socketFactory: factory,
    backoffBaseMs: 5,
  })
  return { client, sockets, states }
}

describe('RelayClient reconnect', () => {
  it('reconnects with backoff after an unexpected close', async () => {
    const { client, sockets, states } = makeClient()
    client.start()
    await until(() => sockets.length === 1)
    sockets[0].emit('open')
    expect(states.at(-1)).toEqual({ connected: true, error: null })

    // Unexpected drop: the client must dial again (backoff base 5 ms).
    sockets[0].terminate()
    await until(() => sockets.length === 2)
    sockets[1].emit('open')
    expect(states.at(-1)).toEqual({ connected: true, error: null })
    expect(sockets[0].terminated).toBe(true)
    client.stop()
  })

  it('does not reconnect after stop()', async () => {
    const { client, sockets } = makeClient()
    client.start()
    await until(() => sockets.length === 1)
    sockets[0].emit('open')
    client.stop()
    const count = sockets.length
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sockets).toHaveLength(count)
  })
})
