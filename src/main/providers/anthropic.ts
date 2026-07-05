/**
 * Anthropic (Claude) adapter — the Messages API (`POST /v1/messages`), a native
 * dialect distinct from OpenAI chat/completions. Auth is `x-api-key` +
 * `anthropic-version`. Streaming is SSE (our parseSSE handles the framing); the
 * body/system/tool shapes and the content-block delta events are mapped here.
 *
 * Security: the api key is never logged and is passed to the error redactor.
 */

import type { ModelInfo, ProviderType, TestConnectionResult, ToolCallRecord } from '@shared/types'
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
import { ProviderError } from './errors'
import { checkedFetch, joinUrl, requireStreamBody } from './http'
import { collectStream, parseDataUrl, parseToolArguments, probeConnection } from './native'
import { withRetry } from './retry'
import { parseSSE } from './sse'

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096

type FinishReason = AdapterChatResult['finishReason']
type Block = Record<string, unknown>

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Map a `data:<mime>;base64,<data>` URL to Anthropic image source parts. */
function imageSource(url: string): Block {
  const parsed = parseDataUrl(url)
  if (parsed) return { type: 'base64', media_type: parsed.mediaType, data: parsed.data }
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
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parseToolArguments(tc.arguments) })
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

  private post(req: AdapterChatRequest, ctx: AdapterContext, stream: boolean): Promise<Response> {
    return checkedFetch(joinUrl(ctx.baseUrl, '/messages'), {
      method: 'POST',
      headers: this.buildHeaders(ctx),
      body: JSON.stringify(buildAnthropicBody(req, stream)),
      signal: ctx.signal,
      providerType: this.type,
      secrets: [ctx.apiKey],
      fetchImpl: ctx.fetchImpl,
    })
  }

  async *chatStream(req: AdapterChatRequest, ctx: AdapterContext): AsyncGenerator<AdapterStreamEvent> {
    const res = await withRetry(() => this.post(req, ctx, true), { signal: ctx.signal })
    const body = requireStreamBody(res, 'Anthropic', this.type)
    const state = newAnthropicState()
    let finished = false
    let sawToolCall = false
    for await (const payload of parseSSE(body, ctx.signal)) {
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
    // Anthropic splits usage across message_start/message_delta: merge, don't replace.
    return collectStream(this.chatStream({ ...req, stream: false }, ctx), { mergeUsage: true })
  }

  async listModels(_ctx: AdapterContext): Promise<ModelInfo[]> {
    return PROVIDER_TYPES.anthropic.knownModels
  }

  async testConnection(ctx: AdapterContext): Promise<TestConnectionResult> {
    return probeConnection((req) => this.chat(req, ctx), {
      modelId: PROVIDER_TYPES.anthropic.defaultModelId,
      providerType: this.type,
      secrets: [ctx.apiKey],
      successMessage: 'Connected.',
    })
  }
}
