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
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
  providerType: ProviderType
  /** Scrubbed from any error text (API keys, account ids). */
  secrets: string[]
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /**
   * When true, a Retry-After header feeds the normalized rate-limit error.
   * Only the OpenAI-compatible base honors it; the native adapters do not.
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
      bodyText = await res.text()
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
