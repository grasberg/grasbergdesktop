/**
 * Amazon Bedrock adapter — the unified **Converse** API
 * (`POST {baseUrl}/model/{modelId}/converse`), a native dialect.
 *
 * Auth is a bearer token (`AWS_BEARER_TOKEN_BEDROCK`) — this deliberately avoids
 * SigV4 signing and the AWS SDK. The region lives in the base-URL host
 * (`https://bedrock-runtime.{region}.amazonaws.com`), editable in the add form.
 *
 * Streaming uses **ConverseStream**, which frames its events in the binary
 * `application/vnd.amazon.eventstream` protocol — parsed incrementally by
 * `EventStreamParser` below (frame CRCs are not validated; TLS already
 * guarantees integrity on this path).
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
import { checkedFetch, joinUrl, requireStreamBody } from './http'
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
    else if (p.type === 'document') {
      // This adapter strips document parts: substitute the extracted text.
      blocks.push({
        text: p.fallbackText ?? `[Attached PDF: ${p.name ?? 'document'} — not supported by this provider]`,
      })
    } else {
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
// AWS eventstream framing (application/vnd.amazon.eventstream)
// ---------------------------------------------------------------------------

const textDecoder = new TextDecoder()

/** Frames larger than this are corrupt (Bedrock events are small JSON). */
const EVENTSTREAM_MAX_FRAME_BYTES = 16 * 1024 * 1024

export interface EventStreamMessage {
  /** Frame headers, e.g. ':message-type', ':event-type', ':exception-type'. */
  headers: Record<string, string>
  /** Frame payload (JSON text for Bedrock events). */
  payload: string
}

/** Bytes occupied by a non-string header value, by header-value type. */
function headerValueSize(type: number, view: DataView, offset: number): number {
  switch (type) {
    case 0: // bool true
    case 1: // bool false
      return 0
    case 2: // byte
      return 1
    case 3: // short
      return 2
    case 4: // integer
      return 4
    case 5: // long
    case 8: // timestamp
      return 8
    case 6: // byte array (2-byte length prefix)
      return 2 + view.getUint16(offset)
    case 9: // uuid
      return 16
    default:
      throw new Error(`eventstream: unknown header value type ${type}`)
  }
}

/**
 * Incremental parser for the AWS binary eventstream framing: each frame is
 * [total length u32][headers length u32][prelude CRC u32][headers][payload]
 * [message CRC u32], all big-endian. Feed it network chunks; it returns the
 * complete frames and buffers any partial tail. CRCs are not validated.
 */
export class EventStreamParser {
  private buffer = new Uint8Array(0)

