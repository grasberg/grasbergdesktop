import { describe, expect, it } from 'vitest'
import { normalizeHttpError } from '../../../src/main/providers/errors'

describe('Codex HTTP error details', () => {
  it('surfaces the backend validation reason', () => {
    const error = normalizeHttpError(400, JSON.stringify({ detail: 'Unsupported parameter: max_output_tokens' }), 'openai')
    expect(error.code).toBe('invalid_request')
    expect(error.message).toContain('Unsupported parameter: max_output_tokens')
  })

  it('ignores structured validation details', () => {
    const error = normalizeHttpError(422, JSON.stringify({ detail: [{ input: 'private' }] }), 'openai')
    expect(error.message).not.toContain('private')
    expect(error.code).toBe('invalid_request')
  })

  it.each(['detail', 'message', 'plain'])('redacts secrets before truncating %s', (field) => {
    const secret = 'sensitive-account-identifier'
    const message = 'x'.repeat(field === 'plain' ? 190 : 290) + secret
    const body = field === 'plain' ? message : JSON.stringify({ [field]: message })
    const error = normalizeHttpError(400, body, 'openai', undefined, [secret])
    expect(error.message).not.toContain('sensitive')
    expect(error.message).toContain('[redacted]')
  })
})
