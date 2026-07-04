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
import { PROVIDER_TYPES, UNKNOWN_MODEL_CAPS, findCatalogModel } from '@shared/catalog'
import {
  oaiChatChunkSchema,
  oaiChatCompletionSchema,
  oaiModelsListSchema,
  oaiToolCallSchema,
  type OaiChatCompletion,
} from '@shared/schemas'
import type {
  AdapterChatRequest,
  AdapterChatResult,
  AdapterContext,
  AdapterMessage,
  AdapterStreamEvent,
  ProviderAdapter,
} from './adapter'
import { ProviderError, normalizeHttpError, toNormalizedError, toProviderError } from './errors'
import { withRetry } from './retry'
import { parseSSE } from './sse'

export type OaiToolCall = z.infer<typeof oaiToolCallSchema>

type FinishReason = AdapterChatResult['finishReason']

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** baseUrl arrives with no trailing-slash guarantee — normalize before joining. */
export function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.trim().replace(/\/+$/, '') + path
}

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
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
  if (stream && includeStreamOptions) body.stream_options = { include_usage: true }
  return body
}

export function mapFinishReason(reason: string | null | undefined): FinishReason | undefined {
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

export function mapUsage(u: {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}): TokenUsage | undefined {
  if (u.prompt_tokens === undefined && u.completion_tokens === undefined && u.total_tokens === undefined) {
    return undefined
  }
  return {
    promptTokens: u.prompt_tokens,
    completionTokens: u.completion_tokens,
    totalTokens: u.total_tokens,
  }
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined
  const secs = Number(headerValue)
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs)
  const date = Date.parse(headerValue)
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000))
  return undefined
}

export interface ToolCallAccum {
  id?: string
  name: string
  args: string
}

/**
 * Accumulates one streamed tool_call fragment. Fragments are keyed by `index`;
 * when a provider omits it we fall back to the id (new entry per new id) or to
 * the last-seen index for continuation fragments. Returns the index used.
 */
export function accumulateToolCall(
  accum: Map<number, ToolCallAccum>,
  tc: OaiToolCall,
  lastIndex: number
): number {
  let index: number
  if (tc.index !== undefined) {
    index = tc.index
  } else if (tc.id) {
    const existing = [...accum.entries()].find(([, a]) => a.id === tc.id)
    index = existing ? existing[0] : accum.size
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

  // -- HTTP plumbing ----------------------------------------------------------

  protected async doRequest(
    ctx: AdapterContext,
    path: string,
    init: { method: 'GET' | 'POST'; body?: string }
  ): Promise<Response> {
    const fetchImpl = ctx.fetchImpl ?? globalThis.fetch
    let res: Response
    try {
      res = await fetchImpl(joinUrl(ctx.baseUrl, path), {
        method: init.method,
        headers: this.buildHeaders(ctx, init.body !== undefined),
        body: init.body,
        signal: ctx.signal,
      })
    } catch (e) {
      throw toProviderError(e, this.type, [ctx.apiKey])
    }
    if (!res.ok) {
      let bodyText = ''
      try {
        bodyText = await res.text()
      } catch {
        // Body unavailable — normalize from status alone.
      }
      throw normalizeHttpError(
        res.status,
        bodyText,
        this.type,
        parseRetryAfterSeconds(res.headers.get('retry-after')),
        [ctx.apiKey]
      )
    }
    return res
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

  // -- ProviderAdapter ---------------------------------------------------------

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
      finishReason:
        mapFinishReason(choice.finish_reason) ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    }
  }

  async *chatStream(
    req: AdapterChatRequest,
    ctx: AdapterContext
  ): AsyncGenerator<AdapterStreamEvent> {
    // Retry only applies to establishing the stream — never mid-stream.
    const res = await withRetry(() => this.postChat(req, ctx, true), { signal: ctx.signal })
    if (!res.body) {
      throw new ProviderError('server', 'The provider returned an empty streaming response.', {
        retryable: false,
        providerType: this.type,
      })
    }

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

    for await (const payload of parseSSE(res.body, ctx.signal)) {
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
    yield { type: 'finish', reason: finishReason ?? (emitted.size > 0 ? 'tool_calls' : 'stop') }
  }

  async listModels(ctx: AdapterContext): Promise<ModelInfo[]> {
    const meta = PROVIDER_TYPES[this.type]
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
        const known = findCatalogModel(this.type, entry.id)
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
    const meta = PROVIDER_TYPES[this.type]
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
