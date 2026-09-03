/**
 * One embedded browser per active bot (v50): the pool hands out one session
 * per scope, keeps the user's default session apart, and closes the
 * least-recently-used bot session past the cap. Electron is faked — no window
 * is ever created here.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({}) },
}))

const { BrowserSessionPool } = await import('../../src/main/browser/pool')

describe('BrowserSessionPool', () => {
  it('shares the default session, isolates each bot in its own partition, and reuses it', () => {
    const pool = new BrowserSessionPool()
    expect(pool.scopeFor(null)).toBe('default')
    expect(pool.scopeFor('abc')).toBe('bot:abc')
    expect(pool.forScope('default')).toBe(pool.forScope('default'))
    const a = pool.forScope('bot:a')
    const b = pool.forScope('bot:b')
    expect(a).not.toBe(b)
    expect(a).toBe(pool.forScope('bot:a'))
    expect(a.partition).toBe('grasberg-browser-bot-a')
    expect(pool.forScope('default').partition).toBe('grasberg-browser')
    expect(pool.scopes()).toEqual(['bot:b', 'bot:a']) // 'a' was touched last
  })

  it('evicts the least-recently-used bot session past the cap and closes everything on closeAll', () => {
    const pool = new BrowserSessionPool()
    const sessions = ['a', 'b', 'c', 'd'].map((id) => pool.forScope(`bot:${id}`))
    // Spy on b BEFORE touching anything else: forScope() itself counts as use.
    const closed = vi.spyOn(sessions[1], 'close')
    pool.forScope('bot:a') // refresh a: b is now the oldest
    pool.forScope('bot:e')
    expect(closed).toHaveBeenCalledTimes(1)
    expect(pool.scopes()).toEqual(['bot:c', 'bot:d', 'bot:a', 'bot:e'])
    pool.closeAll()
    expect(pool.scopes()).toEqual([])
    expect(pool.consumePendingScreenshot('zzz')).toBeNull()
  })
})
