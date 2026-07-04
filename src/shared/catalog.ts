/**
 * Static catalog of built-in provider families and their known models.
 * Used for: Settings UI (add provider), capability display in the model
 * selector, and fallback when a provider has no /models endpoint.
 *
 * Model lists here are a convenience, not a cage — users can always type a
 * custom model id.
 */

import type { ModelCapabilities, ModelInfo, ProviderType, ProviderTypeMeta } from './types'

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
    knownModels: [
      model('MiniMax-M2', 'MiniMax M2', 200000, caps({ tools: true })),
      model('MiniMax-M1', 'MiniMax M1', 1000000, caps({ tools: true, reasoning: true })),
      model('MiniMax-Text-01', 'MiniMax Text-01', 1000000, caps({ tools: true })),
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
