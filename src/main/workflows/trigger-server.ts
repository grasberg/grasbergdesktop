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
import type { WorkflowRunResult, WorkflowRunTrigger } from '@shared/types'
import { WORKFLOW_RUN_TIMEOUT_MS } from '@shared/workflow-status'
import { redactSecrets } from '../providers/redact'
import { WORKFLOW_ALREADY_RUNNING_ERROR, WORKFLOW_NOT_FOUND_ERROR } from './runner'

/** Request body accepted, in bytes. Anything larger is refused outright. */
const MAX_BODY_BYTES = 64 * 1024
/**
 * A slow or hanging client must not hold a socket open indefinitely. Node
 * applies this as an IDLE timeout on the whole connection, so it covers reading
 * the headers and the body ONLY — handle() loosens it before awaiting the run,
 * which legitimately moves no bytes for minutes.
 */
const REQUEST_TIMEOUT_MS = 10_000
/**
 * Idle cap while the run is in flight. It has to outlast any run the runner
 * itself permits (it aborts at WORKFLOW_RUN_TIMEOUT_MS), but it must stay
 * FINITE: a graph node that ignores its AbortSignal would otherwise pin the
 * socket — and block server.close() — forever.
 */
const RUN_TIMEOUT_MS = WORKFLOW_RUN_TIMEOUT_MS + 60_000
// The runner refuses two cases before it starts anything, and the message is
// the only signal it gives. They are imported from runner.ts rather than
// copied: a copy drifts silently on a reword, and the failure mode is a
// concurrent trigger quietly answering 500 instead of 409. Matched EXACTLY —
// a graph that genuinely failed ("model not found") can never borrow a status
// that tells a caller the run never started.

