/**
 * Serves the mobile web bundle (out/mobile) through the relay's asset tunnel.
 *
 * The phone loads the app from the DESKTOP, via the relay — so the UI is
 * always version-matched to the main process behind it, and the relay never
 * hosts any content. Strict by construction: GET only, one root, no traversal,
 * a hard size cap, and a fixed extension→type map. Not found outside the
 * bundle falls back to index.html so the SPA's client-side routing works.
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'

/** Largest asset served (the JS bundle gzips far below this; raw cap is 4 MB). */
const MAX_ASSET_BYTES = 4 * 1024 * 1024

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

export interface StaticResponse {
  status: number
  contentType: string
  etag: string | null
  body: Buffer
}

export interface StaticServerDeps {
  /** Directory holding the built mobile bundle (index.html at its root). */
  root: string
}

export class StaticServer {
  constructor(private readonly deps: StaticServerDeps) {}

  /**
   * Serves one GET path. `noneMatch` is the request's If-None-Match, answered
   * with a 304 when the etag matches — assets round-trip the tunnel once and
   * then live in the phone's browser cache.
   */
  async serve(path: string, noneMatch?: string | null): Promise<StaticResponse> {
    if (!path.startsWith('/') || path.includes('\0')) {
      return this.notFound()
    }
    const relative = normalize(path).replaceAll('\\', '/').replace(/^\/+/, '')
    // Reject traversal after normalization: everything must stay inside root.
    if (relative.split('/').includes('..')) return this.notFound()
    const clean = relative === '' ? 'index.html' : relative
    const looksLikeFile = clean.includes('.')
    const candidates = looksLikeFile ? [clean] : [clean, `${clean}/index.html`]
    for (const candidate of candidates) {
      const resolved = await this.tryFile(candidate, noneMatch)
      if (resolved) return resolved
    }
    // SPA fallback — extensionless paths are client-side routes. A path that
    // LOOKS like a file (has an extension) answers 404 instead: serving HTML
    // to a <script src> would fail far more confusingly.
    if (!looksLikeFile) {
      const fallback = await this.tryFile('index.html', noneMatch)
      if (fallback) return fallback
    }
    return this.notFound()
  }

  private async tryFile(relative: string, noneMatch?: string | null): Promise<StaticResponse | null> {
    let full: string
    try {
      full = join(this.deps.root, relative)
      const info = await stat(full)
      if (!info.isFile() || info.size > MAX_ASSET_BYTES) return null
    } catch {
      return null
    }
    let body: Buffer
    try {
      body = await readFile(full)
    } catch {
      return null
    }
    const extension = relative.slice(relative.lastIndexOf('.')).toLowerCase()
    const contentType = CONTENT_TYPES[extension] ?? 'application/octet-stream'
    const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 20)}"`
    if (noneMatch && noneMatch.includes(etag)) {
      return { status: 304, contentType, etag, body: Buffer.alloc(0) }
    }
    return { status: 200, contentType, etag, body }
  }

  private notFound(): StaticResponse {
    return {
      status: 404,
      contentType: 'text/plain; charset=utf-8',
      etag: null,
      body: Buffer.from('Not found.'),
    }
  }
}
