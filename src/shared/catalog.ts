/**
 * Static catalog of built-in provider families and their known models.
 * Used for: Settings UI (add provider), capability display in the model
 * selector, and fallback when a provider has no /models endpoint.
 *
 * Model lists here are a convenience, not a cage — users can always type a
 * custom model id.
 */

import type { AuthMode, ModelCapabilities, ModelInfo, ProviderType, ProviderTypeMeta } from './types'
import { presetMeta, presetModels } from './presets'

const caps = (partial?: Partial<ModelCapabilities>): ModelCapabilities => ({
  streaming: true,
  tools: false,
  vision: false,
  reasoning: false,
  ...partial,
})

const model = (
  id: string,
  label: string,
  contextLength: number,
  capabilities: ModelCapabilities
): ModelInfo => ({ id, label, contextLength, capabilities, fromCatalog: true })

export const PROVIDER_TYPES: Record<ProviderType, ProviderTypeMeta> = {
  deepseek: {
    type: 'deepseek',
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    docsUrl: 'https://api-docs.deepseek.com/',
    supportsModelListing: true,
    defaultModelId: 'deepseek-chat',
    knownModels: [
      model('deepseek-chat', 'DeepSeek Chat (V3)', 128000, caps({ tools: true })),
      model('deepseek-reasoner', 'DeepSeek Reasoner (R1)', 128000, caps({ reasoning: true })),
    ],
  },
  zhipu: {
    type: 'zhipu',
    label: 'GLM / Zhipu AI',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    docsUrl: 'https://open.bigmodel.cn/dev/api',
    supportsModelListing: false,
    defaultModelId: 'glm-4.5-flash',
    knownModels: [
      model('glm-4.6', 'GLM-4.6', 200000, caps({ tools: true })),
      model('glm-4.5', 'GLM-4.5', 128000, caps({ tools: true })),
      model('glm-4.5-air', 'GLM-4.5 Air', 128000, caps({ tools: true })),
      model('glm-4.5-flash', 'GLM-4.5 Flash (free)', 128000, caps({ tools: true })),
      model('glm-4.5v', 'GLM-4.5V (vision)', 64000, caps({ vision: true })),
      model('glm-4-plus', 'GLM-4 Plus', 128000, caps({ tools: true })),
    ],
  },
  minimax: {
    type: 'minimax',
    label: 'MiniMax',
    defaultBaseUrl: 'https://api.minimax.io/v1',
    docsUrl: 'https://platform.minimax.io/docs',
    supportsModelListing: false,
    defaultModelId: 'MiniMax-M2',
    keyLabel: 'API key (subscription / pay-as-you-go)',
    hint: 'A MiniMax subscription uses the same API key — paste the key from your MiniMax console.',
    knownModels: [
      model('MiniMax-M2', 'MiniMax M2', 200000, caps({ tools: true })),
      model('MiniMax-M1', 'MiniMax M1', 1000000, caps({ tools: true, reasoning: true })),
      model('MiniMax-Text-01', 'MiniMax Text-01', 1000000, caps({ tools: true })),
    ],
  },
  openai: {
    type: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    supportsModelListing: true,
    defaultModelId: 'gpt-4o',
    authModes: ['api_key', 'chatgpt_oauth'],
    hint: 'Use a platform API key, or "Sign in with ChatGPT" (experimental) to use your ChatGPT subscription.',
    knownModels: [
      model('gpt-4o', 'GPT-4o', 128000, caps({ tools: true, vision: true })),
      model('gpt-4o-mini', 'GPT-4o mini', 128000, caps({ tools: true, vision: true })),
      model('gpt-4.1', 'GPT-4.1', 1000000, caps({ tools: true, vision: true })),
      model('gpt-4.1-mini', 'GPT-4.1 mini', 1000000, caps({ tools: true, vision: true })),
      model('o4-mini', 'o4-mini (reasoning)', 200000, caps({ tools: true, reasoning: true })),
      model('gpt-5', 'GPT-5', 400000, caps({ tools: true, vision: true, reasoning: true })),
    ],
  },
  'zai-coding': {
    type: 'zai-coding',
    label: 'Z.ai Coding Plan (GLM)',
    // The Coding Plan has its OWN OpenAI-compatible endpoint; it is NOT
    // interchangeable with the general https://api.z.ai/api/paas/v4 endpoint.
    defaultBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
    docsUrl: 'https://docs.z.ai/devpack/quick-start',
    supportsModelListing: false,
    defaultModelId: 'glm-4.6',
    keyLabel: 'Coding Plan API key',
    hint: 'Uses your Z.ai GLM Coding Plan subscription key against the coding endpoint.',
    knownModels: [
      model('glm-4.6', 'GLM-4.6', 200000, caps({ tools: true })),
      model('glm-4.5', 'GLM-4.5', 128000, caps({ tools: true })),
      model('glm-4.5-air', 'GLM-4.5 Air', 128000, caps({ tools: true })),
      model('glm-4.5-flash', 'GLM-4.5 Flash', 128000, caps({ tools: true })),
      model('glm-4.5v', 'GLM-4.5V (vision)', 64000, caps({ vision: true })),
    ],
  },
  anthropic: {
    type: 'anthropic',
    label: 'Anthropic (Claude)',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    docsUrl: 'https://docs.anthropic.com/en/api',
    supportsModelListing: false,
    defaultModelId: 'claude-sonnet-5',
    keyLabel: 'API key (ANTHROPIC_API_KEY)',
    hint: 'Claude via the Anthropic Messages API (native dialect).',
    knownModels: [
      model('claude-sonnet-5', 'Claude Sonnet 5', 1000000, caps({ tools: true, vision: true, reasoning: true })),
      model('claude-opus-4-8', 'Claude Opus 4.8', 1000000, caps({ tools: true, vision: true, reasoning: true })),
      model('claude-fable-5', 'Claude Fable 5', 1000000, caps({ tools: true, vision: true, reasoning: true })),
      model('claude-sonnet-4-6', 'Claude Sonnet 4.6', 1000000, caps({ tools: true, vision: true, reasoning: true })),
      model('claude-haiku-4-5', 'Claude Haiku 4.5', 200000, caps({ tools: true, vision: true, reasoning: true })),
      model('claude-opus-4-5', 'Claude Opus 4.5', 200000, caps({ tools: true, vision: true, reasoning: true })),
    ],
  },
  google: {
    type: 'google',
    label: 'Google Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    supportsModelListing: false,
    defaultModelId: 'gemini-3.5-flash',
    keyLabel: 'API key (Gemini)',
    hint: 'Gemini via the Google Generative AI API (native dialect).',
    knownModels: [
      model('gemini-3.5-flash', 'Gemini 3.5 Flash', 1048576, caps({ tools: true, vision: true, reasoning: true })),
      model('gemini-3.1-pro-preview', 'Gemini 3.1 Pro (preview)', 1048576, caps({ tools: true, vision: true, reasoning: true })),
      model('gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', 1048576, caps({ tools: true, vision: true, reasoning: true })),
      model('gemini-2.5-pro', 'Gemini 2.5 Pro', 1048576, caps({ tools: true, vision: true, reasoning: true })),
      model('gemini-2.5-flash', 'Gemini 2.5 Flash', 1048576, caps({ tools: true, vision: true, reasoning: true })),
    ],
  },
  bedrock: {
    type: 'bedrock',
    label: 'Amazon Bedrock',
    // Region lives in the host — change us-east-1 here (or in the add form).
    defaultBaseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    docsUrl: 'https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html',
    supportsModelListing: false,
    defaultModelId: 'us.anthropic.claude-sonnet-5',
    keyLabel: 'Bearer token (AWS_BEARER_TOKEN_BEDROCK)',
    hint: 'Bedrock via the Converse API with a bearer token. Set your region in the base-URL host.',
    knownModels: [
      model('us.anthropic.claude-sonnet-5', 'Claude Sonnet 5 (Bedrock)', 1000000, caps({ tools: true, vision: true, reasoning: true })),
      model('us.anthropic.claude-fable-5', 'Claude Fable 5 (Bedrock)', 1000000, caps({ tools: true, vision: true, reasoning: true })),
      model('us.anthropic.claude-opus-4-8', 'Claude Opus 4.8 (Bedrock)', 1000000, caps({ tools: true, vision: true, reasoning: true })),
    ],
  },
  'openai-compatible': {
    type: 'openai-compatible',
    label: 'OpenAI-compatible (custom)',
    defaultBaseUrl: '',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    supportsModelListing: true,
    defaultModelId: '',
    knownModels: [],
  },
}