export interface TriggerServerDeps {
  /** Live settings read per request, so a toggle takes effect immediately. */
  settings: () => { enabled: boolean; port: number; token: string | null }
  /** True when this workflow exists AND opted into being triggered. */
  isTriggerable: (workflowId: string) => boolean
  /** True when this bot exists, is enabled AND opted into webhook wakes (v50). */
  isAgentTriggerable?: (agentId: string) => boolean
  /**
   * Queues one event turn in the bot's chat (v50). Resolves once queued —
   * the caller gets 202, never waits for the bot's reply.
   */
  wakeAgent?: (agentId: string, payload: string) => Promise<void>
  /**
   * Starts the run and resolves with its result when it finishes. A failed run
   * RESOLVES with { ok: false } rather than rejecting, so the outcome has to be
   * inspected — both it and a rejection are reported as 5xx, except for the two
   * refusals the runner rejects with before starting (409 / 404).
   */
  run: (
    workflowId: string,
    trigger: WorkflowRunTrigger,
    payload: string
  ) => Promise<WorkflowRunResult>
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
    let settled = false
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // Stop reading but do NOT destroy the socket here: the caller still has
        // to write a 413, and a destroyed socket turns that into an ECONNRESET
        // the client sees instead of the status code. Pausing halts the flood;
        // handle() releases the socket after responding.
        settled = true
        req.pause()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', () => {
      if (!settled) resolve(null)
    })
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
  // The port a currently-tracked server was asked to bind. Set synchronously in
  // listen() (boundPort is only known later, in the async callback), so a
  // second sync() during the bind window recognises the in-flight server
  // instead of starting a duplicate that orphans the first on EADDRINUSE.
  private requestedPort: number | null = null

  constructor(private readonly deps: TriggerServerDeps) {}

  /** The URL to paste into a hook, or null while the endpoint is off. */
  url(workflowId = '<workflow-id>'): string | null {
    const { enabled, token } = this.deps.settings()
    if (!enabled || !token || this.boundPort === null) return null
    return `http://127.0.0.1:${this.boundPort}/run/${workflowId}?token=${token}`
  }

  /** The URL that wakes a bot (v50), or null while the endpoint is off. */
  agentUrl(agentId = '<bot-id>'): string | null {
    const { enabled, token } = this.deps.settings()
    if (!enabled || !token || this.boundPort === null) return null
    return `http://127.0.0.1:${this.boundPort}/agent/${agentId}?token=${token}`
  }

  /** True once the listener is actually bound (not merely mid-bind). */
  get running(): boolean {
    return this.boundPort !== null
  }

  /** Applies the current settings: (re)binds, rebinds on a port change, or stops. */
  sync(): void {
    const { enabled, port, token } = this.deps.settings()
    if (!enabled || !token || process.env.SMOKE_TEST === '1') {
      this.stop()
      return
    }
    if (this.server && this.requestedPort === port) return
    this.stop()
    this.listen(port)
  }

  private listen(port: number): void {
    const server = createServer((req, res) => {
      void this.handle(req, res)
    })
    // Claim the slot synchronously so a concurrent sync() sees this server as
    // in-flight (boundPort is not known until the listen callback fires).
    this.server = server
    this.requestedPort = port
    server.on('error', (e: NodeJS.ErrnoException) => {
      // Only disown the server if it is still the one we are tracking — a later
      // rebind may already have replaced it.
      if (this.server === server) {
        this.server = null
        this.boundPort = null
        this.requestedPort = null
      }
      this.deps.onError?.(
        e.code === 'EADDRINUSE'
          ? `Port ${port} is already in use — pick another one for the trigger endpoint.`
          : `The trigger endpoint could not start: ${e.message}`
      )
    })
    server.setTimeout(REQUEST_TIMEOUT_MS)
    // Loopback only. Passing no host would bind every interface.
    server.listen(port, '127.0.0.1', () => {
      // Ignore a stale callback for a server we've since replaced/stopped.
      if (this.server !== server) return
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

    const match = /^\/(run|agent)\/([A-Za-z0-9-]{1,64})$/.exec(url.pathname)
    if (!match) {
      send(res, 404, 'Not found.')
      return
    }
    const kind = match[1]
    const workflowId = match[2]
    if (kind === 'run' && !this.deps.isTriggerable(workflowId)) {
      // Deliberately one message for "no such workflow" and "not opted in":
      // an authorized caller still has no business enumerating the library.
      send(res, 403, 'That workflow does not accept triggers.')
      return
    }
    if (kind === 'agent' && !(this.deps.isAgentTriggerable?.(workflowId) ?? false)) {
      // Same rule for bots (v50): each one opts in individually.
      send(res, 403, 'That bot does not accept triggers.')
      return
    }

    const body = await readBody(req)
    if (body === null) {
      res.setHeader('connection', 'close')
      res.once('finish', () => req.destroy())
      send(res, 413, 'Payload too large.')
      // Drain without retaining bytes. Destroying immediately races the 413
      // write and makes callers observe ECONNRESET instead of the status.
      req.resume()
      return
    }

    // The request is fully read, so the slow-client guard has done its job.
    // Leaving 10 s armed across the run would destroy the socket long before a
    // workflow with an LLM node finishes, and the response would be written
    // into a dead connection — a successful run answering the caller with a
    // reset. Loosened rather than cleared, so a run that never settles still
    // releases the socket. Nothing is restored afterwards: once the response
    // finishes Node re-arms the socket with keepAliveTimeout itself.
    req.socket?.setTimeout(RUN_TIMEOUT_MS)
    if (kind === 'agent') {
      // A bot wake is queued, not awaited: the bot may take minutes and may
      // even stop to ask the user something.
      try {
        await this.deps.wakeAgent?.(workflowId, body)
        send(res, 202, 'Event queued for the bot.')
      } catch (e) {
        send(res, 500, redactSecrets(e instanceof Error ? e.message : 'The wake failed.'))
      }
      return
    }
    try {
      const result = await this.deps.run(workflowId, 'webhook', body)
      if (!result.ok) {
        send(res, 500, redactSecrets(result.error ?? 'The workflow failed.'))
        return
      }
      send(res, 200, 'Workflow ran.')
    } catch (e) {
      const message = e instanceof Error ? e.message : ''
      // Neither of these is a broken graph — the run never started. A hook or a
      // CI job gating on the status can back off on a 409 and page someone on a
      // 5xx. Both are races (isTriggerable said yes moments ago), so answering
      // 404 here still tells an authorized caller nothing it did not know.
      if (message === WORKFLOW_ALREADY_RUNNING_ERROR) {
        send(res, 409, WORKFLOW_ALREADY_RUNNING_ERROR)
        return
      }
      if (message === WORKFLOW_NOT_FOUND_ERROR) {
        send(res, 404, WORKFLOW_NOT_FOUND_ERROR)
        return
      }
      send(res, 500, redactSecrets(message || 'The workflow failed.'))
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
    this.requestedPort = null
  }
}
