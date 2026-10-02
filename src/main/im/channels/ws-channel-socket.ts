/**
 * Binds the channel connectors' socket interface (v53) to the `ws` package —
 * kept apart so connectors stay testable with fake sockets.
 */

import { WebSocket } from 'ws'
import type { ChannelSocket } from './types'

/** Platform frames are small JSON; anything near this is hostile or broken. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024

export function wsChannelSocket(url: string): ChannelSocket {
  const socket = new WebSocket(url, { maxPayload: MAX_FRAME_BYTES })
  return {
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data)
    },
    close: () => socket.close(),
    on: ((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'message') socket.on('message', (data) => cb(data.toString()))
      else socket.on(event as 'open' | 'close' | 'error', cb as never)
    }) as ChannelSocket['on'],
  }
}
