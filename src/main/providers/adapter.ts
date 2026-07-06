/**
 * Provider adapter contract (main process only).
 *
 * An adapter turns our normalized request into provider HTTP calls and yields
 * normalized events. Adding a provider = implement this interface (usually by
 * subclassing the OpenAI-compatible base) and register it in registry.ts.
 *
 * Rules for implementers:
 * - Never log or embed the API key in errors. Use redact() from ./redact.
 * - Throw ProviderError (see ./errors) for all failures.
 * - Respect ctx.signal for cancellation (abort fetch, stop yielding).
 * - Validate response bodies with the zod schemas in @shared/schemas.
 */

import type {
  ModelInfo,
  ProviderType,
  TestConnectionResult,
  TokenUsage,
  ToolCallRecord,
} from '@shared/types'
import type { ProviderModelCatalog } from '@shared/catalog'

/**
 * A part of a multimodal message. String content is used for text-only
 * messages (the common case); an array of parts carries text + images for
 * vision-capable models (OpenAI content-parts format).
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** Wire-format message sent to the provider. */
export interface AdapterMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  /** Plain text, or content parts when the user message includes images. */
  content: string | ContentPart[]
  /** Present on assistant messages that invoked tools. */
  toolCalls?: ToolCallRecord[]
  /** Present on role 'tool' messages. */
  toolCallId?: string
}

export interface AdapterToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface AdapterChatRequest {
  modelId: string
  messages: AdapterMessage[]
  params: {
    temperature?: number
    maxTokens?: number
    topP?: number
    frequencyPenalty?: number
    presencePenalty?: number
    /**
     * Reasoning/thinking effort. Mapped per dialect: OpenAI-compatible
     * `reasoning_effort`, Anthropic extended-thinking budget, Gemini
     * `thinkingConfig.thinkingBudget`. Omitted from the wire when unset.
     */
    reasoningEffort?: 'low' | 'medium' | 'high'
    /**
     * 'json' = force valid-JSON output. Mapped per dialect: OpenAI-compatible
     * `response_format: json_object`, Gemini `responseMimeType`. Providers
     * without a JSON mode ignore it.
     */
    responseFormat?: 'json'
  }
  tools?: AdapterToolDef[]
  stream: boolean
}

export interface AdapterContext {
  /** Bearer credential: a static API key, or an OAuth access token. */
  apiKey: string
  baseUrl: string
  signal?: AbortSignal
  /**
   * For OAuth/ChatGPT auth: the account id sent as `chatgpt-account-id`.
   * Ignored by ordinary API-key adapters.
   */
  accountId?: string | null
  /**
   * Known-model catalog for this provider (family or preset). When present it
   * overrides PROVIDER_TYPES[type] so one openai-compatible adapter instance can
   * serve any preset. Absent for direct family providers.
   */
  modelCatalog?: ProviderModelCatalog
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/** Normalized streaming events an adapter yields. */
export type AdapterStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; toolCall: ToolCallRecord }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: 'stop' | 'length' | 'tool_calls' | 'other' }

export interface AdapterChatResult {
  text: string
  reasoning?: string
  toolCalls: ToolCallRecord[]
  usage?: TokenUsage
  finishReason: 'stop' | 'length' | 'tool_calls' | 'other'
}

export interface AdapterEmbedRequest {
  modelId: string
  /** Texts to embed (order preserved in the result). */
  input: string[]
}

export interface ProviderAdapter {
  readonly type: ProviderType
  /** Live model listing; throw ProviderError('not_supported') when unavailable. */
  listModels(ctx: AdapterContext): Promise<ModelInfo[]>
  /** Streaming chat completion. */
  chatStream(req: AdapterChatRequest, ctx: AdapterContext): AsyncGenerator<AdapterStreamEvent>
  /** Non-streaming chat completion. */
  chat(req: AdapterChatRequest, ctx: AdapterContext): Promise<AdapterChatResult>
  /** Cheap connectivity + auth check used by Settings "Test". */
  testConnection(ctx: AdapterContext): Promise<TestConnectionResult>
  /**
   * Text embeddings (knowledge bases). One vector per input, same order.
   * Absent = the provider family has no embeddings endpoint.
   */
  embed?(req: AdapterEmbedRequest, ctx: AdapterContext): Promise<number[][]>
}
