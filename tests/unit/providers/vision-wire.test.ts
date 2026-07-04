import { describe, expect, it } from 'vitest'
import type { AdapterChatRequest, ContentPart } from '../../../src/main/providers/adapter'
import { buildChatBody, toWireMessage } from '../../../src/main/providers/openai-compatible'

const parts: ContentPart[] = [
  { type: 'text', text: 'What is in this image?' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
]

describe('vision content-parts wire mapping', () => {
  it('passes an array content through toWireMessage unchanged', () => {
    const wire = toWireMessage({ role: 'user', content: parts })
    expect(wire.role).toBe('user')
    expect(wire.content).toBe(parts)
  })

  it('keeps string content unchanged (text-only regression)', () => {
    expect(toWireMessage({ role: 'user', content: 'hello' }).content).toBe('hello')
  })

  it('buildChatBody forwards array content in the messages payload', () => {
    const req: AdapterChatRequest = {
      modelId: 'glm-4.5v',
      messages: [{ role: 'user', content: parts }],
      params: {},
      stream: false,
    }
    const body = buildChatBody(req, false, false)
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0].content).toBe(parts)
  })
})
