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
    planMode: z.boolean().optional(),
    autoAcceptEdits: z.boolean().optional(),
    sandboxLevel: z.enum(['read-only', 'workspace-write', 'full']).optional(),
    reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
    responseFormat: z.enum(['json']).optional(),
  })
  .strict()

export const providerTypeSchema = z.enum([
  'deepseek',
  'zhipu',
  'minimax',
  'openai',
  'zai-coding',
  'anthropic',
  'google',
  'bedrock',
  'openai-compatible',
])

export const authModeSchema = z.enum(['api_key', 'chatgpt_oauth'])

/** Hosts for which plain http:// is allowed (local model servers). */
const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

const BASE_URL_MESSAGE = 'Base URL must use https:// (http is only allowed for localhost)'

/**
 * Accepts any https:// URL, and http:// only when it targets a loopback host
 * (localhost / 127.0.0.1 / [::1]) so local servers like Ollama/LM Studio work
 * while remote endpoints can never receive the Bearer key over plaintext.
 */
export function isAllowedBaseUrl(value: string): boolean {
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

/**
 * Placeholder bearer for keyless loopback providers (Ollama, LM Studio, Jan
 * accept any token). Not a secret: redaction must NOT treat it as one, or
 * every error mentioning "localhost" gets mangled.
 */
export const KEYLESS_API_KEY = 'local'

/**
 * True when a base URL targets a loopback host (localhost / 127.0.0.1 / ::1).
 * SECURITY: this is the gate for keyless providers — local model servers
 * (Ollama, LM Studio, Jan) accept any bearer, so a provider without a stored
 * key is usable ONLY when this returns true for its own base URL; the
 * placeholder bearer must never be sent to a remote endpoint.
 */
export function isLoopbackBaseUrl(value: string | null | undefined): boolean {
  if (!value) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.replace(/^\[|\]$/g, '')
  return LOCAL_HTTP_HOSTS.has(host)
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
  authMode: authModeSchema.optional(),
  presetId: z.string().trim().min(1).max(100).nullable().optional(),
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
// Skills. pluginName/sourcePath are deliberately absent: IPC create/update is
// manual authoring; only the main-side folder import sets provenance.
// ---------------------------------------------------------------------------

export const skillInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(1024).optional(),
    content: z.string().max(200_000),
  })
  .strict()

export const skillPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(1024).optional(),
    content: z.string().max(200_000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

// ---------------------------------------------------------------------------
// Memory. sourceConversationId is deliberately absent: IPC create/update is
// always user-initiated; only the main-side completion hook sets provenance.
// ---------------------------------------------------------------------------

export const memoryInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    content: z.string().max(10_000),
  })
  .strict()

export const memoryPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    content: z.string().max(10_000).optional(),
  })
  .strict()

// ---------------------------------------------------------------------------
// Notebooks (Home-level living Markdown docs). Caps are mirrored as error
// strings in the edit_document tool handler (tools/executor.ts).
// ---------------------------------------------------------------------------

export const notebookDocInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    content: z.string().max(200_000).optional(),
  })
  .strict()

export const notebookDocPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    content: z.string().max(200_000).optional(),
  })
  .strict()

/**
 * A standing approval rule from the renderer. Note what is NOT here: the rule
 * can only ever say "ask" or "skip the dialog" — there is no shape in which it
 * grants a capability, so a malformed rule costs at most one extra prompt.
 */
