import { describe, expect, it } from 'vitest'
import type { AdapterMessage, ContentPart } from '../../../src/main/providers/adapter'
import { AnthropicAdapter, toAnthropicMessages } from '../../../src/main/providers/anthropic'
import { buildGeminiBody } from '../../../src/main/providers/google'
import { toConverseMessages } from '../../../src/main/providers/bedrock'
import { buildChatBody, toWireMessage } from '../../../src/main/providers/openai-compatible'
import { messagesToResponses } from '../../../src/main/providers/openai-codex'
import { makeFetchSequence, makeSSEResponse } from '../../helpers/mock-fetch'

const doc: ContentPart = {
  type: 'document',
  mediaType: 'application/pdf',
  dataBase64: 'QUJD',
  name: 'r.pdf',
  fallbackText: '[Attached PDF: r.pdf]\nextracted',
}
const noFallbackDoc: ContentPart = {
  type: 'document',
  mediaType: 'application/pdf',
  dataBase64: 'QUJD',
  name: 'r.pdf',
}
const textPart: ContentPart = { type: 'text', text: 'Summarize this.' }
const imagePart: ContentPart = {
  type: 'image_url',
  image_url: { url: 'data:image/png;base64,AAAA' },
}
const userMessage = (parts: ContentPart[]): AdapterMessage[] => [{ role: 'user', content: parts }]

describe('document content-part wire mapping', () => {
  it('anthropic maps a document part to a native document block', () => {
    const { messages } = toAnthropicMessages(userMessage([textPart, doc]))
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'Summarize this.' },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' },
        title: 'r.pdf',
      },
    ])
  })

  it('google maps a document part to inlineData', () => {
    const body = buildGeminiBody({
      modelId: 'gemini-2.5-flash',
      messages: userMessage([textPart, doc]),
      params: {},
      stream: false,
    })
    const contents = body.contents as Array<{ parts: Array<Record<string, unknown>> }>
    expect(contents[0].parts).toEqual([
      { text: 'Summarize this.' },
      { inlineData: { mimeType: 'application/pdf', data: 'QUJD' } },
    ])
  })

  it('bedrock strips the document part and substitutes fallbackText', () => {
    const { messages } = toConverseMessages(userMessage([textPart, doc]))
    const blocks = messages[0].content as Array<Record<string, unknown>>
    expect(blocks).toEqual([
      { text: 'Summarize this.' },
      { text: '[Attached PDF: r.pdf]\nextracted' },
    ])
    expect(JSON.stringify(blocks)).not.toContain('"document"')
  })

  it('openai-compatible substitutes document parts with text parts', () => {
    const wire = toWireMessage({ role: 'user', content: [textPart, doc] })
    expect(wire.content).toEqual([
      { type: 'text', text: 'Summarize this.' },
      { type: 'text', text: '[Attached PDF: r.pdf]\nextracted' },
    ])
    expect(JSON.stringify(wire)).not.toContain('"document"')
  })

  it('openai-compatible returns the original array by identity when no document part exists', () => {
    const parts = [textPart, imagePart]
    const wire = toWireMessage({ role: 'user', content: parts })
    expect(wire.content).toBe(parts)
    const body = buildChatBody(
      { modelId: 'm', messages: [{ role: 'user', content: parts }], params: {}, stream: false },
      false,
      false
    )
    expect((body.messages as Array<Record<string, unknown>>)[0].content).toBe(parts)
  })

  it('codex maps a document part to input_text with the fallback', () => {
    const { input } = messagesToResponses(userMessage([textPart, doc]))
    const first = input[0] as { content: Array<Record<string, unknown>> }
    expect(first.content).toEqual([
      { type: 'input_text', text: 'Summarize this.' },
      { type: 'input_text', text: '[Attached PDF: r.pdf]\nextracted' },
    ])
  })

  it('strippers emit an honest placeholder when fallbackText is absent', () => {
    const bedrockBlocks = toConverseMessages(userMessage([noFallbackDoc])).messages[0]
      .content as Array<{ text: string }>
    expect(bedrockBlocks[0].text).toContain('not supported by this provider')
    const oaiParts = toWireMessage({ role: 'user', content: [noFallbackDoc] }).content as Array<{
      text: string
    }>
    expect(oaiParts[0].text).toContain('not supported by this provider')
    const codexInput = messagesToResponses(userMessage([noFallbackDoc])).input[0] as {
      content: Array<{ text: string }>
    }
    expect(codexInput.content[0].text).toContain('not supported by this provider')
  })

  it('anthropic chat round-trip carries the document block in the HTTP body', async () => {
    const fetchImpl = makeFetchSequence(makeSSEResponse([]))
    await new AnthropicAdapter().chat(
      {
        modelId: 'claude-sonnet-5',
        messages: userMessage([textPart, doc]),
        params: {},
        stream: false,
      },
      { apiKey: 'sk-test', baseUrl: 'https://api.anthropic.com/v1', fetchImpl }
    )
    const body = fetchImpl.requests[0].body as {
      messages: Array<{ content: Array<Record<string, unknown>> }>
    }
    const blocks = body.messages[0].content
    expect(blocks.some((b) => b.type === 'document')).toBe(true)
    const documentBlock = blocks.find((b) => b.type === 'document')!
    expect(documentBlock.source).toEqual({
      type: 'base64',
      media_type: 'application/pdf',
      data: 'QUJD',
    })
  })
})
