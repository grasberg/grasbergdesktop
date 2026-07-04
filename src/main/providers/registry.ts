/**
 * Adapter registry. Adapters are stateless (all per-call state travels in
 * AdapterContext), so one memoized instance per provider type suffices.
 */

import type { ProviderType } from '@shared/types'
import type { ProviderAdapter } from './adapter'
import { DeepSeekAdapter } from './deepseek'
import { MiniMaxAdapter } from './minimax'
import { OpenAICompatibleAdapter } from './openai-compatible'
import { ZhipuAdapter } from './zhipu'

const instances = new Map<ProviderType, ProviderAdapter>()

function createAdapter(type: ProviderType): ProviderAdapter {
  switch (type) {
    case 'deepseek':
      return new DeepSeekAdapter()
    case 'zhipu':
      return new ZhipuAdapter()
    case 'minimax':
      return new MiniMaxAdapter()
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
