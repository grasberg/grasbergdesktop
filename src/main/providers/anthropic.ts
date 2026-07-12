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
  ProviderErrorCode,
  ProviderType,
  TestConnectionResult,
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
import { ProviderError } from './errors'
import { checkedFetch, joinUrl, requireStreamBody } from './http'
import { collectStream, parseDataUrl, parseToolArguments, probeConnection } from './native'
import { redactSecrets } from './redact'
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

/** Extended-thinking token budgets per reasoning effort. */
export const ANTHROPIC_THINKING_BUDGETS: Record<'low' | 'medium' | 'high', number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
}

export function buildAnthropicBody(req: AdapterChatRequest, stream: boolean): Record<string, unknown> {
  const { system, messages } = toAnthropicMessages(req.messages)
  const body: Record<string, unknown> = {
    model: req.modelId,
    max_tokens: req.params.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
    stream,
  }
  // Prompt caching: mark the system prompt (caches tools + system, which are
  // stable across a conversation) and the last message (caches the growing
  // transcript incrementally — each request re-reads the previous turns from
  // cache and extends it). Both are cheap no-ops when the prefix is too short
  // for the provider's cache minimum.
  if (system) {
    body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
  }
  const lastMessage = messages[messages.length - 1]
  if (lastMessage) {
    const content = lastMessage.content as Block[]
    const lastBlock = content[content.length - 1]
    if (lastBlock) lastBlock.cache_control = { type: 'ephemeral' }
  }
  // Extended thinking. Skipped when the transcript already contains assistant
  // tool_use turns: with thinking enabled Anthropic requires those turns to
  // carry their original thinking blocks, which our normalized history does
  // not preserve — so thinking applies to the first round of a tool loop and
  // to tool-free requests, never to feedback rounds.
  const effort = req.params.reasoningEffort
  const hasToolUseHistory = req.messages.some(
    (m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0
  )
  if (effort && !hasToolUseHistory) {
    const budget = ANTHROPIC_THINKING_BUDGETS[effort]
    body.thinking = { type: 'enabled', budget_tokens: budget }
    // max_tokens must exceed the thinking budget.
    body.max_tokens = Math.max(req.params.maxTokens ?? DEFAULT_MAX_TOKENS, budget + 2048)
  } else {
    // temperature/top_p are rejected alongside thinking — send only without it.
    if (req.params.temperature !== undefined) body.temperature = req.params.temperature
    if (req.params.topP !== undefined) body.top_p = req.params.topP
  }
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
      | {
          input_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        }
      | undefined
    if (usage && typeof usage.input_tokens === 'number') {
      const cacheRead =
        typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0
      const cacheWrite =
        typeof usage.cache_creation_input_tokens === 'number'
          ? usage.cache_creation_input_tokens
          : 0
      out.push({
        type: 'usage',
        usage: {
          // Anthropic's input_tokens EXCLUDES cached tokens; normalize to the
          // inclusive convention (OpenAI/Gemini) so display and cost math are
          // provider-independent.
          promptTokens: usage.input_tokens + cacheRead + cacheWrite,
          ...(cacheRead > 0 ? { cachedInputTokens: cacheRead } : {}),
          ...(cacheWrite > 0 ? { cacheCreationTokens: cacheWrite } : {}),
        },
      })
    }
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

/** Anthropic's documented error types → our normalized codes. */
const STREAM_ERROR_CODES: Record<string, ProviderErrorCode> = {
  invalid_request_error: 'invalid_request',
  authentication_error: 'auth',
  permission_error: 'auth',
  not_found_error: 'invalid_request',
  request_too_large: 'invalid_request',
  rate_limit_error: 'rate_limit',
  timeout_error: 'timeout',
  api_error: 'server',
  overloaded_error: 'server',
  billing_error: 'invalid_request',
}

/** Transient failures worth another attempt — 'overloaded_error' is Anthropic's 529. */
const STREAM_ERROR_RETRYABLE = new Set([
  'overloaded_error',
  'api_error',
  'rate_limit_error',
  'timeout_error',
])

/** Maps an in-stream `{type:'error', error:{type,message}}` event to a ProviderError. */
export function anthropicStreamError(json: unknown, secrets: string[]): ProviderError {
  const err = (json as { error?: { type?: unknown; message?: unknown } }).error ?? {}
  const type = typeof err.type === 'string' ? err.type : undefined
  const detail = typeof err.message === 'string' ? redactSecrets(err.message, secrets).trim() : ''
  const label = type ? ` (${type})` : ''
  return new ProviderError(
    (type ? STREAM_ERROR_CODES[type] : undefined) ?? 'server',
    `Anthropic reported a stream error${label}${detail ? `: ${detail}` : '.'}`,
    {
      retryable: type !== undefined && STREAM_ERROR_RETRYABLE.has(type),
      providerType: 'anthropic',
    }
  )
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
      honorRetryAfter: true,
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
        throw anthropicStreamError(json, [ctx.apiKey])
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
