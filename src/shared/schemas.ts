/**
 * Zod schemas for (a) user input validation at the IPC boundary and
 * (b) provider API response validation in adapters.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Settings + provider config (IPC boundary)
// ---------------------------------------------------------------------------

export const chatParamsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(1_000_000).optional(),
    topP: z.number().min(0).max(1).optional(),
    frequencyPenalty: z.number().min(-2).max(2).optional(),
    presencePenalty: z.number().min(-2).max(2).optional(),
  })
  .strict()

export const providerTypeSchema = z.enum(['deepseek', 'zhipu', 'minimax', 'openai-compatible'])

/** Hosts for which plain http:// is allowed (local model servers). */
const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

const BASE_URL_MESSAGE = 'Base URL must use https:// (http is only allowed for localhost)'

/**
 * Accepts any https:// URL, and http:// only when it targets a loopback host
 * (localhost / 127.0.0.1 / [::1]) so local servers like Ollama/LM Studio work
 * while remote endpoints can never receive the Bearer key over plaintext.
 */
function isAllowedBaseUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') {
    // URL.hostname keeps brackets for IPv6, e.g. "[::1]"; strip them.
    const host = url.hostname.replace(/^\[|\]$/g, '')
    return LOCAL_HTTP_HOSTS.has(host)
  }
  return false
}

export const providerConfigInputSchema = z.object({
  type: providerTypeSchema,
  label: z.string().trim().min(1).max(100),
  baseUrl: z
    .string()
    .trim()
    .url()
    .refine(isAllowedBaseUrl, { message: BASE_URL_MESSAGE })
    .optional()
    .or(z.literal('').transform(() => undefined)),
  defaultModelId: z.string().trim().max(200).optional(),
  enabled: z.boolean().optional(),
})

export const providerConfigPatchSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  baseUrl: z
    .string()
    .trim()
    .url()
    .refine(isAllowedBaseUrl, { message: BASE_URL_MESSAGE })
    .optional(),
  defaultModelId: z.string().trim().max(200).optional(),
  enabled: z.boolean().optional(),
})

export const apiKeySchema = z.string().trim().min(1).max(4096)

// ---------------------------------------------------------------------------
// Custom HTTP tools (Settings → Tools). Shape validation at the IPC boundary;
// deep URL/method/name checks (with friendly messages) live in
// src/main/tools/custom-tools.ts and run in the mapper.
// ---------------------------------------------------------------------------

const customHeadersSchema = z.record(z.string().max(8192))

export const customToolInputSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    description: z.string().max(4000).optional(),
    baseUrl: z.string().trim().min(1).max(2000),
    method: z.string().max(10).optional(),
    headers: customHeadersSchema.optional(),
    setSecretHeaders: customHeadersSchema.optional(),
    paramsSchema: z.record(z.unknown()).optional(),
  })
  .strict()

export const customToolPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    description: z.string().max(4000).optional(),
    baseUrl: z.string().trim().min(1).max(2000).optional(),
    method: z.string().max(10).optional(),
    headers: customHeadersSchema.optional(),
    setSecretHeaders: customHeadersSchema.optional(),
    deleteSecretHeaders: z.array(z.string().max(200)).max(50).optional(),
    paramsSchema: z.record(z.unknown()).optional(),
  })
  .strict()

// ---------------------------------------------------------------------------
// Prompt library
// ---------------------------------------------------------------------------

export const promptTemplateInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(100_000),
  })
  .strict()

export const promptTemplatePatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(100_000).optional(),
  })
  .strict()

// ---------------------------------------------------------------------------
// MCP servers. Shape validation here; transport-specific rules (stdio needs a
// command, http needs an allowed https url) are enforced in the IPC handler.
// ---------------------------------------------------------------------------

const mcpMapSchema = z.record(z.string().max(8192))

export const mcpServerInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    transport: z.enum(['stdio', 'http']),
    command: z.string().max(2000).optional(),
    args: z.array(z.string().max(2000)).max(100).optional(),
    env: mcpMapSchema.optional(),
    url: z.string().max(2000).optional(),
    headers: mcpMapSchema.optional(),
    setSecrets: mcpMapSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

export const mcpServerPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    command: z.string().max(2000).optional(),
    args: z.array(z.string().max(2000)).max(100).optional(),
    env: mcpMapSchema.optional(),
    url: z.string().max(2000).optional(),
    headers: mcpMapSchema.optional(),
    setSecrets: mcpMapSchema.optional(),
    deleteSecrets: z.array(z.string().max(200)).max(50).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

/** Accepts an https url, or http only for a loopback host. */
export function isAllowedHttpUrl(value: string): boolean {
  return isAllowedBaseUrl(value)
}

export const settingsPatchSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']),
    defaultProviderId: z.string().nullable(),
    defaultModelId: z.string().nullable(),
    defaultSystemPrompt: z.string().max(100_000),
    defaultParams: chatParamsSchema,
    telemetryEnabled: z.boolean(),
    warnBeforeSendingFiles: z.boolean(),
    sendUsageWithMessages: z.boolean(),
    onboardingCompleted: z.boolean(),
    fontSize: z.enum(['small', 'medium', 'large']),
    compactionEnabled: z.boolean(),
    compactionThresholdRatio: z.number().min(0.1).max(0.95),
  })
  .partial()
  .strict()

// ---------------------------------------------------------------------------
// OpenAI-compatible API responses (adapter-side validation).
// Deliberately loose (passthrough + optional fields): providers add extra
// fields and omit others; we validate only what we consume.
// ---------------------------------------------------------------------------

export const oaiToolCallSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    index: z.number().optional(),
    function: z
      .object({
        name: z.string().optional(),
        arguments: z.string().optional(),
      })
      .optional(),
  })
  .passthrough()

export const oaiUsageSchema = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  })
  .passthrough()

/** Non-streaming chat completion. */
export const oaiChatCompletionSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            index: z.number().optional(),
            message: z
              .object({
                role: z.string().optional(),
                content: z.string().nullable().optional(),
                reasoning_content: z.string().nullable().optional(),
                tool_calls: z.array(oaiToolCallSchema).optional(),
              })
              .passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough()
      )
      .min(1),
    usage: oaiUsageSchema.optional(),
  })
  .passthrough()

/** One SSE chunk of a streaming chat completion. */
export const oaiChatChunkSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            index: z.number().optional(),
            delta: z
              .object({
                role: z.string().optional(),
                content: z.string().nullable().optional(),
                reasoning_content: z.string().nullable().optional(),
                tool_calls: z.array(oaiToolCallSchema).optional(),
              })
              .passthrough()
              .optional(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough()
      )
      .optional(),
    usage: oaiUsageSchema.nullable().optional(),
  })
  .passthrough()

export const oaiModelsListSchema = z
  .object({
    data: z.array(z.object({ id: z.string() }).passthrough()),
  })
  .passthrough()

/** Error body shape most OpenAI-compatible APIs return. */
export const oaiErrorBodySchema = z
  .object({
    error: z
      .object({
        message: z.string().optional(),
        type: z.string().optional(),
        code: z.union([z.string(), z.number()]).nullable().optional(),
      })
      .passthrough()
      .optional(),
    message: z.string().optional(),
  })
  .passthrough()

export type OaiChatCompletion = z.infer<typeof oaiChatCompletionSchema>
export type OaiChatChunk = z.infer<typeof oaiChatChunkSchema>
