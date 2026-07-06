/**
 * OpenAI "Sign in with ChatGPT" adapter (EXPERIMENTAL, reverse-engineered).
 *
 * ChatGPT subscription access tokens do NOT work against the platform API
 * (api.openai.com/v1/chat/completions). They only authenticate against the
 * ChatGPT backend's Codex endpoint, which speaks the *Responses API* and
 * expects a Codex-shaped request. This adapter translates our normalized
 * request into that shape and maps the Responses SSE events back.
 *
 * This path is unofficial and may break without notice (OpenAI validates that
 * requests look like the Codex client; providers have shut equivalents down
 * before). It is clearly flagged experimental in the UI and never the default.
 *
 * Security: the access token (ctx.apiKey) and account id are never logged and
 * are passed to the error redactor so they can't leak into messages.
 */

import { randomUUID } from 'node:crypto'
import type {
  ModelInfo,
  ProviderType,
  TestConnectionResult,
  TokenUsage,
  ToolCallRecord,
} from '@shared/types'
import { CHATGPT_OAUTH_DEFAULT_MODEL, CHATGPT_OAUTH_MODEL_IDS, PROVIDER_TYPES } from '@shared/catalog'
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
import { checkedFetch, requireStreamBody } from './http'
import { collectStream, probeConnection } from './native'
import { withRetry } from './retry'
import { parseSSE } from './sse'

/** The ChatGPT backend Codex endpoint (fixed; not the provider's base URL). */
const CHATGPT_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

/**
 * Base instructions. OpenAI's backend inspects the request for a Codex-like
 * shape; if this proves too lax in practice it is the single place to tune.
 * The conversation's own system prompt is appended so app behavior is honored.
 */
const BASE_INSTRUCTIONS =
  'You are a coding and general-purpose assistant operating through the Grasberg Desktop client.'

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Split our messages into Responses `instructions` (system) + `input` items. */
export function messagesToResponses(messages: AdapterMessage[]): {
  instructions: string
  input: Record<string, unknown>[]
} {
  const systemParts: string[] = []
  const input: Record<string, unknown>[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string') systemParts.push(m.content)
      continue
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.toolCallId ?? '',
        output: typeof m.content === 'string' ? m.content : '',
      })
      continue
    }
    if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : partsToText(m.content)
      if (text) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        })
      }
      for (const tc of m.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })
      }
      continue
    }
    // user
    input.push({ type: 'message', role: 'user', content: userContent(m.content) })
  }

  const instructions = [BASE_INSTRUCTIONS, ...systemParts].join('\n\n')
  return { instructions, input }
}

function partsToText(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/** Map user content (string or text/image parts) to Responses input parts. */
function userContent(content: string | ContentPart[]): Record<string, unknown>[] {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }]
  return content.map((p) =>
    p.type === 'text'
      ? { type: 'input_text', text: p.text }
      : { type: 'input_image', image_url: p.image_url.url }
  )
}

/** Responses uses a flat function-tool shape (no nested `function` object). */
export function toolsToResponses(tools: AdapterToolDef[] | undefined): Record<string, unknown>[] {
  return (tools ?? []).map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false,
  }))
}

export function buildResponsesBody(req: AdapterChatRequest, stream: boolean): Record<string, unknown> {
  const { instructions, input } = messagesToResponses(req.messages)
  const body: Record<string, unknown> = {
    model: req.modelId,
    instructions,
    input,
    stream,
    store: false,
    parallel_tool_calls: false,
  }
  if (req.params.maxTokens !== undefined) body.max_output_tokens = req.params.maxTokens
  if (req.params.temperature !== undefined) body.temperature = req.params.temperature
  if (req.params.topP !== undefined) body.top_p = req.params.topP
  const tools = toolsToResponses(req.tools)
  if (tools.length > 0) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  return body
}

function mapResponsesUsage(u: unknown): TokenUsage | undefined {
  if (!u || typeof u !== 'object') return undefined
  const o = u as Record<string, unknown>
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
  const prompt = num(o.input_tokens)
  const completion = num(o.output_tokens)
  const total = num(o.total_tokens) ?? (prompt !== undefined && completion !== undefined ? prompt + completion : undefined)
  if (prompt === undefined && completion === undefined && total === undefined) return undefined
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total }
}

