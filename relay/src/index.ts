/**
 * Relay entrypoint. Configuration is environment-only — there is nothing to
 * get wrong from a config file:
 *
 *   PORT        listen port          (default 8790)
 *   HOST        bind address         (default 0.0.0.0; use 127.0.0.1 to test locally)
 *   STORE_PATH  token-hash store     (default ./relay-store.json; leave unset for memory-only)
 *   MOBILE_ORIGIN trusted static phone-client origin (required for browser clients)
 */

import { RelayServer } from './server'

const port = Number.parseInt(process.env.PORT ?? '8790', 10)
const host = process.env.HOST ?? '0.0.0.0'
const storePath = process.env.STORE_PATH ?? 'relay-store.json'
const mobileOrigin = process.env.MOBILE_ORIGIN

const server = new RelayServer({
  port: Number.isFinite(port) && port > 0 ? port : 8790,
  host,
  storePath,
  ...(mobileOrigin ? { mobileOrigin } : {}),
  onError: (message) => console.error('[relay]', message),
})

server
  .start()
  .then(() => {
    console.log(`[relay] listening on ${host}:${server.port ?? port}`)
  })
  .catch((e: unknown) => {
    console.error('[relay] could not start:', e instanceof Error ? e.message : e)
    process.exit(1)
  })

const shutdown = (): void => {
  console.log('[relay] shutting down')
  void server.stop().finally(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
