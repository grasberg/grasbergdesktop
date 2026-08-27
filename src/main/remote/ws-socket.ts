/**
 * Binds the tunnel's socket interface to the `ws` package. Kept out of
 * relay-client.ts so the client stays testable with a fake socket factory and
 * free of a transport import.
 */

import { WebSocket } from 'ws'
import type { TunnelSocket, TunnelSocketFactory } from './relay-client'

export const wsSocketFactory: TunnelSocketFactory = (url: string): TunnelSocket => {
  const socket = new WebSocket(url)
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    terminate: () => socket.terminate(),
    ping: () => socket.ping(),
    on: (event, cb) => {
      socket.on(event, cb as never)
    },
  }
}
