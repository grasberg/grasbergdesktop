/**
 * Adapter registry. Adapters are stateless (all per-call state travels in
 * AdapterContext), so one memoized instance per provider type suffices.
 *
 * Auth mode also selects the wire protocol: OpenAI with `chatgpt_oauth` uses
 * the ChatGPT-backend Responses adapter, not the API-key chat/completions one.
 */

import type { AuthMode, ProviderType } from '@shared/types'
import type { ProviderAdapter } from './adapter'
import { AnthropicAdapter } from './anthropic'
import { BedrockAdapter } from './bedrock'
import { DeepSeekAdapter } from './deepseek'
import { GoogleAdapter } from './google'
import { MiniMaxAdapter } from './minimax'
import { OpenAIAdapter } from './openai'
import { OpenAICodexAdapter } from './openai-codex'
import { OpenAICompatibleAdapter } from './openai-compatible'
import { ZaiCodingAdapter } from './zai-coding'
import { ZhipuAdapter } from './zhipu'

const instances = new Map<ProviderType, ProviderAdapter>()
let codexInstance: ProviderAdapter | undefined

function createAdapter(type: ProviderType): ProviderAdapter {
  switch (type) {
    case 'deepseek':
      return new DeepSeekAdapter()
    case 'zhipu':
      return new ZhipuAdapter()
    case 'minimax':
      return new MiniMaxAdapter()
    case 'openai':
      return new OpenAIAdapter()
    case 'zai-coding':
      return new ZaiCodingAdapter()
    case 'anthropic':
      return new AnthropicAdapter()
    case 'google':
      return new GoogleAdapter()
    case 'bedrock':
      return new BedrockAdapter()
    case 'openai-compatible':
      return new OpenAICompatibleAdapter()
  }
}

export function getAdapter(type: ProviderType): ProviderAdapter {
  let adapter = instances.get(type)
  if (!adapter) {
    adapter = createAdapter(type)
    instances.set(type, adapter)
  }
  return adapter
}

/**
 * Select the adapter for a configured provider, honoring its auth mode.
 * `chatgpt_oauth` on OpenAI routes to the Responses/Codex adapter.
 */
export function resolveAdapter(type: ProviderType, authMode: AuthMode): ProviderAdapter {
  if (type === 'openai' && authMode === 'chatgpt_oauth') {
    if (!codexInstance) codexInstance = new OpenAICodexAdapter()
    return codexInstance
  }
  return getAdapter(type)
}