export const toolRuleInputSchema = z
  .object({
    toolId: z.string().trim().min(1).max(200),
    effect: z.enum(['allow', 'require_approval']),
    scope: z.enum(['global', 'conversation', 'project']),
    scopeId: z.string().trim().min(1).max(200).nullable().optional(),
    pattern: z.string().trim().max(500).nullable().optional(),
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

/**
 * Outbound completion webhook. Delivery drops anything that isn't https (or
 * http on a loopback host), so the same rule is enforced here — a webhook that
 * can never fire must fail at set time, not silently at send time. '' and null
 * both mean "no webhook".
 */
export const outboundWebhookUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => value.length === 0 || isAllowedHttpUrl(value), {
    message: 'Webhook URL must use https:// (http is only allowed for localhost)',
  })
  .nullable()

/**
 * True for an app-generated attachment storage key ('<uuid>.<ext>'). Anything
 * with path separators, '..', drive letters or other characters is rejected so
 * a stored key can never be used to read outside the attachments dir. Enforced
 * at the IPC boundary (chat.send attachmentSchema); every on-disk read of a
 * storageKey gates on it again as defense in depth (readStoredImage,
 * chat-service imageDataUrl).
 */
export function isValidStorageKey(storageKey: string): boolean {
  return /^[A-Za-z0-9-]+\.[A-Za-z0-9]+$/.test(storageKey)
}

const modeModelDefaultSchema = z
  .object({
    providerId: z.string().nullable(),
    modelId: z.string().max(200).nullable(),
  })
  .strict()

/** Full per-mode map (both modes present, matching AppSettings.modeModels). */
const modeModelsSchema = z
  .object({
    chat: modeModelDefaultSchema,
    work: modeModelDefaultSchema,
  })
  .strict()

// ---------------------------------------------------------------------------
// Mixture of Agents presets (Settings → Mixture of Agents).
// ---------------------------------------------------------------------------

const moaModelRefSchema = z
  .object({
    providerId: z.string().min(1).max(200),
    modelId: z.string().min(1).max(200),
  })
  .strict()

/** A positive temperature bound matching chatParamsSchema. */
const moaTemperatureSchema = z.number().min(0).max(2)
const moaMaxTokensSchema = z.number().int().positive().max(1_000_000)

export const moaPresetSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(100),
    referenceModels: z.array(moaModelRefSchema).min(1).max(8),
    aggregator: moaModelRefSchema,
    referenceMaxTokens: moaMaxTokensSchema.optional(),
    referenceTemperature: moaTemperatureSchema.optional(),
    aggregatorTemperature: moaTemperatureSchema.optional(),
    maxTokens: moaMaxTokensSchema.optional(),
    enabled: z.boolean(),
  })
  .strict()

// ---------------------------------------------------------------------------
// Deep Research
// ---------------------------------------------------------------------------

export const researchDepthSchema = z.enum(['quick', 'standard', 'deep'])

// ---------------------------------------------------------------------------
// Workflows (IPC boundary)
// ---------------------------------------------------------------------------

export const workflowNodeKindSchema = z.enum([
  'manual',
  'ai_agent',
  'http_request',
  'template',
  'condition',
  'notify',
  'output',
])

export const workflowNodeSchema = z
  .object({
    id: z.string().min(1).max(200),
    kind: workflowNodeKindSchema,
    label: z.string().max(500),
    position: z.object({ x: z.number(), y: z.number() }),
    // Kind-specific config; values are consumed defensively by the engine.
    config: z.record(z.unknown()),
  })
  .strict()

export const workflowEdgeSchema = z
  .object({
    id: z.string().min(1).max(200),
    source: z.string().min(1).max(200),
    target: z.string().min(1).max(200),
    sourceHandle: z.string().max(200).nullish(),
  })
  .strict()

export const workflowGraphSchema = z
  .object({
    nodes: z.array(workflowNodeSchema).max(500),
    edges: z.array(workflowEdgeSchema).max(2000),
  })
  .strict()

/** One Reliability Autopilot chain entry — both parts required. */
const failoverChainEntrySchema = z
  .object({
    providerId: z.string().min(1).max(200),
    modelId: z.string().min(1).max(200),
  })
  .strict()

/** One quick-assistant action (a button in the quick mini window). */
export const quickActionSchema = z
  .object({
    id: z.string().min(1).max(100),
    label: z.string().trim().min(1).max(60),
    prompt: z.string().min(1).max(20_000),
    providerId: z.string().min(1).max(200).optional(),
    modelId: z.string().min(1).max(200).optional(),
  })
  .strict()

