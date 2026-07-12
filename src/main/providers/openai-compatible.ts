/**
 * Base adapter for OpenAI-compatible chat completion APIs. DeepSeek, Zhipu and
 * MiniMax subclass this with minimal overrides; the generic 'openai-compatible'
 * provider type uses it directly.
 */

import type { z } from 'zod'
import type {
  ModelInfo,
  ProviderType,
  TestConnectionResult,
  TokenUsage,
  ToolCallRecord,
} from '@shared/types'
import { PROVIDER_TYPES, UNKNOWN_MODEL_CAPS, findInCatalog } from '@shared/catalog'
import type { ProviderModelCatalog } from '@shared/catalog'
import {
  oaiChatChunkSchema,
  oaiChatCompletionSchema,
  oaiImagesResponseSchema,
  oaiModelsListSchema,
  oaiToolCallSchema,
  type OaiChatCompletion,
} from '@shared/schemas'
import type {
  AdapterChatRequest,
  AdapterChatResult,
  AdapterContext,
  AdapterGeneratedImage,
  AdapterImageRequest,
  AdapterMessage,
  AdapterStreamEvent,
  ProviderAdapter,
} from './adapter'
import { ProviderError, toNormalizedError, toProviderError } from './errors'
import { checkedFetch, joinUrl, readBytesCapped, requireStreamBody } from './http'
import { withRetry } from './retry'
import { parseSSE } from './sse'

type OaiToolCall = z.infer<typeof oaiToolCallSchema>

type FinishReason = AdapterChatResult['finishReason']

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Maps our normalized message to the OpenAI wire format. */
export function toWireMessage(m: AdapterMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    // Tool results are always plain strings.
    const content = typeof m.content === 'string' ? m.content : ''
    return { role: 'tool', tool_call_id: m.toolCallId ?? '', content }
  }
  // Array content (text + image parts) passes straight through; OpenAI-
  // compatible vision endpoints accept the parts array as `content`.
  const wire: Record<string, unknown> = { role: m.role, content: m.content }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    wire.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    }))
  }
  return wire
}

export function buildChatBody(
  req: AdapterChatRequest,
  stream: boolean,
  includeStreamOptions: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.modelId,
    messages: req.messages.map(toWireMessage),
    stream,
  }
  const p = req.params
  if (p.temperature !== undefined) body.temperature = p.temperature
  if (p.topP !== undefined) body.top_p = p.topP
  if (p.maxTokens !== undefined) body.max_tokens = p.maxTokens
  if (p.frequencyPenalty !== undefined) body.frequency_penalty = p.frequencyPenalty
  if (p.presencePenalty !== undefined) body.presence_penalty = p.presencePenalty
  // Only on the wire when the user explicitly picked an effort; reasoning
  // models honor it, non-reasoning OpenAI-compatible servers ignore it.
  if (p.reasoningEffort !== undefined) body.reasoning_effort = p.reasoningEffort
  if (p.responseFormat === 'json') body.response_format = { type: 'json_object' }
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
  if (stream && includeStreamOptions) body.stream_options = { include_usage: true }
  return body
}

function mapFinishReason(reason: string | null | undefined): FinishReason | undefined {
  switch (reason) {
    case null:
    case undefined:
      return undefined
    case 'stop':
      return 'stop'
    case 'length':
    case 'max_tokens':
      return 'length'
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls'
    default:
      return 'other'
  }
}

function mapUsage(u: {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number } | null
}): TokenUsage | undefined {
  if (u.prompt_tokens === undefined && u.completion_tokens === undefined && u.total_tokens === undefined) {
    return undefined
  }
  const cached = u.prompt_tokens_details?.cached_tokens
  return {
    promptTokens: u.prompt_tokens,
    completionTokens: u.completion_tokens,
    totalTokens: u.total_tokens,
    ...(typeof cached === 'number' && cached > 0 ? { cachedInputTokens: cached } : {}),
  }
}

interface ToolCallAccum {
  id?: string
  name: string
  args: string
}

/**
 * Accumulates one streamed tool_call fragment. Fragments are keyed by `index`;
 * when a provider omits it we fall back to the id (new entry per new id) or to
 * the last-seen index for continuation fragments. Returns the index used.
 */
