import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StaticServer } from '../../../src/main/remote/static'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-static-test-'))
  writeFileSync(join(dir, 'index.html'), '<html>mobile</html>')
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("app")')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('StaticServer (mobile bundle)', () => {
  it('serves index.html for /', async () => {
    const server = new StaticServer({ root: dir })
    const res = await server.serve('/')
    expect(res.status).toBe(200)
    expect(res.contentType).toBe('text/html; charset=utf-8')
    expect(res.body.toString()).toContain('mobile')
    expect(res.etag).toBeTruthy()
  })

  it('serves nested assets with the right content type', async () => {
    const server = new StaticServer({ root: dir })
    const res = await server.serve('/assets/app.js')
    expect(res.status).toBe(200)
    expect(res.contentType).toBe('text/javascript; charset=utf-8')
    expect(res.body.toString()).toContain('console.log')
  })

  it('falls back to index.html for extensionless SPA routes', async () => {
    const server = new StaticServer({ root: dir })
    const res = await server.serve('/conversation/abc-123')
    expect(res.status).toBe(200)
    expect(res.contentType).toBe('text/html; charset=utf-8')
  })

  it('answers 304 when If-None-Match carries the etag', async () => {
    const server = new StaticServer({ root: dir })
    const first = await server.serve('/index.html')
    const second = await server.serve('/index.html', first.etag)
    expect(second.status).toBe(304)
    expect(second.body.length).toBe(0)
  })

  it('refuses traversal attempts', async () => {
    const server = new StaticServer({ root: dir })
    writeFileSync(join(dir, '..', 'uld-static-secret.txt'), 'secret')
    for (const path of ['/../uld-static-secret.txt', '/%2e%2e/uld-static-secret.txt', '/..\\uld-static-secret.txt']) {
      const res = await server.serve(path)
      // Either refused outright or (URL-encoded variants, which are not real
      // path segments after our normalize) served the SPA fallback — never
      // the file itself.
      expect(res.body.toString()).not.toContain('secret')
    }
    rmSync(join(dir, '..', 'uld-static-secret.txt'), { force: true })
  })

  it('answers 404 for missing files with extensions', async () => {
    const server = new StaticServer({ root: dir })
    const res = await server.serve('/missing.js')
    expect(res.status).toBe(404)
  })
})