export const settingsPatchSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']),
    defaultProviderId: z.string().nullable(),
    defaultModelId: z.string().nullable(),
    perModeModelsEnabled: z.boolean(),
    modeModels: modeModelsSchema,
    moaPresets: z.array(moaPresetSchema).max(50),
    defaultMoaPresetId: z.string().nullable(),
    defaultSystemPrompt: z.string().max(100_000),
    defaultParams: chatParamsSchema,
    telemetryEnabled: z.boolean(),
    warnBeforeSendingFiles: z.boolean(),
    sendUsageWithMessages: z.boolean(),
    onboardingCompleted: z.boolean(),
    fontSize: z.enum(['small', 'medium', 'large']),
    compactionEnabled: z.boolean(),
    compactionThresholdRatio: z.number().min(0.1).max(0.95),
    memoryEnabled: z.boolean(),
    dreamingEnabled: z.boolean(),
    shellExecutionEnabled: z.boolean(),
    shellCommandAllowlist: z.array(z.string().trim().min(1).max(200)).max(100),
    browserToolsEnabled: z.boolean(),
    telegramBridgeEnabled: z.boolean(),
    telegramBridgeConversationId: z.string().nullable(),
    // telegramBridgeAllowedChatId is deliberately absent: it is the bridge's
    // trust-on-first-use pairing pin, owned by main (ImBridgeManager writes it
    // via the settings repo). Accepting it here would let the renderer — or a
    // tampered backup — pre-authorize an arbitrary Telegram sender.
    outboundWebhookUrl: outboundWebhookUrlSchema,
    researchWorkerProviderId: z.string().nullable(),
    researchWorkerModelId: z.string().max(200).nullable(),
    economyProviderId: z.string().nullable(),
    economyModelId: z.string().max(200).nullable(),
    researchDefaultDepth: researchDepthSchema,
    defaultImageProviderId: z.string().nullable(),
    defaultImageModelId: z.string().max(200).nullable(),
    autoRoutingEnabled: z.boolean(),
    autoRoutingPolicy: z.enum(['balanced', 'lowest_cost', 'highest_quality', 'local_only']),
    autoRoutingMaxCostUsd: z.number().positive().max(10_000).nullable(),
    monthlyBudgetUsd: z.number().positive().max(1_000_000).nullable(),
    failoverChains: z
      .object({
        interactive: z.array(failoverChainEntrySchema).max(5).optional(),
        headless: z.array(failoverChainEntrySchema).max(5).optional(),
      })
      .strict(),
    projectHooks: z.array(z.object({
      id: z.string().min(1).max(200),
      name: z.string().trim().min(1).max(200),
      event: z.enum(['afterAgent', 'afterApply', 'beforeCommit']),
      command: z.string().trim().min(1).max(2000),
      enabled: z.boolean(),
    }).strict()).max(100),
    ideCommand: z.enum(['auto', 'code', 'cursor', 'zed']),
    gettingStartedDismissedAt: z.number().nullable(),
    dismissedTipIds: z.array(z.string().min(1).max(100)).max(200),
    paletteEverOpened: z.boolean(),
    desktopNotificationsEnabled: z.boolean(),
    runInBackground: z.boolean(),
    launchAtLogin: z.boolean(),
    botMode: z
      .object({
        groupMaxRounds: z.number().int().min(1).max(10),
        groupMaxMessages: z.number().int().min(1).max(50),
        maxHops: z.number().int().min(1).max(20),
        groupMaxMembers: z.number().int().min(2).max(12),
      })
      .strict(),
    remoteApprovalsEnabled: z.boolean(),
    workflowWebhookEnabled: z.boolean(),
    // Unprivileged ports are refused: the endpoint must never need elevation.
    workflowWebhookPort: z.number().int().min(1024).max(65_535),
    // workflowWebhookToken is deliberately absent: the endpoint's secret is
    // minted by main (the settings handler on enable, the regenerate handler on
    // rotation) and written straight to the settings repo. Accepting it here
    // would let a renderer — or a replayed IPC payload — choose the key that
    // guards the app's only inbound port.
    // remoteDesktopId is deliberately absent too: the routing id is minted by
    // main when the tunnel is first enabled. The relay/desktop auth token and
    // per-device keys never appear here — they live in encrypted storage.
    morningBrief: z
      .object({
        enabled: z.boolean(),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        agentId: z.string().min(1).nullable(),
        deliverTelegram: z.boolean(),
        deliverNotification: z.boolean(),
      })
      .strict()
      .nullable(),
    // morningBriefHistory is deliberately absent: the stored briefs are written
    // only by main (BriefService); accepting them here would let the renderer —
    // or an imported backup — fabricate or truncate the digest history.
    voiceInputEnabled: z.boolean(),
    voiceReadAloudEnabled: z.boolean(),
    voiceModelId: z.enum(['tiny', 'base']),
    quickActions: z.array(quickActionSchema).max(50),
    // Empty string = the quick-assistant shortcut is disabled.
    quickAssistantShortcut: z.string().max(64),
    // appLockHash is deliberately absent: the scrypt verifier is minted and
    // checked only by main (the lock:setPassphrase handler). Accepting it here
    // would let a renderer — or a replayed IPC payload — swap the app-lock
    // passphrase for one of its own choosing.
    appLockIdleMinutes: z.number().int().min(1).max(1440).nullable(),
    // voiceWhisperBinaryPath is deliberately absent: the executable main spawns
    // for transcription is chosen only through the voice:pickBinary handler's
    // native dialog and written to the settings repo main-side. Accepting it
    // here would let a renderer — or an imported backup — point main at an
    // arbitrary binary.
  })
  .partial()
  .strict()