function accumulateToolCall(
  accum: Map<number, ToolCallAccum>,
  tc: OaiToolCall,
  lastIndex: number
): number {
  let index: number
  if (tc.index !== undefined) {
    index = tc.index
  } else if (tc.id) {
    index = accum.size
    for (const [i, a] of accum) {
      if (a.id === tc.id) {
        index = i
        break
      }
    }
  } else {
    index = lastIndex
  }
  let acc = accum.get(index)
  if (!acc) {
    acc = { name: '', args: '' }
    accum.set(index, acc)
  }
  if (tc.id) acc.id = tc.id
  if (tc.function?.name) acc.name += tc.function.name
  if (tc.function?.arguments) acc.args += tc.function.arguments
  return index
}

function toToolCallRecord(index: number, acc: ToolCallAccum): ToolCallRecord {
  return {
    id: acc.id ?? `call_${index}`,
    name: acc.name,
    arguments: acc.args,
    status: 'proposed',
  }
}

// ---------------------------------------------------------------------------
// Image generation (POST /images/generations)
// ---------------------------------------------------------------------------

/** Hard cap per generated image (decoded bytes). */
export const GENERATED_IMAGE_MAX_BYTES = 20 * 1024 * 1024

/**
 * Maps the abstract size to the OpenAI images dialect. gpt-image models take
 * 1024/1536 rectangles; dall-e-3 takes 1024/1792; everything else only gets
 * the safe square. 'auto'/unset stays off the wire (provider default).
 */