/** One parsed Responses SSE event → zero or more normalized stream events. */
export function parseResponsesEvent(json: unknown): AdapterStreamEvent[] {
  if (!json || typeof json !== 'object') return []
  const ev = json as Record<string, unknown>
  const type = typeof ev.type === 'string' ? ev.type : ''
  const out: AdapterStreamEvent[] = []

  switch (type) {
    case 'response.output_text.delta': {
      if (typeof ev.delta === 'string') out.push({ type: 'text', text: ev.delta })
      break
    }
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta': {
      if (typeof ev.delta === 'string') out.push({ type: 'reasoning', text: ev.delta })
      break
    }
    case 'response.output_item.done': {
      const item = ev.item as Record<string, unknown> | undefined
      if (item && item.type === 'function_call') {
        const tc: ToolCallRecord = {
          id: (item.call_id as string) ?? (item.id as string) ?? `call_${randomUUID()}`,
          name: (item.name as string) ?? '',
          arguments: typeof item.arguments === 'string' ? (item.arguments as string) : '',
          status: 'proposed',
        }
        out.push({ type: 'tool_call', toolCall: tc })
      }
      break
    }
    case 'response.completed': {
      const resp = ev.response as Record<string, unknown> | undefined
      const usage = mapResponsesUsage(resp?.usage)
      if (usage) out.push({ type: 'usage', usage })
      break
    }
    default:
      break
  }
  return out
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAICodexAdapter implements ProviderAdapter {
  readonly type: ProviderType = 'openai'

  private buildHeaders(ctx: AdapterContext): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${ctx.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'OpenAI-Beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      session_id: randomUUID(),
    }
    if (ctx.accountId) headers['chatgpt-account-id'] = ctx.accountId
    return headers
  }

  private secrets(ctx: AdapterContext): string[] {
    return ctx.accountId ? [ctx.apiKey, ctx.accountId] : [ctx.apiKey]
  }

  /**
   * The ChatGPT sign-in backend only serves the models in
   * CHATGPT_OAUTH_MODEL_IDS (gpt-5 and the older codex line were retired). Coerce
   * anything else — e.g. a provider that still has `gpt-5` stored — to the
   * current signin default so a stale id doesn't hard-fail every request.
   */
  private codexModel(modelId: string): string {
    return CHATGPT_OAUTH_MODEL_IDS.includes(modelId) ? modelId : CHATGPT_OAUTH_DEFAULT_MODEL
  }

  private post(req: AdapterChatRequest, ctx: AdapterContext, stream: boolean): Promise<Response> {
    const body = buildResponsesBody({ ...req, modelId: this.codexModel(req.modelId) }, stream)
    return checkedFetch(CHATGPT_RESPONSES_URL, {
      method: 'POST',
      headers: this.buildHeaders(ctx),
      body: JSON.stringify(body),
      signal: ctx.signal,
      providerType: this.type,
      secrets: this.secrets(ctx),
      fetchImpl: ctx.fetchImpl,
    })
  }

  async *chatStream(req: AdapterChatRequest, ctx: AdapterContext): AsyncGenerator<AdapterStreamEvent> {
    const res = await withRetry(() => this.post(req, ctx, true), { signal: ctx.signal })
    const body = requireStreamBody(res, 'ChatGPT', this.type)
    let sawToolCall = false
    for await (const payload of parseSSE(body, ctx.signal)) {
      let json: unknown
      try {
        json = JSON.parse(payload)
      } catch {
        continue
      }
      // Surface an in-stream error event as a ProviderError.
      if (json && typeof json === 'object') {
        const t = (json as Record<string, unknown>).type
        if (t === 'response.failed' || t === 'error') {
          throw new ProviderError('server', 'ChatGPT rejected the request (experimental login).', {
            retryable: false,
            providerType: this.type,
          })
        }
      }
      for (const ev of parseResponsesEvent(json)) {
        if (ev.type === 'tool_call') sawToolCall = true
        yield ev
      }
    }
    yield { type: 'finish', reason: sawToolCall ? 'tool_calls' : 'stop' }
  }

  async chat(req: AdapterChatRequest, ctx: AdapterContext): Promise<AdapterChatResult> {
    // The Codex backend is stream-first; accumulate the stream for the
    // non-streaming callers (e.g. the delegate sub-agent).
    return collectStream(this.chatStream({ ...req, stream: false }, ctx))
  }

  async listModels(_ctx: AdapterContext): Promise<ModelInfo[]> {
    // Which models this backend accepts is catalog data (CHATGPT_OAUTH_MODEL_IDS)
    // — offering the rest of the platform catalog (gpt-4o etc.) would make
    // every generation fail. The user can still type any other model id.
    return PROVIDER_TYPES.openai.knownModels.filter((m) => CHATGPT_OAUTH_MODEL_IDS.includes(m.id))
  }

  async testConnection(ctx: AdapterContext): Promise<TestConnectionResult> {
    // A single non-streaming exchange is enough to validate the token. Probe
    // with the provider's chosen model when set, else a Codex-valid default
    // (CHATGPT_OAUTH_DEFAULT_MODEL) — the rest of the platform-API catalog is
    // rejected by this backend, which would fail Test for a valid session.
    return probeConnection((req) => this.chat(req, ctx), {
      modelId: ctx.modelCatalog?.defaultModelId || CHATGPT_OAUTH_DEFAULT_MODEL,
      providerType: this.type,
      secrets: this.secrets(ctx),
      successMessage: 'Signed in to ChatGPT (experimental).',
    })
  }
}