// ---------------------------------------------------------------------------
// Private spaces + app lock (v45 — IPC boundary)
// ---------------------------------------------------------------------------

export const spaceCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
})

export const spaceUpdateSchema = z.object({
  id: z.string().min(1),
  patch: z
    .object({
      name: z.string().trim().min(1).max(60).optional(),
      // null = all providers; a present list must name at least one.
      providerAllowlist: z
        .array(z.string().min(1).max(100))
        .min(1)
        .max(100)
        .nullable()
        .optional(),
    })
    .strict(),
})

export const appLockUnlockSchema = z.object({
  passphrase: z.string().min(1).max(500),
})

export const appLockSetPassphraseSchema = z.object({
  current: z.string().max(500).optional(),
  // null removes the lock; a new passphrase needs at least 6 chars.
  next: z.string().min(6).max(500).nullable(),
})

export const backupExportOptionsSchema = z
  .object({
    includePrivateSpaces: z.boolean().optional(),
  })
  .optional()

// ---------------------------------------------------------------------------
// Voice (offline whisper.cpp STT — IPC boundary)
// ---------------------------------------------------------------------------

export const voiceModelIdSchema = z.enum(['tiny', 'base'])

/** One chunk of a push-to-talk STT session (Uint8Array survives structured clone). */
export const voiceSttChunkSchema = z
  .object({
    sessionId: z.string().min(1).max(100),
    chunk: z
      .instanceof(Uint8Array)
      .refine((c) => c.byteLength > 0 && c.byteLength <= 8 * 1024 * 1024, {
        message: 'Audio chunk must be 1 byte to 8 MB',
      }),
  })
  .strict()

export const voiceSttSessionSchema = z
  .object({ sessionId: z.string().min(1).max(100) })
  .strict()

/** messageId/attachmentId travel together: both = persist the transcript onto the message. */
export const voiceTranscribeAttachmentSchema = z
  .object({
    storageKey: z
      .string()
      .max(300)
      .refine(isValidStorageKey, { message: 'Invalid attachment storage key' }),
    messageId: z.string().min(1).max(200).optional(),
    attachmentId: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => (v.messageId === undefined) === (v.attachmentId === undefined), {
    message: 'messageId and attachmentId must be given together',
  })

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
    prompt_tokens_details: z
      .object({ cached_tokens: z.number().optional() })
      .passthrough()
      .nullable()
      .optional(),
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

/** POST /images/generations response (OpenAI images API + compatibles). */
export const oaiImagesResponseSchema = z
  .object({
    created: z.number().optional(),
    data: z
      .array(
        z
          .object({
            b64_json: z.string().optional(),
            url: z.string().optional(),
            revised_prompt: z.string().optional(),
          })
          .passthrough()
      )
      .min(1),
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