  push(chunk: Uint8Array): EventStreamMessage[] {
    const combined = new Uint8Array(this.buffer.length + chunk.length)
    combined.set(this.buffer, 0)
    combined.set(chunk, this.buffer.length)
    this.buffer = combined

    const messages: EventStreamMessage[] = []
    for (;;) {
      if (this.buffer.length < 12) break
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength)
      const totalLength = view.getUint32(0)
      if (totalLength < 16 || totalLength > EVENTSTREAM_MAX_FRAME_BYTES) {
        throw new Error('eventstream: invalid frame length')
      }
      if (this.buffer.length < totalLength) break

      const headersLength = view.getUint32(4)
      const headersEnd = 12 + headersLength
      if (headersEnd > totalLength - 4) {
        throw new Error('eventstream: invalid header length')
      }
      const headers: Record<string, string> = {}
      let off = 12
      while (off < headersEnd) {
        const nameLen = view.getUint8(off)
        off += 1
        const name = textDecoder.decode(this.buffer.subarray(off, off + nameLen))
        off += nameLen
        const type = view.getUint8(off)
        off += 1
        if (type === 7) {
          // string: 2-byte length prefix (all Bedrock event headers use this)
          const len = view.getUint16(off)
          off += 2
          headers[name] = textDecoder.decode(this.buffer.subarray(off, off + len))
          off += len
        } else {
          off += headerValueSize(type, view, off)
        }
      }
      const payload = textDecoder.decode(this.buffer.subarray(headersEnd, totalLength - 4))
      messages.push({ headers, payload })
      this.buffer = this.buffer.subarray(totalLength)
    }
    return messages
  }
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
      honorRetryAfter: true,
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

  /**
   * True streaming via ConverseStream. Retry wraps only establishing the
   * stream — never a broken mid-stream read. Tool-use inputs arrive as
   * partial-JSON deltas per content block and are emitted as one complete
   * tool_call at the block's stop event.
   */
  async *chatStream(req: AdapterChatRequest, ctx: AdapterContext): AsyncGenerator<AdapterStreamEvent> {
    const url = joinUrl(ctx.baseUrl, `/model/${encodeURIComponent(req.modelId)}/converse-stream`)
    const res = await withRetry(
      () =>
        checkedFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${ctx.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(buildConverseBody(req)),
          signal: ctx.signal,
          providerType: this.type,
          secrets: [ctx.apiKey],
          fetchImpl: ctx.fetchImpl,
          honorRetryAfter: true,
        }),
      { signal: ctx.signal }
    )
    const body = requireStreamBody(res, 'Bedrock', this.type)
    const reader = body.getReader()
    const parser = new EventStreamParser()
    /** In-flight toolUse blocks keyed by contentBlockIndex. */
    const toolBlocks = new Map<number, { id: string; name: string; input: string }>()
    let stopReason: FinishReason = 'stop'
    let sawToolCalls = false
    let sawMessageStop = false

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        for (const frame of parser.push(value)) {
          const messageType = frame.headers[':message-type']
          if (messageType === 'exception' || messageType === 'error') {
            let detail = ''
            try {
              detail = String((JSON.parse(frame.payload) as { message?: string }).message ?? '')
            } catch {
              // Non-JSON exception payload — the type header still identifies it.
            }
            const kind = frame.headers[':exception-type'] ?? frame.headers[':error-code'] ?? messageType
            throw new ProviderError('server', `Bedrock stream error: ${kind}${detail ? ` — ${detail}` : ''}`, {
              retryable: false,
              providerType: this.type,
            })
          }

          let payload: Record<string, unknown>
          try {
            payload = JSON.parse(frame.payload) as Record<string, unknown>
          } catch {
            continue
          }
          switch (frame.headers[':event-type']) {
            case 'contentBlockStart': {
              const idx = Number(payload.contentBlockIndex ?? -1)
              const start = (payload.start as { toolUse?: { toolUseId?: string; name?: string } } | undefined)
                ?.toolUse
              if (start) {
                toolBlocks.set(idx, { id: start.toolUseId ?? '', name: start.name ?? '', input: '' })
              }
              break
            }
            case 'contentBlockDelta': {
              const idx = Number(payload.contentBlockIndex ?? -1)
              const delta = payload.delta as Record<string, unknown> | undefined
              if (typeof delta?.text === 'string' && delta.text) {
                yield { type: 'text', text: delta.text }
              }
              const reasoningText = (delta?.reasoningContent as { text?: string } | undefined)?.text
              if (typeof reasoningText === 'string' && reasoningText) {
                yield { type: 'reasoning', text: reasoningText }
              }
              const toolInput = (delta?.toolUse as { input?: string } | undefined)?.input
              const block = toolBlocks.get(idx)
              if (block && typeof toolInput === 'string') block.input += toolInput
              break
            }
            case 'contentBlockStop': {
              const idx = Number(payload.contentBlockIndex ?? -1)
              const block = toolBlocks.get(idx)
              if (block) {
                toolBlocks.delete(idx)
                sawToolCalls = true
                yield {
                  type: 'tool_call',
                  toolCall: {
                    id: block.id,
                    name: block.name,
                    arguments: block.input || '{}',
                    status: 'proposed',
                  },
                }
              }
              break
            }
            case 'messageStop':
              sawMessageStop = true
              stopReason = mapConverseStop(payload.stopReason)
              break
            case 'metadata': {
              const u = payload.usage as
                | { inputTokens?: number; outputTokens?: number; totalTokens?: number }
                | undefined
              if (u) {
                yield {
                  type: 'usage',
                  usage: {
                    promptTokens: u.inputTokens,
                    completionTokens: u.outputTokens,
                    totalTokens: u.totalTokens,
                  },
                }
              }
              break
            }
            default:
              break // messageStart and friends carry nothing we surface
          }
        }
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // Already closed/errored — nothing to release.
      }
    }
    // A connection that drops before messageStop must not persist a half
    // answer as a normal completion.
    if (!sawMessageStop) {
      throw new ProviderError('server', 'Bedrock stream ended before the message completed.', {
        retryable: true,
        providerType: this.type,
      })
    }
    yield { type: 'finish', reason: sawToolCalls ? 'tool_calls' : stopReason }
  }

  async listModels(ctx: AdapterContext): Promise<ModelInfo[]> {
    return ctx.modelCatalog?.knownModels ?? PROVIDER_TYPES.bedrock.knownModels
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
