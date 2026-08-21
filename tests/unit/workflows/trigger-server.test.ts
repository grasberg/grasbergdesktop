/**
 * The local trigger endpoint — the app's only inbound network surface, so the
 * tests here are mostly about what it REFUSES: requests without the token,
 * workflows that never opted in, oversized bodies, and anything but POST.
 *
 * The loopback binding is asserted too: it is the difference between "a script
 * on this machine can start a workflow" and "so can the coffee shop".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowTriggerServer, generateTriggerToken } from '../../../src/main/workflows/trigger-server'

const TOKEN = 'a'.repeat(32)

let server: WorkflowTriggerServer
let run: ReturnType<typeof vi.fn>
let settings: { enabled: boolean; port: number; token: string | null }
let triggerable: Set<string>
let port: number

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
  run = vi.fn(async () => undefined)
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
    const res = await post(`/run/wf-open?token=${TOKEN}`, { body: 'x'.repeat(70 * 1024) }).catch(
      () => null
    )
    // The connection is destroyed once the cap is passed, so either a 413 or a
    // dropped socket is acceptable — what matters is that nothing ran.
    if (res) expect(res.status).toBe(413)
    expect(run).not.toHaveBeenCalled()
  })

  it('reports a failing run as a 500 rather than swallowing it', async () => {
    run.mockRejectedValueOnce(new Error('the graph blew up'))
    await start()
    const res = await post(`/run/wf-open?token=${TOKEN}`)
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('the graph blew up')
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
