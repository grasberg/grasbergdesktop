import { describe, expect, it } from 'vitest'
import { maskKey, redactSecrets } from '../../../src/main/providers/redact'

describe('redactSecrets', () => {
  it('removes every occurrence of provided secrets', () => {
    const out = redactSecrets('key mysecretvalue failed; retry with mysecretvalue', [
      'mysecretvalue',
    ])
    expect(out).not.toContain('mysecretvalue')
    expect(out).toContain('[redacted]')
  })

  it('removes overlapping secrets, longest first', () => {
    const out = redactSecrets('token is abcdEFGH9876 here', ['abcdEFGH9876', 'abcdEFGH'])
    expect(out).not.toContain('abcdEFGH')
  })

  it('ignores secrets shorter than 4 chars (would over-redact)', () => {
    expect(redactSecrets('the cat sat', ['at'])).toBe('the cat sat')
  })

  it('removes Bearer tokens even when not passed as a secret', () => {
    const out = redactSecrets('sent header "Authorization: Bearer abc.DEF_123-xyz" upstream')
    expect(out).not.toContain('abc.DEF_123-xyz')
    expect(out).toContain('[redacted]')
  })

  it('removes sk- style keys', () => {
    const out = redactSecrets('invalid key sk-proj12345678abcd provided')
    expect(out).not.toContain('sk-proj12345678abcd')
    expect(out).toContain('[redacted]')
  })

  it('removes long hex runs', () => {
    const hex = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    const out = redactSecrets(`hash ${hex} leaked`)
    expect(out).not.toContain(hex)
    expect(out).toContain('[redacted]')
  })

  it('removes long base64 runs', () => {
    const b64 = 'QWxhZGRpbjpvcGVuIHNlc2FtZUFsYWRkaW4='
    const out = redactSecrets(`blob ${b64} end`)
    expect(out).not.toContain(b64)
  })

  it('is idempotent and leaves clean text untouched', () => {
    const clean = 'Rate limited by the provider — too many requests. Retry in ~7s.'
    const once = redactSecrets(clean)
    expect(once).toBe(clean)
    // Applying again to already-redacted output changes nothing further.
    const dirty = redactSecrets('key sk-abcdef123456789 bad', ['sk-abcdef123456789'])
    expect(redactSecrets(dirty)).toBe(dirty)
  })
})

describe('maskKey', () => {
  it("previews prefixed keys as 'sk-…4f2a' style", () => {
    expect(maskKey('sk-abcdefghijkl4f2a')).toBe('sk-…4f2a')
  })

  it('keeps only the ellipsis + last 4 for unprefixed keys', () => {
    expect(maskKey('abcdefgh12345')).toBe('…2345')
  })

  it('shows just last 2 chars for short keys', () => {
    expect(maskKey('abc12')).toBe('…12')
  })

  it('returns empty string for empty/whitespace input', () => {
    expect(maskKey('')).toBe('')
    expect(maskKey('   ')).toBe('')
  })

  it('never includes the middle of the key', () => {
    const key = 'sk-THISMIDDLEPARTISSECRET9999'
    const masked = maskKey(key)
    expect(masked).not.toContain('THISMIDDLEPART')
    expect(masked.length).toBeLessThan(10)
  })
})
