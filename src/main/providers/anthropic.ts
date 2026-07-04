/**
 * Anthropic (Claude) adapter — the Messages API (`POST /v1/messages`), a native
 * dialect distinct from OpenAI chat/completions. Auth is `x-api-key` +
 * `anthropic-version`. Streaming is SSE (our parseSSE handles the framing); the
 * body/system/tool shapes and the content-block delta events are mapped here.
 *
 * Security: the api key is never logged and is passed to the error redactor.
 */

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

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096

type FinishReason = AdapterChatResult['finishReason']
type Block = Record<string, unknown>

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Parse a `data:<mime>;base64,<data>` URL into Anthropic image source parts. */
function imageSource(url: string): Block {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url)
  if (m) return { type: 'base64', media_type: m[1], data: m[2] }
  return { type: 'url', url }
}

function userContent(content: string | ContentPart[]): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return content.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image', source: imageSource(p.image_url.url) }
  )
}

/**
 * Split our messages into Anthropic's top-level `system` string + `messages`.
 * Adjacent same-role messages are coalesced (Anthropic requires alternating
 * roles; our tool results arrive as separate `tool` messages that must merge
 * into the single following user turn).
 */
export function toAnthropicMessages(messages: AdapterMessage[]): {
  system?: string
  messages: Block[]
} {
  const systemParts: string[] = []
  const out: Block[] = []
  const push = (role: 'user' | 'assistant', content: Block[]): void => {
    const last = out[out.length - 1]
    if (last && last.role === role) {
      ;(last.content as Block[]).push(...content)
    } else {
      out.push({ role, content })
    }
  }

  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string') systemParts.push(m.content)
      continue
    }
    if (m.role === 'tool') {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: m.toolCallId ?? '',
          content: typeof m.content === 'string' ? m.content : '',
        },
      ])
      continue
    }
    if (m.role === 'assistant') {
      const blocks: Block[] = []
      const text = typeof m.content === 'string' ? m.content : ''
      if (text) blocks.push({ type: 'text', text })
      for (const tc of m.toolCalls ?? []) {
        let input: unknown = {}
        try {
          input = tc.arguments ? JSON.parse(tc.arguments) : {}
        } catch {
          input = {}
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input })
      }
      if (blocks.length > 0) push('assistant', blocks)
      continue
    }
    push('user', userContent(m.content))
  }

  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, messages: out }
}

export function toolsToAnthropic(tools: AdapterToolDef[] | undefined): Block[] {
  return (tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))
}

export function buildAnthropicBody(req: AdapterChatRequest, stream: boolean): Record<string, unknown> {
  const { system, messages } = toAnthropicMessages(req.messages)
  const body: Record<string, unknown> = {
    model: req.modelId,
    max_tokens: req.params.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
    stream,
  }
  if (system) body.system = system
  if (req.params.temperature !== undefined) body.temperature = req.params.temperature
  if (req.params.topP !== undefined) body.top_p = req.params.topP
  const tools = toolsToAnthropic(req.tools)
  if (tools.length > 0) body.tools = tools
  return body
}

function mapStopReason(reason: unknown): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    default:
      return 'other'
  }
}

export interface AnthropicStreamState {
  /** Open tool_use content blocks keyed by their stream index. */
  toolBlocks: Map<number, { id: string; name: string; args: string }>
}

export function newAnthropicState(): AnthropicStreamState {
  return { toolBlocks: new Map() }
}

