/**
 * Google Gemini adapter — the Generative Language API
 * (`{baseUrl}/models/{model}:streamGenerateContent?alt=sse`), a native dialect.
 * Auth is the `x-goog-api-key` header (never a URL query, so the key can't land
 * in a log). `?alt=sse` makes the stream ordinary SSE for our parseSSE.
 */

import { randomUUID } from 'node:crypto'
import type {
  ModelInfo,
  ProviderType,
  TestConnectionResult,
  TokenUsage,
  ToolCallRecord,
} from '@shared/types'
import { PROVIDER_TYPES } from '@shared/catalog'
import type {
  AdapterChatRequest,
  AdapterChatResult,
  AdapterContext,
  AdapterMessage,
  AdapterStreamEvent,
  AdapterToolDef,
  ContentPart,
  ProviderAdapter,
} from './adapter'
import { ProviderError, normalizeHttpError, toNormalizedError, toProviderError } from './errors'
import { withRetry } from './retry'
import { parseSSE } from './sse'

type FinishReason = AdapterChatResult['finishReason']
type Part = Record<string, unknown>
type Content = { role: 'user' | 'model'; parts: Part[] }

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

function inlineData(url: string): Part {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url)
  if (m) return { inlineData: { mimeType: m[1], data: m[2] } }
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
        let args: unknown = {}
        try {
          args = tc.arguments ? JSON.parse(tc.arguments) : {}
        } catch {
          args = {}
        }
        parts.push({ functionCall: { name: tc.name, args } })
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
  if (Object.keys(gen).length > 0) body.generationConfig = gen
  return body
}

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
    | { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
    | undefined
  if (usage) {
    out.push({
      type: 'usage',
      usage: {
        promptTokens: usage.promptTokenCount,
        completionTokens: usage.candidatesTokenCount,
        totalTokens: usage.totalTokenCount,
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
    const base = ctx.baseUrl.trim().replace(/\/+$/, '')
    const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
    return `${base}/models/${encodeURIComponent(model)}:${method}`
  }

  private async post(req: AdapterChatRequest, ctx: AdapterContext, stream: boolean): Promise<Response> {
    const fetchImpl = ctx.fetchImpl ?? globalThis.fetch
    let res: Response
    try {
      res = await fetchImpl(this.url(ctx, req.modelId, stream), {
        method: 'POST',
        headers: { 'x-goog-api-key': ctx.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(buildGeminiBody(req)),
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
        // normalize from status alone
      }
      throw normalizeHttpError(res.status, bodyText, this.type, undefined, [ctx.apiKey])
    }
    return res
  }

  async *chatStream(req: AdapterChatRequest, ctx: AdapterContext): AsyncGenerator<AdapterStreamEvent> {
    const res = await withRetry(() => this.post(req, ctx, true), { signal: ctx.signal })
    if (!res.body) {
      throw new ProviderError('server', 'Gemini returned an empty streaming response.', {
        retryable: false,
        providerType: this.type,
      })
    }
    let sawToolCall = false
    let pendingFinish: FinishReason | undefined
    let lastUsage: TokenUsage | undefined
    for await (const payload of parseSSE(res.body, ctx.signal)) {
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
    let text = ''
    let reasoning = ''
    const toolCalls: ToolCallRecord[] = []
    let usage: TokenUsage | undefined
    let finishReason: FinishReason = 'stop'
    for await (const ev of this.chatStream({ ...req, stream: false }, ctx)) {
      if (ev.type === 'text') text += ev.text
      else if (ev.type === 'reasoning') reasoning += ev.text
      else if (ev.type === 'tool_call') toolCalls.push(ev.toolCall)
      else if (ev.type === 'usage') usage = ev.usage
      else if (ev.type === 'finish') finishReason = ev.reason
    }
    return {
      text,
      reasoning: reasoning || undefined,
      toolCalls,
      usage,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : finishReason,
    }
  }

  async listModels(_ctx: AdapterContext): Promise<ModelInfo[]> {
    return PROVIDER_TYPES.google.knownModels
  }

  async testConnection(ctx: AdapterContext): Promise<TestConnectionResult> {
    const started = Date.now()
    try {
      await this.chat(
        {
          modelId: PROVIDER_TYPES.google.defaultModelId,
          messages: [{ role: 'user', content: 'ping' }],
          params: { maxTokens: 1 },
          stream: false,
        },
        ctx
      )
      return { ok: true, message: 'Connected.', latencyMs: Date.now() - started }
    } catch (e) {
      return { ok: false, message: toNormalizedError(e, this.type, [ctx.apiKey]).message }
    }
  }
}
