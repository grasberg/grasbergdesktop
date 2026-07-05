/**
 * Amazon Bedrock adapter — the unified **Converse** API
 * (`POST {baseUrl}/model/{modelId}/converse`), a native dialect.
 *
 * Auth is a bearer token (`AWS_BEARER_TOKEN_BEDROCK`) — this deliberately avoids
 * SigV4 signing and the AWS SDK. The region lives in the base-URL host
 * (`https://bedrock-runtime.{region}.amazonaws.com`), editable in the add form.
 *
 * v1 uses NON-streaming Converse: ConverseStream frames responses in the binary
 * `application/vnd.amazon.eventstream` protocol, which our SSE parser cannot
 * read. `chatStream` therefore runs one Converse request and yields its result
 * as a single burst (text → tool calls → usage → finish). A binary-eventstream
 * parser for true streaming is a scoped follow-up.
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
import { ProviderError } from './errors'
import { checkedFetch, joinUrl } from './http'
import { parseDataUrl, parseToolArguments, probeConnection } from './native'
import { withRetry } from './retry'

type FinishReason = AdapterChatResult['finishReason']
type Block = Record<string, unknown>

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

function imageBlock(url: string): Block | null {
  const parsed = parseDataUrl(url)
  if (!parsed || !parsed.mediaType.startsWith('image/')) return null
  const subtype = parsed.mediaType.slice('image/'.length)
  if (!subtype) return null
  const format = subtype === 'jpg' ? 'jpeg' : subtype
  return { image: { format, source: { bytes: parsed.data } } }
}

function userContent(content: string | ContentPart[]): Block[] {
  if (typeof content === 'string') return [{ text: content }]
  const blocks: Block[] = []
  for (const p of content) {
    if (p.type === 'text') blocks.push({ text: p.text })
    else {
      const img = imageBlock(p.image_url.url)
      if (img) blocks.push(img)
    }
  }
  return blocks
}

/** Bedrock requires alternating roles; coalesce adjacent same-role turns. */
export function toConverseMessages(messages: AdapterMessage[]): {
  system?: Block[]
  messages: Block[]
} {
  const systemParts: string[] = []
  const out: Block[] = []
  const push = (role: 'user' | 'assistant', content: Block[]): void => {
    const last = out[out.length - 1]
    if (last && last.role === role) (last.content as Block[]).push(...content)
    else out.push({ role, content })
  }

  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string') systemParts.push(m.content)
    } else if (m.role === 'tool') {
      push('user', [
        {
          toolResult: {
            toolUseId: m.toolCallId ?? '',
            content: [{ text: typeof m.content === 'string' ? m.content : '' }],
          },
        },
      ])
    } else if (m.role === 'assistant') {
      const blocks: Block[] = []
      const text = typeof m.content === 'string' ? m.content : ''
      if (text) blocks.push({ text })
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ toolUse: { toolUseId: tc.id, name: tc.name, input: parseToolArguments(tc.arguments) } })
      }
      if (blocks.length > 0) push('assistant', blocks)
    } else {
      push('user', userContent(m.content))
    }
  }

  return { system: systemParts.length > 0 ? [{ text: systemParts.join('\n\n') }] : undefined, messages: out }
}

export function buildConverseBody(req: AdapterChatRequest): Record<string, unknown> {
  const { system, messages } = toConverseMessages(req.messages)
  const body: Record<string, unknown> = { messages }
  if (system) body.system = system
  const inference: Record<string, unknown> = {}
  if (req.params.maxTokens !== undefined) inference.maxTokens = req.params.maxTokens
  if (req.params.temperature !== undefined) inference.temperature = req.params.temperature
  if (req.params.topP !== undefined) inference.topP = req.params.topP
  if (Object.keys(inference).length > 0) body.inferenceConfig = inference
  if (req.tools && req.tools.length > 0) {
    body.toolConfig = {
      tools: req.tools.map((t: AdapterToolDef) => ({
        toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters } },
      })),
    }
  }
  return body
}

function mapConverseStop(reason: unknown): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'tool_use':
      return 'tool_calls'
    case 'max_tokens':
      return 'length'
    default:
      return 'other'
  }
}

export interface ConverseResult {
  text: string
  toolCalls: ToolCallRecord[]
  usage?: TokenUsage
  finishReason: FinishReason
}

export function mapConverseResult(json: unknown): ConverseResult {
  const o = (json ?? {}) as Record<string, unknown>
  const message = (o.output as Record<string, unknown> | undefined)?.message as
    | { content?: Block[] }
    | undefined
  let text = ''
  const toolCalls: ToolCallRecord[] = []
  for (const block of message?.content ?? []) {
    if (typeof block.text === 'string') text += block.text
    else if (block.toolUse && typeof block.toolUse === 'object') {
      const tu = block.toolUse as { toolUseId?: string; name?: string; input?: unknown }
      toolCalls.push({
        id: tu.toolUseId ?? '',
        name: tu.name ?? '',
        arguments: JSON.stringify(tu.input ?? {}),
        status: 'proposed',
      })
    }
  }
  const u = o.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined
  const usage: TokenUsage | undefined = u
    ? { promptTokens: u.inputTokens, completionTokens: u.outputTokens, totalTokens: u.totalTokens }
    : undefined
  return { text, toolCalls, usage, finishReason: mapConverseStop(o.stopReason) }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class BedrockAdapter implements ProviderAdapter {
  readonly type: ProviderType = 'bedrock'

  private async converse(req: AdapterChatRequest, ctx: AdapterContext): Promise<ConverseResult> {
    const url = joinUrl(ctx.baseUrl, `/model/${encodeURIComponent(req.modelId)}/converse`)
    const res = await checkedFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildConverseBody(req)),
      signal: ctx.signal,
      providerType: this.type,
      secrets: [ctx.apiKey],
      fetchImpl: ctx.fetchImpl,
    })
    let json: unknown
    try {
      json = JSON.parse(await res.text())
    } catch {
      throw new ProviderError('unknown', 'Bedrock returned a non-JSON response.', {
        retryable: false,
        providerType: this.type,
      })
    }
    return mapConverseResult(json)
  }

  async chat(req: AdapterChatRequest, ctx: AdapterContext): Promise<AdapterChatResult> {
    const r = await withRetry(() => this.converse(req, ctx), { signal: ctx.signal })
    return {
      text: r.text,
      toolCalls: r.toolCalls,
      usage: r.usage,
      finishReason: r.toolCalls.length > 0 ? 'tool_calls' : r.finishReason,
    }
  }

  /** Non-streaming under the hood: one Converse request, yielded as a burst. */
  async *chatStream(req: AdapterChatRequest, ctx: AdapterContext): AsyncGenerator<AdapterStreamEvent> {
    const r = await this.chat(req, ctx)
    if (r.text) yield { type: 'text', text: r.text }
    for (const tc of r.toolCalls) yield { type: 'tool_call', toolCall: tc }
    if (r.usage) yield { type: 'usage', usage: r.usage }
    yield { type: 'finish', reason: r.finishReason }
  }

  async listModels(_ctx: AdapterContext): Promise<ModelInfo[]> {
    return PROVIDER_TYPES.bedrock.knownModels
  }

  async testConnection(ctx: AdapterContext): Promise<TestConnectionResult> {
    return probeConnection((req) => this.chat(req, ctx), {
      modelId: PROVIDER_TYPES.bedrock.defaultModelId,
      providerType: this.type,
      secrets: [ctx.apiKey],
      successMessage: 'Connected.',
    })
  }
}
