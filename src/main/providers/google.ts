/**
 * Google Gemini adapter — the Generative Language API
 * (`{baseUrl}/models/{model}:streamGenerateContent?alt=sse`), a native dialect.
 * Auth is the `x-goog-api-key` header (never a URL query, so the key can't land
 * in a log). `?alt=sse` makes the stream ordinary SSE for our parseSSE.
 */

import { randomUUID } from 'node:crypto'
import type { ModelInfo, ProviderType, TestConnectionResult, TokenUsage } from '@shared/types'
import { PROVIDER_TYPES } from '@shared/catalog'
import type {
  AdapterChatRequest,
  AdapterChatResult,
  AdapterContext,
  AdapterGeneratedImage,
  AdapterImageRequest,
  AdapterMessage,
  AdapterStreamEvent,
  AdapterToolDef,
  ContentPart,
  ProviderAdapter,
} from './adapter'
import { ProviderError } from './errors'
import { checkedFetch, joinUrl, requireStreamBody } from './http'
import { collectStream, parseDataUrl, parseToolArguments, probeConnection } from './native'
import { withRetry } from './retry'
import { parseSSE } from './sse'

type FinishReason = AdapterChatResult['finishReason']
type Part = Record<string, unknown>
type Content = { role: 'user' | 'model'; parts: Part[] }

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

function inlineData(url: string): Part {
  const parsed = parseDataUrl(url)
  if (parsed) return { inlineData: { mimeType: parsed.mediaType, data: parsed.data } }
  return { text: url } // non-data image url: degrade to a text mention
}

function userParts(content: string | ContentPart[]): Part[] {
  if (typeof content === 'string') return [{ text: content }]
  return content.map((p) => (p.type === 'text' ? { text: p.text } : inlineData(p.image_url.url)))
}

export function buildGeminiBody(req: AdapterChatRequest): Record<string, unknown> {
  // Map tool-call ids back to their function name (Gemini keys responses by name).
  const idToName = new Map<string, string>()
  for (const m of req.messages) {
    if (m.role === 'assistant') for (const tc of m.toolCalls ?? []) idToName.set(tc.id, tc.name)
  }

  const contents: Content[] = []
  const systemParts: string[] = []
  const push = (role: 'user' | 'model', parts: Part[]): void => {
    const last = contents[contents.length - 1]
    if (last && last.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }

  for (const m of req.messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string') systemParts.push(m.content)
    } else if (m.role === 'tool') {
      push('user', [
        {
          functionResponse: {
            name: idToName.get(m.toolCallId ?? '') ?? m.toolCallId ?? '',
            response: { result: typeof m.content === 'string' ? m.content : '' },
          },
        },
      ])
    } else if (m.role === 'assistant') {
      const parts: Part[] = []
      const text = typeof m.content === 'string' ? m.content : ''
      if (text) parts.push({ text })
      for (const tc of m.toolCalls ?? []) {
        parts.push({ functionCall: { name: tc.name, args: parseToolArguments(tc.arguments) } })
      }
      if (parts.length > 0) push('model', parts)
    } else {
      push('user', userParts(m.content))
    }
  }

  const body: Record<string, unknown> = { contents }
  if (systemParts.length > 0) body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] }
  const tools = toGeminiTools(req.tools)
  if (tools) body.tools = tools
  const gen: Record<string, unknown> = {}
  if (req.params.temperature !== undefined) gen.temperature = req.params.temperature
  if (req.params.topP !== undefined) gen.topP = req.params.topP
  if (req.params.maxTokens !== undefined) gen.maxOutputTokens = req.params.maxTokens
  if (req.params.reasoningEffort !== undefined) {
    gen.thinkingConfig = {
      thinkingBudget: GEMINI_THINKING_BUDGETS[req.params.reasoningEffort],
      includeThoughts: true,
    }
  }
  if (req.params.responseFormat === 'json') gen.responseMimeType = 'application/json'
  if (Object.keys(gen).length > 0) body.generationConfig = gen
  return body
}

/** thinkingConfig.thinkingBudget (tokens) per reasoning effort. */
export const GEMINI_THINKING_BUDGETS: Record<'low' | 'medium' | 'high', number> = {
  low: 1024,
  medium: 8192,
  high: 24576,
}

/** Gemini/Imagen aspect ratio per abstract size ('auto' stays off the wire). */
export function mapGeminiAspectRatio(size: AdapterImageRequest['size']): string | undefined {
  if (!size || size === 'auto') return undefined
  return size === 'square' ? '1:1' : size === 'landscape' ? '16:9' : '9:16'
}

