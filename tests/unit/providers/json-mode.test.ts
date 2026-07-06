/**
 * ChatParams.responseFormat = 'json' maps to each provider's JSON mode:
 * OpenAI-compatible response_format json_object, Gemini responseMimeType.
 */

import { describe, expect, it } from 'vitest'
import { buildChatBody } from '../../../src/main/providers/openai-compatible'
import { buildGeminiBody } from '../../../src/main/providers/google'

const req = {
  modelId: 'm',
  messages: [{ role: 'user' as const, content: 'hi' }],
  params: { responseFormat: 'json' as const },
  stream: false,
}

describe('responseFormat json', () => {
  it('OpenAI-compatible: response_format json_object (absent otherwise)', () => {
    expect(buildChatBody(req, false, false).response_format).toEqual({ type: 'json_object' })
    expect(
      buildChatBody({ ...req, params: {} }, false, false).response_format
    ).toBeUndefined()
  })

  it('Gemini: generationConfig.responseMimeType application/json', () => {
    const body = buildGeminiBody(req) as { generationConfig?: { responseMimeType?: string } }
    expect(body.generationConfig?.responseMimeType).toBe('application/json')
    const plain = buildGeminiBody({ ...req, params: {} }) as {
      generationConfig?: { responseMimeType?: string }
    }
    expect(plain.generationConfig?.responseMimeType).toBeUndefined()
  })
})
