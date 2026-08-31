/**
 * Binds the tunnel's socket interface to the `ws` package. Kept out of
 * relay-client.ts so the client stays testable with a fake socket factory and
 * free of a transport import.
 */

import { WebSocket } from 'ws'
import type { TunnelSocket, TunnelSocketFactory } from './relay-client'

/**
 * Cap inbound frames at 8 MB — the same limit the relay enforces on its own
 * inbound side. Without it the desktop would accept ws's ~100 MiB default from
 * the relay, so a hostile/compromised relay could push oversized frames the
 * desktop buffers whole.
 */
const MAX_INBOUND_FRAME_BYTES = 8 * 1024 * 1024

export const wsSocketFactory: TunnelSocketFactory = (url: string): TunnelSocket => {
  const socket = new WebSocket(url, { maxPayload: MAX_INBOUND_FRAME_BYTES })
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