/** Cap per generated image (decoded bytes) — mirrors the OpenAI-compatible cap. */
const GEMINI_IMAGE_MAX_BYTES = 20 * 1024 * 1024

export function toGeminiTools(tools: AdapterToolDef[] | undefined): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ]
}

function mapGeminiFinish(reason: unknown): FinishReason | undefined {
  switch (reason) {
    case 'STOP':
      return 'stop'
    case 'MAX_TOKENS':
      return 'length'
    case undefined:
    case null:
      return undefined
    default:
      return 'other'
  }
}

/** One parsed Gemini SSE chunk → normalized stream events (tool ids are placeholders). */
export function parseGeminiChunk(json: unknown): AdapterStreamEvent[] {
  if (!json || typeof json !== 'object') return []
  const ev = json as Record<string, unknown>
  const out: AdapterStreamEvent[] = []
  const candidates = (ev.candidates as Record<string, unknown>[] | undefined) ?? []
  const cand = candidates[0]
  if (cand) {
    const parts = ((cand.content as Record<string, unknown> | undefined)?.parts as Part[] | undefined) ?? []
    for (const part of parts) {
      if (typeof part.text === 'string') {
        out.push(part.thought === true ? { type: 'reasoning', text: part.text } : { type: 'text', text: part.text })
      } else if (part.functionCall && typeof part.functionCall === 'object') {
        const fc = part.functionCall as { name?: string; args?: unknown }
        out.push({
          type: 'tool_call',
          toolCall: { id: fc.name ?? 'call', name: fc.name ?? '', arguments: JSON.stringify(fc.args ?? {}), status: 'proposed' },
        })
      }
    }
    const finish = mapGeminiFinish(cand.finishReason)
    if (finish) out.push({ type: 'finish', reason: finish })
  }
  const usage = ev.usageMetadata as
    | {
        promptTokenCount?: number
        candidatesTokenCount?: number
        totalTokenCount?: number
        cachedContentTokenCount?: number
      }
    | undefined
  if (usage) {
    out.push({
      type: 'usage',
      usage: {
        promptTokens: usage.promptTokenCount,
        completionTokens: usage.candidatesTokenCount,
        totalTokens: usage.totalTokenCount,
        ...(typeof usage.cachedContentTokenCount === 'number' &&
        usage.cachedContentTokenCount > 0
          ? { cachedInputTokens: usage.cachedContentTokenCount }
          : {}),
      },
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GoogleAdapter implements ProviderAdapter {
  readonly type: ProviderType = 'google'

  private url(ctx: AdapterContext, model: string, stream: boolean): string {
    const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
    return joinUrl(ctx.baseUrl, `/models/${encodeURIComponent(model)}:${method}`)
  }

  private post(req: AdapterChatRequest, ctx: AdapterContext, stream: boolean): Promise<Response> {
    return checkedFetch(this.url(ctx, req.modelId, stream), {
      method: 'POST',
      headers: { 'x-goog-api-key': ctx.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(buildGeminiBody(req)),
      signal: ctx.signal,
      providerType: this.type,
      secrets: [ctx.apiKey],
      fetchImpl: ctx.fetchImpl,
      honorRetryAfter: true,
    })
  }

  async *chatStream(req: AdapterChatRequest, ctx: AdapterContext): AsyncGenerator<AdapterStreamEvent> {
    const res = await withRetry(() => this.post(req, ctx, true), { signal: ctx.signal })
    const body = requireStreamBody(res, 'Gemini', this.type)
    let sawToolCall = false
    let pendingFinish: FinishReason | undefined
    let lastUsage: TokenUsage | undefined
    for await (const payload of parseSSE(body, ctx.signal)) {
      let json: unknown
      try {
        json = JSON.parse(payload)
      } catch {
        continue
      }
      for (const e of parseGeminiChunk(json)) {
        if (e.type === 'tool_call') {
          sawToolCall = true
          // Assign a unique id; Gemini function calls carry only a name.
          yield { type: 'tool_call', toolCall: { ...e.toolCall, id: randomUUID() } }
          continue
        }
        // Gemini has no tool finish reason (it reports STOP even on a tool turn)
        // and repeats cumulative usageMetadata on every chunk. Defer both to
        // end-of-stream: apply the tool-call override once, and emit the final
        // (last-wins) usage snapshot once, so a cumulative-summing consumer
        // can't inflate the count. Mirrors chat().
        if (e.type === 'finish') {
          pendingFinish = e.reason
          continue
        }
        if (e.type === 'usage') {
          lastUsage = e.usage
          continue
        }
        yield e
      }
    }
    if (lastUsage) yield { type: 'usage', usage: lastUsage }
    yield { type: 'finish', reason: sawToolCall ? 'tool_calls' : (pendingFinish ?? 'stop') }
  }

  async chat(req: AdapterChatRequest, ctx: AdapterContext): Promise<AdapterChatResult> {
    return collectStream(this.chatStream({ ...req, stream: false }, ctx))
  }

  /** POST helper for the non-chat endpoints (:predict, image generateContent). */
  private async postJson(ctx: AdapterContext, path: string, body: unknown): Promise<unknown> {
    const res = await withRetry(
      () =>
        checkedFetch(joinUrl(ctx.baseUrl, path), {
          method: 'POST',
          headers: { 'x-goog-api-key': ctx.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctx.signal,
          providerType: this.type,
          secrets: [ctx.apiKey],
          fetchImpl: ctx.fetchImpl,
          honorRetryAfter: true,
        }),
      { signal: ctx.signal }
    )
    try {
      return JSON.parse(await res.text()) as unknown
    } catch {
      throw new ProviderError('unknown', 'Gemini returned a non-JSON response.', {
        retryable: false,
        providerType: this.type,
      })
    }
  }

  private decodeImage(b64: string, mimeType: string | undefined): AdapterGeneratedImage {
    const bytes = Buffer.from(b64, 'base64')
    if (bytes.byteLength === 0 || bytes.byteLength > GEMINI_IMAGE_MAX_BYTES) {
      throw new ProviderError('unknown', 'The generated image was empty or too large.', {
        retryable: false,
        providerType: this.type,
      })
    }
    return {
      bytes: new Uint8Array(bytes),
      mimeType: mimeType?.startsWith('image/') ? mimeType : 'image/png',
    }
  }

  /**
   * Text-to-image. Gemini image models (gemini-*-image*, "Nano Banana") run
   * through :generateContent with responseModalities IMAGE; imagen-* ids run
   * through the legacy :predict endpoint (kept for typed custom ids).
   */
  async generateImage(
    req: AdapterImageRequest,
    ctx: AdapterContext
  ): Promise<AdapterGeneratedImage[]> {
    const aspect = mapGeminiAspectRatio(req.size)
    if (/^imagen/i.test(req.modelId)) {
      const json = (await this.postJson(
        ctx,
        `/models/${encodeURIComponent(req.modelId)}:predict`,
        {
          instances: [{ prompt: req.prompt }],
          parameters: {
            sampleCount: Math.min(Math.max(req.count, 1), 4),
            ...(aspect ? { aspectRatio: aspect } : {}),
          },
        }
      )) as { predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> }
      const images = (json.predictions ?? [])
        .filter((p) => typeof p.bytesBase64Encoded === 'string' && p.bytesBase64Encoded.length > 0)
        .map((p) => this.decodeImage(p.bytesBase64Encoded as string, p.mimeType))
      if (images.length === 0) {
        throw new ProviderError('unknown', 'Imagen returned no image.', {
          retryable: false,
          providerType: this.type,
        })
      }
      return images
    }

    // Gemini image output: one image per call (no native sampleCount).
    const json = (await this.postJson(
      ctx,
      `/models/${encodeURIComponent(req.modelId)}:generateContent`,
      {
        contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          ...(aspect ? { imageConfig: { aspectRatio: aspect } } : {}),
        },
      }
    )) as {
      candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }>
      promptFeedback?: { blockReason?: string }
    }
    if (json.promptFeedback?.blockReason) {
      throw new ProviderError(
        'invalid_request',
        `The prompt was blocked (${json.promptFeedback.blockReason}).`,
        { retryable: false, providerType: this.type }
      )
    }
    const parts = json.candidates?.[0]?.content?.parts ?? []
    const images: AdapterGeneratedImage[] = []
    for (const part of parts) {
      const inline = part.inlineData as { mimeType?: string; data?: string } | undefined
      if (inline && typeof inline.data === 'string' && inline.data.length > 0) {
        images.push(this.decodeImage(inline.data, inline.mimeType))
      }
    }
    if (images.length === 0) {
      throw new ProviderError('unknown', 'Gemini returned no image for this prompt.', {
        retryable: false,
        providerType: this.type,
      })
    }
    return images
  }

  async listModels(_ctx: AdapterContext): Promise<ModelInfo[]> {
    return PROVIDER_TYPES.google.knownModels
  }

  async testConnection(ctx: AdapterContext): Promise<TestConnectionResult> {
    return probeConnection((req) => this.chat(req, ctx), {
      modelId: PROVIDER_TYPES.google.defaultModelId,
      providerType: this.type,
      secrets: [ctx.apiKey],
      successMessage: 'Connected.',
    })
  }
}
