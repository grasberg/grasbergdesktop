/**
 * Retry with exponential backoff + full jitter for retryable ProviderErrors.
 */

import { ProviderError, abortedError } from './errors'

export interface RetryOptions {
  /** Number of retries after the first attempt (total attempts = retries + 1). */
  retries?: number
  signal?: AbortSignal
  onRetry?: (err: ProviderError, attempt: number, delayMs: number) => void
}

const DEFAULT_RETRIES = 2
const MAX_BACKOFF_MS = 8_000
const MAX_RETRY_AFTER_MS = 30_000

/**
 * Full jitter over min(8s, 500ms * 2^attempt); a server-provided Retry-After
 * wins (capped at 30s). `random` is injectable for deterministic tests.
 */
export function computeDelayMs(
  err: ProviderError,
  attempt: number,
  random: () => number = Math.random
): number {
  if (err.retryAfterSec !== undefined && err.retryAfterSec >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.round(err.retryAfterSec * 1000))
  }
  const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt)
  return Math.round(random() * base)
}

/** Resolves after `ms`, or rejects with an 'aborted' ProviderError on signal. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError())
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortedError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Runs `fn`, retrying only when it throws a ProviderError with retryable=true.
 * 'aborted' and 'auth' errors are never retried regardless of the flag.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw abortedError()
    try {
      return await fn(attempt)
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e
      if (!e.retryable || e.code === 'aborted' || e.code === 'auth') throw e
      if (attempt >= retries) throw e
      const delayMs = computeDelayMs(e, attempt)
      opts.onRetry?.(e, attempt, delayMs)
      await abortableSleep(delayMs, opts.signal)
    }
  }
}
