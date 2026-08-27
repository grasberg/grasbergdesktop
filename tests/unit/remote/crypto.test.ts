import { describe, expect, it } from 'vitest'
import {
  deriveFrameKey,
  generateAccessToken,
  generatePairingSecret,
  hashToken,
  keyFingerprint,
  openFrame,
  pairingProof,
  proofMatches,
  sealFrame,
} from '../../../src/main/remote/crypto'

describe('remote crypto', () => {
  it('derives the same frame key from the same secret, different from other secrets', () => {
    const secret = generatePairingSecret()
    expect(deriveFrameKey(secret)).toEqual(deriveFrameKey(secret))
    expect(deriveFrameKey(secret)).not.toEqual(deriveFrameKey(generatePairingSecret()))
    expect(deriveFrameKey(secret)).toHaveLength(32)
  })

  it('seals and opens a payload round-trip', () => {
    const key = deriveFrameKey('a-secret')
    const payload = { t: 'req', id: '1', channel: 'chat:send', args: [{ hello: 'world' }] }
    const sealed = sealFrame(key, payload)
    expect(sealed.t).toBe('sec')
    expect(openFrame(key, sealed)).toEqual(payload)
  })

  it('produces a different ciphertext (nonce) for the same payload twice', () => {
    const key = deriveFrameKey('a-secret')
    const a = sealFrame(key, { x: 1 })
    const b = sealFrame(key, { x: 1 })
    expect(a.ct).not.toBe(b.ct)
  })

  it('rejects a tampered ciphertext', () => {
    const key = deriveFrameKey('a-secret')
    const sealed = sealFrame(key, { secret: 'data' })
    const bytes = Buffer.from(sealed.ct, 'base64')
    bytes[0] ^= 0xff
    const tampered = { ...sealed, ct: bytes.toString('base64') }
    expect(() => openFrame(key, tampered)).toThrow()
  })

  it('rejects a ciphertext sealed with a different key', () => {
    const sealed = sealFrame(deriveFrameKey('right-secret'), { x: 1 })
    expect(() => openFrame(deriveFrameKey('wrong-secret'), sealed)).toThrow()
  })

  it('rejects frames with malformed nonce or truncated ciphertext', () => {
    const key = deriveFrameKey('a-secret')
    expect(() => openFrame(key, { t: 'sec', n: 'AAAA', ct: 'AAAA' })).toThrow()
    expect(() => openFrame(key, { t: 'sec', n: Buffer.alloc(12).toString('base64'), ct: '' })).toThrow()
  })

  it('computes a deterministic pairing proof from the secret only', () => {
    const secret = generatePairingSecret()
    const proof = pairingProof(secret)
    expect(proof).toBe(pairingProof(secret))
    expect(proof).not.toBe(pairingProof(generatePairingSecret()))
    // The proof must not embed the secret itself.
    expect(proof).not.toContain(secret)
  })

  it('matches proofs constant-time-ish: right true, wrong false', () => {
    const proof = pairingProof('secret-one')
    expect(proofMatches(proof, proof)).toBe(true)
    expect(proofMatches(proof, pairingProof('secret-two'))).toBe(false)
    expect(proofMatches(proof, '')).toBe(false)
  })

  it('hashes tokens stably and fingerprints keys shortly', () => {
    const token = generateAccessToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken(token)).toBe(hashToken(token))
    expect(hashToken(token)).not.toBe(token)
    const fp = keyFingerprint(deriveFrameKey('x'))
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
  })

  it('mints QR-friendly pairing secrets and unique access tokens', () => {
    const a = generatePairingSecret()
    const b = generatePairingSecret()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateAccessToken()).not.toBe(generateAccessToken())
  })
})
