/**
 * Normalized provider errors. All adapter failures are ProviderError instances
 * whose messages are safe to show and log (redacted, never containing keys).
 */

import type { NormalizedError, ProviderErrorCode, ProviderType } from '@shared/types'
import { oaiErrorBodySchema } from '@shared/schemas'
import { redactSecrets } from './redact'

const DEFAULT_RETRYABLE: Record<ProviderErrorCode, boolean> = {
  auth: false,
  rate_limit: true,
  invalid_request: false,
  context_length: false,
  server: true,
  network: true,
  timeout: true,
  aborted: false,
  not_supported: false,
  unknown: false,
}

export interface ProviderErrorOptions {
  status?: number
  retryAfterSec?: number
  /** Defaults per code (rate_limit/server/network/timeout retryable). */
  retryable?: boolean
  providerType?: ProviderType
  cause?: unknown
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly status?: number
  readonly retryAfterSec?: number
  readonly retryable: boolean
  readonly providerType?: ProviderType

  constructor(code: ProviderErrorCode, message: string, opts: ProviderErrorOptions = {}) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.status = opts.status
    this.retryAfterSec = opts.retryAfterSec
    this.retryable = opts.retryable ?? DEFAULT_RETRYABLE[code]
    this.providerType = opts.providerType
    if (opts.cause !== undefined) this.cause = opts.cause
  }

  toNormalized(): NormalizedError {
    return toNormalizedError(this)
  }
}

export function abortedError(providerType?: ProviderType): ProviderError {
  return new ProviderError('aborted', 'Request was cancelled.', {
    retryable: false,
    providerType,
  })
}

function isAbortError(e: Error): boolean {
  return e.name === 'AbortError'
}

/** undici wraps the real socket/DNS failure in `cause`. */
function networkDetail(e: Error): string | undefined {
  const cause = (e as { cause?: unknown }).cause
  if (cause instanceof Error && cause.message) return cause.message
  if (e.message && e.message !== 'fetch failed') return e.message
  return undefined
}

/**
 * Maps any thrown value to a NormalizedError safe for IPC/logging.
 * The message is always passed through redactSecrets.
 */
export function toNormalizedError(
  e: unknown,
  providerType?: ProviderType,
  secrets?: string[]
): NormalizedError {
  if (e instanceof ProviderError) {
    return {
      code: e.code,
      message: redactSecrets(e.message, secrets),
      ...(e.status !== undefined ? { status: e.status } : {}),
      ...(e.retryAfterSec !== undefined ? { retryAfterSec: e.retryAfterSec } : {}),
      retryable: e.retryable,
      ...((e.providerType ?? providerType) !== undefined
        ? { providerType: e.providerType ?? providerType }
        : {}),
    }
  }
  if (e instanceof Error) {
    if (isAbortError(e)) {
      return {
        code: 'aborted',
        message: 'Request was cancelled.',
        retryable: false,
        ...(providerType ? { providerType } : {}),
      }
    }
    if (e.name === 'TimeoutError') {
      return {
        code: 'timeout',
        message: 'The request timed out — try again.',
        retryable: true,
        ...(providerType ? { providerType } : {}),
      }
    }
    if (
      e instanceof TypeError ||
      /fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/i.test(e.message)
    ) {
      const detail = networkDetail(e)
      return {
        code: 'network',
        message: redactSecrets(
          `Could not reach the provider${detail ? ` (${detail})` : ''} — check the base URL and your internet connection.`,
          secrets
        ),
        retryable: true,
        ...(providerType ? { providerType } : {}),
      }
    }
    return {
      code: 'unknown',
      message: redactSecrets(e.message || 'Unexpected error.', secrets),
      retryable: false,
      ...(providerType ? { providerType } : {}),
    }
  }
  return {
    code: 'unknown',
    message: 'Unexpected error.',
    retryable: false,
    ...(providerType ? { providerType } : {}),
  }
}

/** Like toNormalizedError but yields a throwable ProviderError. */
export function toProviderError(
  e: unknown,
  providerType?: ProviderType,
  secrets?: string[]
): ProviderError {
  if (e instanceof ProviderError) return e
  const n = toNormalizedError(e, providerType, secrets)
  return new ProviderError(n.code, n.message, {
    status: n.status,
    retryAfterSec: n.retryAfterSec,
    retryable: n.retryable,
    providerType: n.providerType,
    cause: e,
  })
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Pulls a human-readable message out of an (OpenAI-ish) error body, if any. */
function extractProviderMessage(bodyText: string): string | undefined {
  const trimmed = bodyText.trim()
  if (!trimmed) return undefined
  try {
    const parsed = oaiErrorBodySchema.safeParse(JSON.parse(trimmed))
    if (parsed.success) {
      const msg = parsed.data.error?.message ?? parsed.data.message
      if (msg) return truncate(msg, 300)
    }
    return undefined
  } catch {
    // Non-JSON body: surface short plain text, never HTML error pages.
    if (trimmed.startsWith('<')) return undefined
    return truncate(trimmed, 200)
  }
}

const CONTEXT_LENGTH_RE =
  /context[\s_-]?(length|window)|maximum context|too many tokens|token limit|prompt (is )?too long|input (is )?too long|exceeds? .{0,60}(context|token)/i

/**
 * Maps a non-2xx HTTP response to a ProviderError with a human-friendly,
 * redacted message. `retryAfterSec` should come from the Retry-After header.
 * `secrets` (e.g. the API key) are scrubbed from any provider-sourced text.
 */
export function normalizeHttpError(
  status: number,
  bodyText: string,
  providerType?: ProviderType,
  retryAfterSec?: number,
  secrets?: string[]
): ProviderError {
  const raw = extractProviderMessage(bodyText)
  const detail = raw ? redactSecrets(raw, secrets) : undefined
  const suffix = detail ? ` (${detail})` : ''

  if (status === 401 || status === 403) {
    return new ProviderError(
      'auth',
      `Invalid or missing API key — check this provider's key in Settings.${suffix}`,
      { status, retryable: false, providerType }
    )
  }
  if (status === 429) {
    const wait = retryAfterSec !== undefined ? ` Retry in ~${retryAfterSec}s.` : ''
    return new ProviderError(
      'rate_limit',
      `Rate limited by the provider — too many requests.${wait}${suffix}`,
      { status, retryAfterSec, retryable: true, providerType }
    )
  }
  if (status === 400 || status === 404 || status === 422) {
    if (detail && CONTEXT_LENGTH_RE.test(detail)) {
      return new ProviderError(
        'context_length',
        `The conversation is too long for this model's context window — shorten it or start a new chat.${suffix}`,
        { status, retryable: false, providerType }
      )
    }
    return new ProviderError(
      'invalid_request',
      detail
        ? `The provider rejected the request: ${detail}`
        : 'The provider rejected the request — check the model id and parameters.',
      { status, retryable: false, providerType }
    )
  }
  if (status === 408) {
    return new ProviderError('timeout', `The provider timed out handling the request.${suffix}`, {
      status,
      retryable: true,
      providerType,
    })
  }
  if (status >= 500) {
    return new ProviderError(
      'server',
      `The provider had a server error (HTTP ${status}) — try again in a moment.${suffix}`,
      { status, retryable: true, providerType }
    )
  }
  if (status >= 400) {
    return new ProviderError(
      'invalid_request',
      `The provider rejected the request (HTTP ${status}).${suffix}`,
      { status, retryable: false, providerType }
    )
  }
  return new ProviderError('unknown', `Unexpected provider response (HTTP ${status}).${suffix}`, {
    status,
    retryable: false,
    providerType,
  })
}
