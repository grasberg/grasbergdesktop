/**
 * The local trigger endpoint — the app's only inbound network surface, so the
 * tests here are mostly about what it REFUSES: requests without the token,
 * workflows that never opted in, oversized bodies, and anything but POST.
 *
 * The loopback binding is asserted too: it is the difference between "a script
 * on this machine can start a workflow" and "so can the coffee shop".
 */

import type { Server } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowRunResult } from '@shared/types'
import { WORKFLOW_RUN_TIMEOUT_MS } from '@shared/workflow-status'
import {
  WORKFLOW_ALREADY_RUNNING_ERROR,
  WORKFLOW_NOT_FOUND_ERROR,
} from '../../../src/main/workflows/runner'
import { WorkflowTriggerServer, generateTriggerToken } from '../../../src/main/workflows/trigger-server'

const TOKEN = 'a'.repeat(32)

/**
 * A realistic provider key, shaped like the ones that show up embedded in a
 * 401 body. The endpoint answers a machine — a CI job, a git hook — whose
 * build log keeps whatever it prints, so this must never survive to the wire.
 */
const LEAKED_KEY = 'sk-live-4f9c2b8a1d6e0f37a5b9c4d2e8f1a6b3'

let server: WorkflowTriggerServer
let run: ReturnType<typeof vi.fn>
let settings: { enabled: boolean; port: number; token: string | null }
let triggerable: Set<string>
let port: number

/** What the runner resolves with — a failed run resolves, it does not reject. */
function okResult(): WorkflowRunResult {
  return { ok: true, nodeOutputs: {}, order: [] }
}

function failedResult(error: string): WorkflowRunResult {
  return { ok: false, nodeOutputs: {}, order: [], error }
}