export function mapOpenAiImageSize(
  modelId: string,
  size: AdapterImageRequest['size']
): string | undefined {
  if (!size || size === 'auto') return undefined
  if (/^gpt-image/i.test(modelId)) {
    return size === 'square' ? '1024x1024' : size === 'landscape' ? '1536x1024' : '1024x1536'
  }
  if (/^dall-e-3/i.test(modelId)) {
    return size === 'square' ? '1024x1024' : size === 'landscape' ? '1792x1024' : '1024x1792'
  }
  return size === 'square' ? '1024x1024' : undefined
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly type: ProviderType

  /** When true, streaming requests ask for a final usage chunk. */
  protected sendStreamOptions = false

  constructor(opts: { type?: ProviderType } = {}) {
    this.type = opts.type ?? 'openai-compatible'
  }

  // -- overridable hooks ----------------------------------------------------

  /**
   * Some providers (MiniMax) return HTTP 200 with an error encoded in the
   * body. Subclasses inspect the parsed JSON here and throw a ProviderError
   * when it actually represents a failure. Base: no-op.
   */
  protected checkBodyForProviderError(_json: unknown, _ctx: AdapterContext): void {
    // Intentionally empty — OpenAI-compatible APIs signal errors via HTTP status.
  }

  protected buildHeaders(ctx: AdapterContext, hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${ctx.apiKey}` }
    if (hasBody) headers['Content-Type'] = 'application/json'
    return headers
  }

  /**
   * The known-model catalog for this call: a preset's catalog when supplied via
   * ctx, otherwise this family's PROVIDER_TYPES metadata. This is what lets a
   * single memoized openai-compatible instance serve every preset.
   */
  protected catalog(ctx: AdapterContext): ProviderModelCatalog {
    return ctx.modelCatalog ?? PROVIDER_TYPES[this.type]
  }

  // -- HTTP plumbing ----------------------------------------------------------

  protected doRequest(
    ctx: AdapterContext,
    path: string,
    init: { method: 'GET' | 'POST'; body?: string }
  ): Promise<Response> {
    return checkedFetch(joinUrl(ctx.baseUrl, path), {
      method: init.method,
      headers: this.buildHeaders(ctx, init.body !== undefined),
      body: init.body,
      signal: ctx.signal,
      providerType: this.type,
      secrets: [ctx.apiKey],
      fetchImpl: ctx.fetchImpl,
      honorRetryAfter: true,
    })
  }

  protected postChat(req: AdapterChatRequest, ctx: AdapterContext, stream: boolean): Promise<Response> {
    return this.doRequest(ctx, '/chat/completions', {
      method: 'POST',
      body: JSON.stringify(buildChatBody(req, stream, this.sendStreamOptions)),
    })
  }

  protected async readJson(res: Response, ctx: AdapterContext): Promise<unknown> {
    let text: string
    try {
      text = await res.text()
    } catch (e) {
      throw toProviderError(e, this.type, [ctx.apiKey])
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new ProviderError('unknown', 'The provider returned a non-JSON response.', {
        status: res.status,
        retryable: false,
        providerType: this.type,
      })
    }
  }

  /** Single non-streaming chat completion request (no retry). */
  protected async fetchChatCompletion(
    req: AdapterChatRequest,
    ctx: AdapterContext
  ): Promise<OaiChatCompletion> {
    const res = await this.postChat(req, ctx, false)
    const json = await this.readJson(res, ctx)
    this.checkBodyForProviderError(json, ctx)
    const parsed = oaiChatCompletionSchema.safeParse(json)
    if (!parsed.success) {
      throw new ProviderError('unknown', 'The provider returned an unexpected response format.', {
        retryable: false,
        providerType: this.type,
      })
    }
    return parsed.data
  }

  /**
   * Request body for POST /images/generations. Overridable per family:
   * Zhipu's CogView prunes n/response_format and uses its own size strings.
   */
  protected buildImageBody(req: AdapterImageRequest): Record<string, unknown> {
    const body: Record<string, unknown> = { model: req.modelId, prompt: req.prompt }
    if (req.count > 1) body.n = req.count
    const size = mapOpenAiImageSize(req.modelId, req.size)
    if (size) body.size = size
    // gpt-image models always return base64 and REJECT response_format.
    if (!/^gpt-image/i.test(req.modelId)) body.response_format = 'b64_json'
    return body
  }

  /** Downloads a result URL (dall-e default, CogView). https-only, size-capped. */
  protected async downloadGeneratedImage(
    url: string,
    ctx: AdapterContext
  ): Promise<AdapterGeneratedImage> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new ProviderError('unknown', 'The provider returned an invalid image URL.', {
        retryable: false,
        providerType: this.type,
      })
    }
    if (parsed.protocol !== 'https:') {
      throw new ProviderError('unknown', 'The provider returned a non-https image URL.', {
        retryable: false,
        providerType: this.type,
      })
    }
    // The result URL is provider-hosted and pre-signed: GET without auth so
    // the API key never travels to a third-party host.
    const res = await checkedFetch(parsed.toString(), {
      method: 'GET',
      headers: {},
      signal: ctx.signal,
      providerType: this.type,
      secrets: [ctx.apiKey],
      fetchImpl: ctx.fetchImpl,
    })
    const buffer = await readBytesCapped(res, GENERATED_IMAGE_MAX_BYTES)
    if (!buffer || buffer.byteLength === 0) {
      throw new ProviderError('unknown', 'The generated image was empty or too large.', {
        retryable: false,
        providerType: this.type,
      })
    }
    const contentType = res.headers.get('content-type') ?? ''
    return {
      bytes: buffer,
      mimeType: contentType.startsWith('image/') ? contentType.split(';')[0] : 'image/png',
    }
  }

  /**
   * Text-to-image via POST /images/generations (OpenAI images API and
   * compatibles; Zhipu CogView inherits with a body override). Non-streaming.
   */
  async generateImage(
    req: AdapterImageRequest,
    ctx: AdapterContext
  ): Promise<AdapterGeneratedImage[]> {
    const res = await withRetry(
      () =>
        this.doRequest(ctx, '/images/generations', {
          method: 'POST',
          body: JSON.stringify(this.buildImageBody(req)),
        }),
      { signal: ctx.signal }
    )
    const json = await this.readJson(res, ctx)
    this.checkBodyForProviderError(json, ctx)
    const parsed = oaiImagesResponseSchema.safeParse(json)
    if (!parsed.success) {
      throw new ProviderError('unknown', 'The provider returned an unexpected image response.', {
        retryable: false,
        providerType: this.type,
      })
    }
    const images: AdapterGeneratedImage[] = []
    for (const item of parsed.data.data) {
      if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
        const bytes = Buffer.from(item.b64_json, 'base64')
        if (bytes.byteLength === 0 || bytes.byteLength > GENERATED_IMAGE_MAX_BYTES) {
          throw new ProviderError('unknown', 'The generated image was empty or too large.', {
            retryable: false,
            providerType: this.type,
          })
        }
        images.push({
          bytes: new Uint8Array(bytes),
          mimeType: 'image/png',
          ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
        })
      } else if (typeof item.url === 'string' && item.url.length > 0) {
        const downloaded = await this.downloadGeneratedImage(item.url, ctx)
        images.push({
          ...downloaded,
          ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
        })
      }
    }
    if (images.length === 0) {
      throw new ProviderError('unknown', 'The provider returned no image.', {
        retryable: false,
        providerType: this.type,
      })
    }
    return images
  }

  // -- ProviderAdapter ---------------------------------------------------------

  /**
   * Text embeddings via POST /embeddings (OpenAI wire format — also served by
   * local runtimes like Ollama and LM Studio). One vector per input, in order.
   */
  async embed(req: { modelId: string; input: string[] }, ctx: AdapterContext): Promise<number[][]> {
    if (req.input.length === 0) return []
    const res = await withRetry(
      () =>
        this.doRequest(ctx, '/embeddings', {
          method: 'POST',
          body: JSON.stringify({ model: req.modelId, input: req.input }),
        }),
      { signal: ctx.signal }
    )
    const json = (await this.readJson(res, ctx)) as {
      data?: Array<{ index?: number; embedding?: unknown }>
    }
    const data = json?.data
    if (!Array.isArray(data) || data.length !== req.input.length) {
      throw new ProviderError('unknown', 'The provider returned an unexpected embeddings format.', {
        retryable: false,
        providerType: this.type,
      })
    }
    // Order by index when present (the API may reorder batches).
    const out: number[][] = new Array<number[]>(req.input.length)
    for (let i = 0; i < data.length; i++) {
      const item = data[i]
      const embedding: unknown = item.embedding
      if (!Array.isArray(embedding) || embedding.some((v) => typeof v !== 'number')) {
        throw new ProviderError('unknown', 'The provider returned an invalid embedding vector.', {
          retryable: false,
          providerType: this.type,
        })
      }
      const index = typeof item.index === 'number' ? item.index : i
      if (index < 0 || index >= req.input.length) {
        throw new ProviderError('unknown', 'The provider returned an unexpected embeddings format.', {
          retryable: false,
          providerType: this.type,
        })
      }
      out[index] = embedding as number[]
    }
    // Duplicate/missing indices from a buggy server must not become silent
    // zero-vector holes downstream.
    if (out.some((v) => v === undefined)) {
      throw new ProviderError('unknown', 'The provider returned an unexpected embeddings format.', {
        retryable: false,
        providerType: this.type,
      })
    }
    return out
  }

  async chat(req: AdapterChatRequest, ctx: AdapterContext): Promise<AdapterChatResult> {
    const completion = await withRetry(() => this.fetchChatCompletion(req, ctx), {
      signal: ctx.signal,
    })
    const choice = completion.choices[0]
    const msg = choice.message
    const toolCalls: ToolCallRecord[] = (msg.tool_calls ?? []).map((tc, i) => ({
      id: tc.id ?? `call_${tc.index ?? i}`,
      name: tc.function?.name ?? '',
      arguments: tc.function?.arguments ?? '',
      status: 'proposed' as const,
    }))
    return {
      text: msg.content ?? '',
      reasoning: msg.reasoning_content ?? undefined,
      toolCalls,
      usage: completion.usage ? mapUsage(completion.usage) : undefined,
      // Emitted tool calls win over the reported reason: quirky servers return
      // tool calls alongside finish_reason 'stop', and the tool loop gates on
      // 'tool_calls'.
      finishReason:
        toolCalls.length > 0 ? 'tool_calls' : (mapFinishReason(choice.finish_reason) ?? 'stop'),
    }
  }

  async *chatStream(
    req: AdapterChatRequest,
    ctx: AdapterContext
  ): AsyncGenerator<AdapterStreamEvent> {
    // Retry only applies to establishing the stream — never mid-stream.
    const res = await withRetry(() => this.postChat(req, ctx, true), { signal: ctx.signal })
    const body = requireStreamBody(res, 'The provider', this.type)

    const accum = new Map<number, ToolCallAccum>()
    const emitted = new Set<number>()
    let lastToolIndex = 0
    let finishReason: FinishReason | undefined

    const flushToolCalls = (): AdapterStreamEvent[] => {
      const events: AdapterStreamEvent[] = []
      for (const [index, acc] of [...accum.entries()].sort((a, b) => a[0] - b[0])) {
        if (emitted.has(index)) continue
        emitted.add(index)
        events.push({ type: 'tool_call', toolCall: toToolCallRecord(index, acc) })
      }
      return events
    }

    for await (const payload of parseSSE(body, ctx.signal)) {
      let json: unknown
      try {
        json = JSON.parse(payload)
      } catch {
        continue // keep-alive or provider noise
      }
      this.checkBodyForProviderError(json, ctx)
      const parsed = oaiChatChunkSchema.safeParse(json)
      if (!parsed.success) continue

      const chunk = parsed.data
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta
        if (delta?.content) yield { type: 'text', text: delta.content }
        if (delta?.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            lastToolIndex = accumulateToolCall(accum, tc, lastToolIndex)
          }
        }
        if (choice.finish_reason != null) {
          for (const ev of flushToolCalls()) yield ev
          finishReason = mapFinishReason(choice.finish_reason) ?? 'other'
        }
      }
      if (chunk.usage) {
        const usage = mapUsage(chunk.usage)
        if (usage) yield { type: 'usage', usage }
      }
    }

    // Providers that never send finish_reason: flush what we have and infer.
    for (const ev of flushToolCalls()) yield ev
    yield { type: 'finish', reason: emitted.size > 0 ? 'tool_calls' : (finishReason ?? 'stop') }
  }

  async listModels(ctx: AdapterContext): Promise<ModelInfo[]> {
    const meta = this.catalog(ctx)
    if (!meta.supportsModelListing) return meta.knownModels
    try {
      const json = await withRetry(
        async () => {
          const res = await this.doRequest(ctx, '/models', { method: 'GET' })
          return this.readJson(res, ctx)
        },
        { signal: ctx.signal }
      )
      const parsed = oaiModelsListSchema.parse(json)
      const mapped = parsed.data.map((entry) => {
        const known = findInCatalog(meta.knownModels, entry.id)
        const info: ModelInfo = known
          ? { ...known, fromCatalog: false } // live-listed, but enriched from catalog
          : { id: entry.id, capabilities: UNKNOWN_MODEL_CAPS, fromCatalog: false }
        return { info, known: known !== undefined }
      })
      mapped.sort((a, b) => Number(b.known) - Number(a.known)) // catalog-known first, stable
      return mapped.map((m) => m.info)
    } catch (e) {
      if (e instanceof ProviderError && e.code === 'aborted') throw e
      return meta.knownModels
    }
  }

  async testConnection(ctx: AdapterContext): Promise<TestConnectionResult> {
    const meta = this.catalog(ctx)
    const started = Date.now()
    try {
      if (meta.supportsModelListing) {
        const res = await this.doRequest(ctx, '/models', { method: 'GET' })
        const json = await this.readJson(res, ctx)
        const latencyMs = Date.now() - started
        const parsed = oaiModelsListSchema.safeParse(json)
        const modelCount = parsed.success ? parsed.data.data.length : undefined
        return {
          ok: true,
          message:
            modelCount !== undefined
              ? `Connected — ${modelCount} model${modelCount === 1 ? '' : 's'} available.`
              : 'Connected.',
          latencyMs,
          ...(modelCount !== undefined ? { modelCount } : {}),
        }
      }
      // No /models endpoint: cheapest possible real chat call, no retry.
      const probe: AdapterChatRequest = {
        modelId: meta.defaultModelId,
        messages: [{ role: 'user', content: 'ping' }],
        params: { maxTokens: 1 },
        stream: false,
      }
      const res = await this.postChat(probe, ctx, false)
      let json: unknown
      try {
        json = JSON.parse(await res.text())
      } catch {
        json = undefined // lenient about body shape; HTTP 2xx is enough here
      }
      if (json !== undefined) this.checkBodyForProviderError(json, ctx)
      return { ok: true, message: 'Connected.', latencyMs: Date.now() - started }
    } catch (e) {
      return { ok: false, message: toNormalizedError(e, this.type, [ctx.apiKey]).message }
    }
  }
}