export const PROVIDER_TYPE_LIST: ProviderTypeMeta[] = Object.values(PROVIDER_TYPES)

/** Capabilities to assume for a model id we know nothing about. */
export const UNKNOWN_MODEL_CAPS: ModelCapabilities = caps({ tools: true })

export function findCatalogModel(type: ProviderType, modelId: string): ModelInfo | undefined {
  return PROVIDER_TYPES[type].knownModels.find((m) => m.id === modelId)
}

/** Auth methods a provider family supports (defaults to api-key only). */
export function providerAuthModes(type: ProviderType): AuthMode[] {
  return PROVIDER_TYPES[type].authModes ?? ['api_key']
}

/** Default model used when authenticating with ChatGPT (Codex backend). */
export const CHATGPT_OAUTH_DEFAULT_MODEL = 'gpt-5'

// ---------------------------------------------------------------------------
// Model catalog resolution (preset-aware)
//
// A provider's known-model list comes either from its family (PROVIDER_TYPES)
// or, for a preset-backed OpenAI-compatible provider, from the generated preset
// catalog. These resolvers are the single source of truth consumed by the base
// adapter (via AdapterContext.modelCatalog), the IPC listModels handler,
// chat-service (caps/context/vision), and the renderer. In Phase 0 they only
// delegate to PROVIDER_TYPES; the preset branch is added with the catalog.
// ---------------------------------------------------------------------------

export interface ProviderModelCatalog {
  supportsModelListing: boolean
  knownModels: ModelInfo[]
  defaultModelId: string
}

/** A minimal provider shape both ProviderConfig and create-inputs satisfy. */
export interface ProviderCatalogRef {
  type: ProviderType
  presetId?: string | null
}

/** Find a model by id within an explicit list (preset or family catalog). */
export function findInCatalog(models: ModelInfo[], modelId: string): ModelInfo | undefined {
  return models.find((m) => m.id === modelId)
}

/** The known-model catalog for a configured provider (family or preset). */
export function resolveModelCatalog(p: ProviderCatalogRef): ProviderModelCatalog {
  if (p.presetId) {
    const meta = presetMeta(p.presetId)
    if (meta) {
      return { supportsModelListing: false, knownModels: presetModels(p.presetId), defaultModelId: meta.defaultModelId }
    }
  }
  const meta = PROVIDER_TYPES[p.type]
  return {
    supportsModelListing: meta.supportsModelListing,
    knownModels: meta.knownModels,
    defaultModelId: meta.defaultModelId,
  }
}

/** Catalog info for one model of a configured provider (family or preset). */
export function resolveModelInfo(p: ProviderCatalogRef, modelId: string): ModelInfo | undefined {
  if (p.presetId) {
    const found = findInCatalog(presetModels(p.presetId), modelId)
    if (found) return found
  }
  return findCatalogModel(p.type, modelId)
}