/** Binds on an ephemeral port so parallel test files cannot collide. */
async function start(): Promise<void> {
  // Port 0 asks the OS for a free one; url() reports what it actually bound.
  settings.port = 0
  server.sync()
  // listen() is async; wait for the bound port to appear.
  for (let i = 0; i < 100 && server.url() === null; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  const url = server.url()
  if (!url) throw new Error('the endpoint never bound')
  port = Number.parseInt(new URL(url).port, 10)
}

/** The bound listener itself, so its idle timeout can be shortened for a test. */
function boundServer(): Server {
  const inner = (server as unknown as { server: Server | null }).server
  if (!inner) throw new Error('the endpoint never bound')
  return inner
}

/** Polls until the condition holds, so a test never sleeps a fixed guess. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  if (!condition()) throw new Error('condition never became true')
}

function post(
  path: string,
  init: { body?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    ...(init.headers ? { headers: init.headers } : {}),
    ...(init.body !== undefined ? { body: init.body } : {}),
  })
}

beforeEach(() => {
  run = vi.fn(async () => okResult())
  settings = { enabled: true, port: 0, token: TOKEN }
  triggerable = new Set(['wf-open'])
  server = new WorkflowTriggerServer({
    settings: () => settings,
    isTriggerable: (id) => triggerable.has(id),
    run,
  })
})

afterEach(() => {
  server.stop()
})

describe('generateTriggerToken', () => {
  it('is long and different every time', () => {
    const a = generateTriggerToken()
    const b = generateTriggerToken()
    expect(a).toHaveLength(32)
    expect(a).not.toBe(b)
  })
})

describe('WorkflowTriggerServer', () => {
  it('does not listen at all until it is switched on', () => {
    settings.enabled = false
    server.sync()
    expect(server.running).toBe(false)
    expect(server.url()).toBeNull()
  })

  it('does not listen without a token', () => {
    settings.token = null
    server.sync()
    expect(server.running).toBe(false)
  })

  it('binds loopback only, and reports a URL carrying the token', async () => {
    await start()
    const url = server.url('wf-open')
    expect(url).toContain('http://127.0.0.1:')
    expect(url).toContain('/run/wf-open')
    expect(url).toContain(`token=${TOKEN}`)
  })

  it('runs an opted-in workflow and hands it the request body', async () => {
    await start()
    const res = await post(`/run/wf-open?token=${TOKEN}`, { body: 'commit abc123' })
    expect(res.status).toBe(200)
    expect(run).toHaveBeenCalledWith('wf-open', 'webhook', 'commit abc123')
  })

  it('accepts the token as a bearer header instead of a query parameter', async () => {
    await start()
    const res = await post('/run/wf-open', {
      headers: { authorization: `Bearer ${TOKEN}` },
      body: '',
    })
    expect(res.status).toBe(200)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('refuses a missing or wrong token before looking at anything else', async () => {
    await start()
    expect((await post('/run/wf-open')).status).toBe(401)
    expect((await post('/run/wf-open?token=wrong')).status).toBe(401)
    // Even for a workflow that does not exist: an unauthenticated caller must
    // not be able to probe which ids are real.
    expect((await post('/run/nope?token=wrong')).status).toBe(401)
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a workflow that did not opt in — same answer as one that does not exist', async () => {
    await start()
    const closed = await post(`/run/wf-closed?token=${TOKEN}`)
    const missing = await post(`/run/wf-missing?token=${TOKEN}`)
    expect(closed.status).toBe(403)
    expect(missing.status).toBe(403)
    expect(await closed.text()).toBe(await missing.text())
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses anything but POST', async () => {
    await start()
    const res = await fetch(`http://127.0.0.1:${port}/run/wf-open?token=${TOKEN}`)
    expect(res.status).toBe(405)
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses an unknown path', async () => {
    await start()
    expect((await post(`/?token=${TOKEN}`)).status).toBe(404)
    expect((await post(`/run/?token=${TOKEN}`)).status).toBe(404)
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses an oversized body instead of buffering it', async () => {
    await start()
    const res = await post(`/run/wf-open?token=${TOKEN}`, { body: 'x'.repeat(70 * 1024) })
    expect(res.status).toBe(413)
    expect(run).not.toHaveBeenCalled()
  })

  it('reports a failing run as a 500 rather than swallowing it', async () => {
    run.mockRejectedValueOnce(new Error('the graph blew up'))
    await start()
    const res = await post(`/run/wf-open?token=${TOKEN}`)
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('the graph blew up')
  })

  it('reports a run that RESOLVES as failed with a non-2xx status too', async () => {
    // The runner resolves { ok: false } instead of rejecting, so a CI job or a
    // git hook gating on the HTTP status would otherwise read a failure as 200.
    run.mockResolvedValueOnce(failedResult('the model node returned nothing'))
    await start()
    const res = await post(`/run/wf-open?token=${TOKEN}`)
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('the model node returned nothing')
  })

  it('redacts a secret out of a thrown failure before it leaves the machine', async () => {
    // This is the app's only EGRESS of provider error text to a third party. A
    // provider 401 routinely quotes the key it rejected, and the caller here is
    // a CI job or a git hook whose log keeps the response body forever.
    run.mockRejectedValueOnce(
      new Error(`ai_agent node failed: 401 Unauthorized — invalid api key ${LEAKED_KEY}`)
    )
    await start()
    const res = await post(`/run/wf-open?token=${TOKEN}`)
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).not.toContain(LEAKED_KEY)
    expect(body).toContain('[redacted]')
    // The diagnosis still has to survive — redaction, not an empty answer.
    expect(body).toContain('401 Unauthorized')
  })

  it('redacts a secret out of a run that RESOLVES as failed too', async () => {
    // The two failure paths are separate call sites; a refactor can drop the
    // redaction from either one, so both are pinned.
    run.mockResolvedValueOnce(
      failedResult(`ai_agent node failed: 401 Unauthorized — invalid api key ${LEAKED_KEY}`)
    )
    await start()
    const res = await post(`/run/wf-open?token=${TOKEN}`)
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).not.toContain(LEAKED_KEY)
    expect(body).toContain('[redacted]')
    expect(body).toContain('401 Unauthorized')
  })

  it('answers 409 when the runner refuses because a run is already in flight', async () => {
    // The runner rejects this before starting anything, so it is not a broken
    // graph: a hook gating on the status has to be able to back off and retry
    // rather than page whoever owns the workflow. The message comes from the
    // runner's own constant, so a reword there cannot desynchronize the two.
    run.mockRejectedValueOnce(new Error(WORKFLOW_ALREADY_RUNNING_ERROR))
    await start()
    const res = await post(`/run/wf-open?token=${TOKEN}`)
    expect(res.status).toBe(409)
    expect(await res.text()).toContain(WORKFLOW_ALREADY_RUNNING_ERROR)
  })

  it('answers 404 when the workflow vanished between the opt-in check and the run', async () => {
    run.mockRejectedValueOnce(new Error(WORKFLOW_NOT_FOUND_ERROR))
    await start()
    const res = await post(`/run/wf-open?token=${TOKEN}`)
    expect(res.status).toBe(404)
  })

  it('does not lend the pre-start statuses to a graph failure that talks about them', async () => {
    // Matching is exact, not substring — on BOTH messages. A node reporting
    // "the deploy job is already running" is a failure, and answering 409 would
    // tell CI to retry; "model not found" / "404 not found" / "file not found"
    // are routine node failures, and answering 404 would claim the workflow
    // itself is missing and stop the hook from ever being fixed.
    run.mockRejectedValueOnce(new Error('node deploy failed: the job is already running.'))
    run.mockRejectedValueOnce(new Error('ai_agent node failed: model not found (404 not found)'))
    await start()
    expect((await post(`/run/wf-open?token=${TOKEN}`)).status).toBe(500)
    expect((await post(`/run/wf-open?token=${TOKEN}`)).status).toBe(500)
  })

  it('answers a run that outlasts the connection idle timeout', async () => {
    await start()
    // The real guard is 10 s; shortened here so the test stays fast while
    // exercising the same mechanism. Node applies it as an IDLE timeout on the
    // whole connection, and a run moves no bytes for as long as it takes — with
    // the guard left armed the socket is destroyed and the eventual response is
    // written into a dead connection, so the caller sees a reset for a run that
    // succeeded.
    boundServer().setTimeout(250)
    let finishRun = (): void => undefined
    run.mockImplementationOnce(
      () =>
        new Promise<WorkflowRunResult>((resolve) => {
          finishRun = () => resolve(okResult())
        })
    )
    const pending = post(`/run/wf-open?token=${TOKEN}`, { body: 'commit abc123' })
    await new Promise((r) => setTimeout(r, 800))
    finishRun()
    const res = await pending
    expect(res.status).toBe(200)
  })

  it('loosens the idle guard for the run instead of removing it', async () => {
    await start()
    const sockets: Socket[] = []
    boundServer().on('connection', (socket: Socket) => sockets.push(socket))
    let finishRun = (): void => undefined
    run.mockImplementationOnce(
      () =>
        new Promise<WorkflowRunResult>((resolve) => {
          finishRun = () => resolve(okResult())
        })
    )
    const pending = post(`/run/wf-open?token=${TOKEN}`, { body: 'commit abc123' })
    await until(() => run.mock.calls.length > 0)
    // A node that ignores its AbortSignal must not be able to pin the socket —
    // and with it server.close() — forever, so the guard is widened past the
    // runner's own wall-clock cap rather than switched off.
    const timeout = sockets[0]?.timeout
    expect(timeout).toBeGreaterThan(WORKFLOW_RUN_TIMEOUT_MS)
    // Bounded on the other side too: an effectively-infinite guard (or one
    // large enough to overflow Node's timer) is the same as having none, which
    // is exactly what the widening is not allowed to become.
    expect(timeout).toBeLessThanOrEqual(WORKFLOW_RUN_TIMEOUT_MS * 2)
    finishRun()
    expect((await pending).status).toBe(200)
  })

  it('stops answering the moment it is switched off', async () => {
    await start()
    settings.enabled = false
    // Still bound, but every request is refused — the toggle is re-read per
    // request so turning it off does not wait for a rebind.
    const res = await post(`/run/wf-open?token=${TOKEN}`)
    expect(res.status).toBe(404)
    expect(run).not.toHaveBeenCalled()
  })

  it('stop() releases the port', async () => {
    await start()
    server.stop()
    expect(server.running).toBe(false)
    await expect(post(`/run/wf-open?token=${TOKEN}`)).rejects.toThrow()
  })
})
