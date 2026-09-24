/**
 * Shared HTTP plumbing for provider adapters: URL joining, a checked fetch
 * that normalizes transport failures and non-2xx responses to ProviderErrors
 * (with secrets redacted), and the empty-stream-body guard.
 */

import type { ProviderType } from '@shared/types'
import { ProviderError, normalizeHttpError, toProviderError } from './errors'

/** baseUrl arrives with no trailing-slash guarantee — normalize before joining. */
export function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.trim().replace(/\/+$/, '') + path
}

/**
 * Only the first ~200-300 chars of an error body are ever surfaced, so there is
 * no reason to buffer a potentially huge error page in full. Read at most this
 * many bytes before giving up on the rest.
 */
const ERROR_BODY_MAX_BYTES = 64 * 1024

/** Reads at most `maxBytes` of a response body as UTF-8, then stops. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return await res.text()
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let out = ''
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      out += decoder.decode(value, { stream: true })
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Body may already be closed/errored — nothing to do.
    }
  }
  return out + decoder.decode()
}

/**
 * Reads a response body as bytes, cancelling the stream the moment the running
 * total exceeds `maxBytes` — an oversized (or endless) body is never buffered in
 * full. Returns undefined when the cap is exceeded; callers raise their own
 * 'too large' error.
 */
export async function readBytesCapped(
  res: Response,
  maxBytes: number
): Promise<Uint8Array | undefined> {
  if (!res.body) {
    const whole = new Uint8Array(await res.arrayBuffer())
    return whole.byteLength > maxBytes ? undefined : whole
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) return undefined
      chunks.push(value)
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Body may already be closed/errored — nothing to do.
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** Retry-After is either delta-seconds or an HTTP date. */
function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined
  const secs = Number(headerValue)
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs)
  const date = Date.parse(headerValue)
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000))
  return undefined
}

export interface CheckedFetchOptions {
  method: 'GET' | 'POST'
  redirect?: RequestInit['redirect']
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
  providerType: ProviderType
  /** Scrubbed from any error text (API keys, account ids). */
  secrets: string[]
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /**
   * When true, a Retry-After header feeds the normalized rate-limit error so
   * the retry/backoff can honor the server-instructed wait. Enabled by the
   * OpenAI-compatible base and the native adapters (Anthropic/Google both send
   * it on 429).
   */
  honorRetryAfter?: boolean
}

/**
 * Fetch that only ever throws ProviderError: transport failures pass through
 * toProviderError, non-2xx responses through normalizeHttpError.
 */
export async function checkedFetch(url: string, opts: CheckedFetchOptions): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: opts.method,
      ...(opts.redirect ? { redirect: opts.redirect } : {}),
      headers: opts.headers,
      body: opts.body,
      signal: opts.signal,
    })
  } catch (e) {
    throw toProviderError(e, opts.providerType, opts.secrets)
  }
  if (!res.ok) {
    let bodyText = ''
    try {
      bodyText = await readCapped(res, ERROR_BODY_MAX_BYTES)
    } catch {
      // Body unavailable — normalize from status alone.
    }
    throw normalizeHttpError(
      res.status,
      bodyText,
      opts.providerType,
      opts.honorRetryAfter ? parseRetryAfterSeconds(res.headers.get('retry-after')) : undefined,
      opts.secrets
    )
  }
  return res
}

/** Guards a streaming response's body; `displayName` keeps each adapter's exact message. */
export function requireStreamBody(
  res: Response,
  displayName: string,
  providerType: ProviderType
): ReadableStream<Uint8Array> {
  if (!res.body) {
    throw new ProviderError('server', `${displayName} returned an empty streaming response.`, {
      retryable: false,
      providerType,
    })
  }
  return res.body
}