/** One parsed Anthropic SSE event → zero or more normalized stream events. */
export function parseAnthropicEvent(json: unknown, state: AnthropicStreamState): AdapterStreamEvent[] {
  if (!json || typeof json !== 'object') return []
  const ev = json as Record<string, unknown>
  const type = ev.type
  const out: AdapterStreamEvent[] = []

  if (type === 'message_start') {
    const usage = (ev.message as Record<string, unknown> | undefined)?.usage as
      | { input_tokens?: number }
      | undefined
    if (typeof usage?.input_tokens === 'number') out.push({ type: 'usage', usage: { promptTokens: usage.input_tokens } })
  } else if (type === 'content_block_start') {
    const block = ev.content_block as Record<string, unknown> | undefined
    if (block?.type === 'tool_use' && typeof ev.index === 'number') {
      state.toolBlocks.set(ev.index, { id: String(block.id ?? ''), name: String(block.name ?? ''), args: '' })
    }
  } else if (type === 'content_block_delta') {
    const delta = ev.delta as Record<string, unknown> | undefined
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      out.push({ type: 'text', text: delta.text })
    } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      out.push({ type: 'reasoning', text: delta.thinking })
    } else if (delta?.type === 'input_json_delta' && typeof ev.index === 'number') {
      const acc = state.toolBlocks.get(ev.index)
      if (acc && typeof delta.partial_json === 'string') acc.args += delta.partial_json
    }
  } else if (type === 'content_block_stop' && typeof ev.index === 'number') {
    const acc = state.toolBlocks.get(ev.index)
    if (acc) {
      state.toolBlocks.delete(ev.index)
      const tc: ToolCallRecord = { id: acc.id, name: acc.name, arguments: acc.args, status: 'proposed' }
      out.push({ type: 'tool_call', toolCall: tc })
    }
  } else if (type === 'message_delta') {
    const usage = ev.usage as { output_tokens?: number } | undefined
    if (typeof usage?.output_tokens === 'number') {
      out.push({ type: 'usage', usage: { completionTokens: usage.output_tokens } })
    }
    const stop = (ev.delta as Record<string, unknown> | undefined)?.stop_reason
    if (stop !== undefined && stop !== null) out.push({ type: 'finish', reason: mapStopReason(stop) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AnthropicAdapter implements ProviderAdapter {
  readonly type: ProviderType = 'anthropic'

  private buildHeaders(ctx: AdapterContext): Record<string, string> {
    return {
      'x-api-key': ctx.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    }
  }

  private async post(req: AdapterChatRequest, ctx: AdapterContext, stream: boolean): Promise<Response> {
    const fetchImpl = ctx.fetchImpl ?? globalThis.fetch
    const url = ctx.baseUrl.trim().replace(/\/+$/, '') + '/messages'
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: this.buildHeaders(ctx),
        body: JSON.stringify(buildAnthropicBody(req, stream)),
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
      throw new ProviderError('server', 'Anthropic returned an empty streaming response.', {
        retryable: false,
        providerType: this.type,
      })
    }
    const state = newAnthropicState()
    let finished = false
    let sawToolCall = false
    for await (const payload of parseSSE(res.body, ctx.signal)) {
      let json: unknown
      try {
        json = JSON.parse(payload)
      } catch {
        continue
      }
      if (json && typeof json === 'object' && (json as Record<string, unknown>).type === 'error') {
        throw new ProviderError('server', 'Anthropic reported a stream error.', {
          retryable: false,
          providerType: this.type,
        })
      }
      for (const e of parseAnthropicEvent(json, state)) {
        if (e.type === 'tool_call') sawToolCall = true
        if (e.type === 'finish') finished = true
        yield e
      }
    }
    if (!finished) yield { type: 'finish', reason: sawToolCall ? 'tool_calls' : 'stop' }
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
      else if (ev.type === 'usage') usage = usage ? mergeUsage(usage, ev.usage) : ev.usage
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
    return PROVIDER_TYPES.anthropic.knownModels
  }

  async testConnection(ctx: AdapterContext): Promise<TestConnectionResult> {
    const started = Date.now()
    try {
      await this.chat(
        {
          modelId: PROVIDER_TYPES.anthropic.defaultModelId,
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

function mergeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens ?? b.promptTokens,
    completionTokens: a.completionTokens ?? b.completionTokens,
    totalTokens: a.totalTokens ?? b.totalTokens,
  }
}
