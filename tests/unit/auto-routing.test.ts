import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from '@shared/types'
import { presetPricing } from '@shared/presets'
import { pickAutoRouteProvider } from '../../src/main/services/chat-service'

function provider(patch: Partial<ProviderConfig> & Pick<ProviderConfig, 'id' | 'type' | 'defaultModelId'>): ProviderConfig {
  return {
    label: patch.id,
    baseUrl: 'https://example.com/v1',
    enabled: true,
    authMode: 'api_key',
    presetId: null,
    hasKey: true,
    keyPreview: 'key…test',
    oauthConnected: false,
    oauthAccountLabel: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

describe('pickAutoRouteProvider', () => {
  const providers = [
    provider({ id: 'expensive', type: 'openai', defaultModelId: 'gpt-5' }),
    provider({ id: 'cheap', type: 'openai', defaultModelId: 'gpt-4o-mini' }),
    provider({ id: 'local', type: 'openai-compatible', defaultModelId: 'local', baseUrl: 'http://localhost:11434/v1' }),
  ]

  it('routes by cost/quality and honors local-only', () => {
    expect(pickAutoRouteProvider(providers, { autoRoutingPolicy: 'lowest_cost', autoRoutingMaxCostUsd: null })).toBe('local')
    expect(pickAutoRouteProvider(providers, { autoRoutingPolicy: 'highest_quality', autoRoutingMaxCostUsd: null })).toBe('expensive')
    expect(pickAutoRouteProvider(providers, { autoRoutingPolicy: 'local_only', autoRoutingMaxCostUsd: null })).toBe('local')
  })

  it('filters unknown prices and expensive models under a task budget', () => {
    expect(pickAutoRouteProvider(providers.slice(0, 2), {
      autoRoutingPolicy: 'highest_quality',
      autoRoutingMaxCostUsd: 0.001,
    })).toBeNull()
  })

  // A preset-backed provider is type 'openai-compatible' (empty pricing table);
  // its price lives in the preset catalog and must still drive routing.
  it('prices preset-backed providers from the preset catalog', () => {
    const PRESET_ID = '302ai'
    const PRESET_MODEL = 'claude-3-5-haiku-20241022' // 0.8 in / 4 out per MTok
    expect(presetPricing(PRESET_ID, PRESET_MODEL)).toBeDefined()

    const preset = provider({
      id: 'preset',
      type: 'openai-compatible',
      defaultModelId: PRESET_MODEL,
      presetId: PRESET_ID,
    })
    const withPreset = [providers[0], preset]

    expect(
      pickAutoRouteProvider(withPreset, {
        autoRoutingPolicy: 'lowest_cost',
        autoRoutingMaxCostUsd: null,
      })
    ).toBe('preset')
    expect(
      pickAutoRouteProvider(withPreset, {
        autoRoutingPolicy: 'highest_quality',
        autoRoutingMaxCostUsd: null,
      })
    ).toBe('expensive')
    // Priced, so a budget it fits no longer excludes it as "unknown cost".
    expect(
      pickAutoRouteProvider(withPreset, {
        autoRoutingPolicy: 'lowest_cost',
        autoRoutingMaxCostUsd: 0.02,
      })
    ).toBe('preset')
  })
})
