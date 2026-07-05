/**
 * Thin helpers around the IpcResult wrapper returned by every window.uld call.
 */

import type { IpcResult } from '@shared/ipc'
import type { NormalizedError } from '@shared/types'

/** Error carrying the NormalizedError produced by the main process. */
export class ApiError extends Error {
  readonly normalized: NormalizedError

  constructor(normalized: NormalizedError) {
    super(normalized.message)
    this.name = 'ApiError'
    this.normalized = normalized
  }
}

/** Awaits an IPC call and unwraps it, throwing ApiError on { ok: false }. */
export async function unwrap<T>(p: Promise<IpcResult<T>>): Promise<T> {
  const result = await p
  if (result.ok) return result.data
  throw new ApiError(result.error)
}

/** Converts any thrown value into a NormalizedError safe to store/display. */
export function toNormalized(e: unknown): NormalizedError {
  if (e instanceof ApiError) return e.normalized
  const message = e instanceof Error ? e.message : 'Something went wrong.'
  return { code: 'unknown', message, retryable: false }
}

/**
 * Extracts a safe, human-readable message from store/IPC failures
 * (NormalizedError-shaped rejections). Never inspects anything but `message`,
 * which the main process guarantees is sanitized.
 */
export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object') {
    const m = (e as { message?: unknown }).message
    if (typeof m === 'string' && m.length > 0) return m
  }
  return 'Something went wrong'
}
