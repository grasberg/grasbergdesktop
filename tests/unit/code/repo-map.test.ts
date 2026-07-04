import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RepoMapService, tokenize } from '../../../src/main/code/repo-map'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-repomap-'))
  mkdirSync(join(dir, 'src', 'keys'), { recursive: true })
  mkdirSync(join(dir, 'src', 'providers'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'junk'), { recursive: true })

  writeFileSync(
    join(dir, 'src', 'keys', 'keystore.ts'),
    `export function encryptKey(plain: string) { return plain }
     export function decryptKey(stored: string) { return stored }
     export class Keystore {}`
  )
  writeFileSync(
    join(dir, 'src', 'providers', 'errors.ts'),
    `export function normalizeHttpError(status: number) { return status }
     export class ProviderError extends Error {}`
  )
  writeFileSync(join(dir, 'README.md'), '# Project\nAbout encryption and keys.')
  // A file inside node_modules must never be indexed.
  writeFileSync(join(dir, 'node_modules', 'junk', 'index.js'), 'export function encryptKey() {}')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('tokenize', () => {
  it('splits identifiers on camelCase and separators', () => {
    expect(tokenize('encryptKey')).toEqual(['encrypt', 'key'])
    expect(tokenize('normalize_http_error')).toEqual(['normalize', 'http', 'error'])
    expect(tokenize('src/keys/keystore.ts')).toEqual(['src', 'keys', 'keystore', 'ts'])
  })
})

describe('RepoMapService', () => {
  it('ranks the most relevant file first and returns its symbols', async () => {
    const svc = new RepoMapService()
    const hits = await svc.search('p1', dir, 'encrypt key', 10)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].relPath).toBe('src/keys/keystore.ts')
    expect(hits[0].symbols).toEqual(
      expect.arrayContaining(['encryptKey', 'decryptKey', 'Keystore'])
    )
  })

  it('never indexes files inside ignored directories', async () => {
    const svc = new RepoMapService()
    const hits = await svc.search('p1', dir, 'encrypt key', 30)
    expect(hits.every((h) => !h.relPath.includes('node_modules'))).toBe(true)
  })

  it('finds a different file by its symbols', async () => {
    const svc = new RepoMapService()
    const hits = await svc.search('p1', dir, 'normalize http error', 10)
    expect(hits[0].relPath).toBe('src/providers/errors.ts')
  })

  it('rebuilds the index when the file set changes', async () => {
    const svc = new RepoMapService()
    await svc.search('p1', dir, 'widget', 10)
    // A brand-new file changes the signature (file count), forcing a rebuild.
    writeFileSync(join(dir, 'src', 'widget.ts'), 'export function renderWidget() {}')
    const hits = await svc.search('p1', dir, 'render widget', 10)
    expect(hits[0].relPath).toBe('src/widget.ts')
    expect(hits[0].symbols).toContain('renderWidget')
  })

  it('returns an empty list for a query with no matches', async () => {
    const svc = new RepoMapService()
    expect(await svc.search('p1', dir, 'zzzznotarealtoken', 10)).toEqual([])
  })
})
