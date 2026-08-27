import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PairingGuard } from '../../../src/main/remote/pairing'
import { pairingProof } from '../../../src/main/remote/crypto'

describe('PairingGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const guard = (): { guard: PairingGuard; urlOf: (offer: { url: string }) => string } => ({
    guard: new PairingGuard((secret) => `https://relay.test/desktop/#p=${secret}`),
    urlOf: (offer) => offer.url,
  })

  it('issues an offer whose URL embeds the secret as a fragment', () => {
    const { guard: g } = guard()
    const offer = g.issue()
    expect(offer.url).toMatch(/^https:\/\/relay\.test\/desktop\/#p=[A-Za-z0-9_-]{43}$/)
    expect(offer.expiresAt).toBeGreaterThan(Date.now())
    expect(g.current()?.url).toBe(offer.url)
  })

  it('accepts a correct proof once, then consumes the offer', () => {
    const { guard: g } = guard()
    const offer = g.issue()
    const secret = offer.url.split('#p=')[1]
    const verdict = g.verify(pairingProof(secret))
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.secret).toBe(secret)
    // The offer is single-use.
    expect(g.verify(pairingProof(secret))).toEqual({ ok: false, reason: 'no-offer' })
    expect(g.current()).toBeNull()
  })

  it('rejects wrong proofs and burns the offer after five attempts', () => {
    const { guard: g } = guard()
    const offer = g.issue()
    const secret = offer.url.split('#p=')[1]
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(g.verify(pairingProof('wrong-' + attempt))).toEqual({ ok: false, reason: 'wrong' })
    }
    // The fifth wrong proof burns the offer; even the real secret is useless.
    expect(g.verify(pairingProof('wrong-4'))).toEqual({ ok: false, reason: 'burned' })
    expect(g.verify(pairingProof(secret))).toEqual({ ok: false, reason: 'no-offer' })
    expect(g.current()).toBeNull()
  })

  it('expires offers after the TTL', () => {
    const { guard: g } = guard()
    const offer = g.issue()
    const secret = offer.url.split('#p=')[1]
    vi.setSystemTime(Date.now() + 16 * 60_000)
    expect(g.current()).toBeNull()
    expect(g.verify(pairingProof(secret))).toEqual({ ok: false, reason: 'expired' })
    expect(g.current()).toBeNull()
  })

  it('cancel() burns the current offer immediately', () => {
    const { guard: g } = guard()
    g.issue()
    g.cancel()
    expect(g.current()).toBeNull()
  })

  it('verify without an offer reports no-offer', () => {
    const { guard: g } = guard()
    expect(g.verify('deadbeef')).toEqual({ ok: false, reason: 'no-offer' })
  })
})
