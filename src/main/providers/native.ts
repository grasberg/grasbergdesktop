/**
 * Helpers shared by the native (non-OpenAI-compatible) adapters — Anthropic,
 * Google Gemini, Amazon Bedrock and the ChatGPT Codex path. Each adapter keeps
 * its own wire mapping; only the dialect-independent plumbing lives here.
 */

import type { ProviderType, TestConnectionResult, TokenUsage, ToolCallRecord } from '@shared/types'
import type { AdapterChatRequest, AdapterChatResult, AdapterStreamEvent } from './adapter'
import { toNormalizedError } from './errors'

/** Parse a `data:<mime>;base64,<data>` URL; null when it isn't one. */
export function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url)
  return m ? { mediaType: m[1], data: m[2] } : null
}

/** Tool-call arguments arrive as a JSON string; empty/invalid degrade to {}. */
export function parseToolArguments(args: string | undefined): unknown {
  if (!args) return {}
  try {
    return JSON.parse(args)
  } catch {
    return {}
  }
}

export interface CollectStreamOptions {
  /**
   * When true, successive usage events merge field-by-field with the first
   * defined value winning (Anthropic splits prompt/completion tokens across
   * message_start and message_delta). Default: last event wins.
   */
  mergeUsage?: boolean
}

/**
 * Accumulates a chatStream into a non-streaming AdapterChatResult, applying
 * the same tool-call finish-reason override the streaming paths use.
 */
export async function collectStream(
  stream: AsyncGenerator<AdapterStreamEvent>,
  opts: CollectStreamOptions = {}
): Promise<AdapterChatResult> {
  let text = ''
  let reasoning = ''
  const toolCalls: ToolCallRecord[] = []
  let usage: TokenUsage | undefined
  let finishReason: AdapterChatResult['finishReason'] = 'stop'
  for await (const ev of stream) {
    if (ev.type === 'text') text += ev.text
    else if (ev.type === 'reasoning') reasoning += ev.text
    else if (ev.type === 'tool_call') toolCalls.push(ev.toolCall)
    else if (ev.type === 'usage') usage = opts.mergeUsage && usage ? mergeUsage(usage, ev.usage) : ev.usage
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

function mergeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens ?? b.promptTokens,
    completionTokens: a.completionTokens ?? b.completionTokens,
    totalTokens: a.totalTokens ?? b.totalTokens,
  }
}

export interface ProbeConnectionOptions {
  modelId: string
  providerType: ProviderType
  /** Scrubbed from any failure text (API keys, account ids). */
  secrets: string[]
  successMessage: string
}

/** Cheapest possible real chat call ("ping", 1 token) to validate credentials. */
export async function probeConnection(
  chat: (req: AdapterChatRequest) => Promise<AdapterChatResult>,
  opts: ProbeConnectionOptions
): Promise<TestConnectionResult> {
  const started = Date.now()
  try {
    await chat({
      modelId: opts.modelId,
      messages: [{ role: 'user', content: 'ping' }],
      params: { maxTokens: 1 },
      stream: false,
    })
    return { ok: true, message: opts.successMessage, latencyMs: Date.now() - started }
  } catch (e) {
    return { ok: false, message: toNormalizedError(e, opts.providerType, opts.secrets).message }
  }
}
