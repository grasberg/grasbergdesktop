/**
 * Local trigger endpoint: the "event" half of routines. A git hook, a CI job
 * or a shell script POSTs here and a workflow runs — the counterpart to the
 * outbound webhook the notify node already has.
 *
 * This is the only inbound network surface in the app, so every constraint on
 * it is deliberate:
 *
 * - It binds 127.0.0.1 ONLY. Never 0.0.0.0, never a LAN address: something on
 *   the same coffee-shop network must not be able to reach it.
 * - It is off until the user switches it on, and switching it on mints a fresh
 *   token. Requests without that token are refused before anything is parsed,
 *   and the comparison is timing-safe.
 * - A running endpoint still starts NOTHING by itself. Each workflow opts in
 *   individually (Workflow.webhookEnabled), so turning the port on cannot
 *   expose a library of workflows the user forgot about.
 * - Bodies are capped and never evaluated — the payload is handed to the
 *   graph's Input node as plain text.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { WorkflowRunTrigger } from '@shared/types'

/** Request body accepted, in bytes. Anything larger is refused outright. */
const MAX_BODY_BYTES = 64 * 1024
/** A slow or hanging client must not hold a socket open indefinitely. */
const REQUEST_TIMEOUT_MS = 10_000

export interface TriggerServerDeps {
  /** Live settings read per request, so a toggle takes effect immediately. */
  settings: () => { enabled: boolean; port: number; token: string | null }
  /** True when this workflow exists AND opted into being triggered. */
  isTriggerable: (workflowId: string) => boolean
  /** Starts the run; resolves when it finishes (errors are reported as 500). */
  run: (workflowId: string, trigger: WorkflowRunTrigger, payload: string) => Promise<unknown>
  onError?: (message: string) => void
}

/** A fresh endpoint secret. 32 hex chars — a local URL people paste around. */
export function generateTriggerToken(): string {
  return randomBytes(16).toString('hex')
}

/** Constant-time comparison so the token cannot be guessed byte by byte. */
function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(given, 'utf8')
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length — compare against a same-length buffer and fold length in.
  if (a.length !== b.length) {
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

/** Reads the body, refusing anything over the cap without buffering it all. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

function send(res: ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({ ok: status < 400, message })
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

export class WorkflowTriggerServer {
  private server: Server | null = null
  private boundPort: number | null = null

  constructor(private readonly deps: TriggerServerDeps) {}

  /** The URL to paste into a hook, or null while the endpoint is off. */
  url(workflowId = '<workflow-id>'): string | null {
    const { enabled, token } = this.deps.settings()
    if (!enabled || !token || this.boundPort === null) return null
    return `http://127.0.0.1:${this.boundPort}/run/${workflowId}?token=${token}`
  }

  /** True while the listener is actually bound. */
  get running(): boolean {
    return this.server !== null
  }

  /** Applies the current settings: (re)binds, rebinds on a port change, or stops. */
  sync(): void {
    const { enabled, port, token } = this.deps.settings()
    if (!enabled || !token || process.env.SMOKE_TEST === '1') {
      this.stop()
      return
    }
    if (this.server && this.boundPort === port) return
    this.stop()
    this.listen(port)
  }

  private listen(port: number): void {
    const server = createServer((req, res) => {
      void this.handle(req, res)
    })
    server.on('error', (e: NodeJS.ErrnoException) => {
      this.server = null
      this.boundPort = null
      this.deps.onError?.(
        e.code === 'EADDRINUSE'
          ? `Port ${port} is already in use — pick another one for the trigger endpoint.`
          : `The trigger endpoint could not start: ${e.message}`
      )
    })
    server.setTimeout(REQUEST_TIMEOUT_MS)
    // Loopback only. Passing no host would bind every interface.
    server.listen(port, '127.0.0.1', () => {
      this.server = server
      // The port ACTUALLY bound, not the one requested — they differ whenever
      // the OS assigns one (port 0), and a URL naming the wrong port is worse
      // than no URL at all.
      const address = server.address()
      this.boundPort = typeof address === 'object' && address !== null ? address.port : port
    })
    // The endpoint must never be the reason the process stays alive at quit.
    server.unref()
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { enabled, token } = this.deps.settings()
    // Re-checked per request: the user may have switched it off mid-flight.
    if (!enabled || !token) {
      send(res, 404, 'Not found.')
      return
    }
    if (req.method !== 'POST') {
      send(res, 405, 'Use POST.')
      return
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      send(res, 400, 'Bad request.')
      return
    }

    // Token first, before anything about the request is echoed back: an
    // unauthenticated caller learns nothing, not even whether an id exists.
    const header = req.headers.authorization ?? ''
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
    const given = bearer || (url.searchParams.get('token') ?? '')
    if (given.length === 0 || !tokenMatches(token, given)) {
      send(res, 401, 'Unauthorized.')
      return
    }

    const match = /^\/run\/([A-Za-z0-9-]{1,64})$/.exec(url.pathname)
    if (!match) {
      send(res, 404, 'Not found.')
      return
    }
    const workflowId = match[1]
    if (!this.deps.isTriggerable(workflowId)) {
      // Deliberately one message for "no such workflow" and "not opted in":
      // an authorized caller still has no business enumerating the library.
      send(res, 403, 'That workflow does not accept triggers.')
      return
    }

    const body = await readBody(req)
    if (body === null) {
      send(res, 413, 'Payload too large.')
      return
    }

    try {
      await this.deps.run(workflowId, 'webhook', body)
      send(res, 200, 'Workflow ran.')
    } catch (e) {
      send(res, 500, e instanceof Error ? e.message : 'The workflow failed.')
    }
  }

  stop(): void {
    if (!this.server) return
    try {
      this.server.close()
    } catch {
      // Teardown only.
    }
    this.server = null
    this.boundPort = null
  }
}
