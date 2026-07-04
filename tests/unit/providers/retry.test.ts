import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderError } from '../../../src/main/providers/errors'
import { computeDelayMs, withRetry } from '../../../src/main/providers/retry'

function serverError(opts: { retryAfterSec?: number } = {}): ProviderError {
  return new ProviderError('server', 'boom', { status: 500, ...opts })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('computeDelayMs', () => {
  it('applies full jitter over an exponentially growing base', () => {
    const err = serverError()
    expect(computeDelayMs(err, 0, () => 1)).toBe(500)
    expect(computeDelayMs(err, 1, () => 1)).toBe(1000)
    expect(computeDelayMs(err, 2, () => 1)).toBe(2000)
    expect(computeDelayMs(err, 0, () => 0)).toBe(0)
    expect(computeDelayMs(err, 1, () => 0.5)).toBe(500)
  })

  it('caps the backoff base at 8s', () => {
    expect(computeDelayMs(serverError(), 20, () => 1)).toBe(8000)
  })

  it('honors retryAfterSec over the backoff (capped at 30s)', () => {
    expect(computeDelayMs(serverError({ retryAfterSec: 7 }), 0, () => 1)).toBe(7000)
    expect(computeDelayMs(serverError({ retryAfterSec: 120 }), 0, () => 1)).toBe(30000)
  })
})

describe('withRetry', () => {
  it('retries retryable errors with jittered delays inside the expected bounds', async () => {
    vi.useFakeTimers()
    const delays: Array<{ attempt: number; delayMs: number }> = []
    const fn = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(serverError())
      .mockRejectedValueOnce(serverError())
      .mockResolvedValueOnce('ok')

    const settled = withRetry(fn, {
      onRetry: (_err, attempt, delayMs) => delays.push({ attempt, delayMs }),
    })
    await vi.runAllTimersAsync()

    expect(await settled).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(delays).toHaveLength(2)
    // Full jitter: exact values vary, but each stays within [0, 500 * 2^attempt].
    expect(delays[0].attempt).toBe(0)
    expect(delays[0].delayMs).toBeGreaterThanOrEqual(0)
    expect(delays[0].delayMs).toBeLessThanOrEqual(500)
    expect(delays[1].attempt).toBe(1)
    expect(delays[1].delayMs).toBeGreaterThanOrEqual(0)
    expect(delays[1].delayMs).toBeLessThanOrEqual(1000)
  })

  it('honors retryAfterSec for the backoff duration', async () => {
    vi.useFakeTimers()
    const delays: number[] = []
    const fn = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(serverError({ retryAfterSec: 7 }))
      .mockResolvedValueOnce('ok')

    const settled = withRetry(fn, { onRetry: (_e, _a, delayMs) => delays.push(delayMs) })

    // Not resolved before the mandated wait has elapsed...
    await vi.advanceTimersByTimeAsync(6999)
    expect(fn).toHaveBeenCalledTimes(1)
    // ...but immediately after.
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled).toBe('ok')
    expect(delays).toEqual([7000])
  })

  it('stops after opts.retries and rethrows the last error', async () => {
    vi.useFakeTimers()
    const fn = vi.fn<(attempt: number) => Promise<never>>().mockRejectedValue(serverError())

    const settled = withRetry(fn, { retries: 1 }).then(
      () => null,
      (e: unknown) => e as ProviderError
    )
    await vi.runAllTimersAsync()
    const err = await settled

    expect(fn).toHaveBeenCalledTimes(2) // first attempt + 1 retry
    expect(err).toBeInstanceOf(ProviderError)
    expect(err!.code).toBe('server')
  })

  it('rethrows non-retryable errors immediately', async () => {
    const fn = vi
      .fn<(attempt: number) => Promise<never>>()
      .mockRejectedValue(new ProviderError('auth', 'bad key'))
    await expect(withRetry(fn)).rejects.toMatchObject({ code: 'auth' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("never retries even a 'retryable' auth error", async () => {
    const fn = vi
      .fn<(attempt: number) => Promise<never>>()
      .mockRejectedValue(new ProviderError('auth', 'bad key', { retryable: true }))
    await expect(withRetry(fn)).rejects.toMatchObject({ code: 'auth' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('rethrows plain (non-ProviderError) errors without retrying', async () => {
    const fn = vi.fn<(attempt: number) => Promise<never>>().mockRejectedValue(new Error('bug'))
    await expect(withRetry(fn)).rejects.toThrow('bug')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('aborting during backoff rejects promptly without another attempt', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fn = vi
      .fn<(attempt: number) => Promise<never>>()
      .mockRejectedValue(serverError({ retryAfterSec: 5 }))

    const settled = withRetry(fn, { signal: controller.signal }).then(
      () => null,
      (e: unknown) => e as ProviderError
    )

    await vi.advanceTimersByTimeAsync(1000) // mid-backoff (5s mandated)
    controller.abort()
    const err = await settled // resolves without advancing to 5s

    expect(err).toBeInstanceOf(ProviderError)
    expect(err!.code).toBe('aborted')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fn = vi.fn<(attempt: number) => Promise<string>>().mockResolvedValue('ok')
    await expect(withRetry(fn, { signal: controller.signal })).rejects.toMatchObject({
      code: 'aborted',
    })
    expect(fn).not.toHaveBeenCalled()
  })
})
