import { describe, expect, it } from 'vitest'
import {
  isKnownPreset,
  presetMeta,
  presetMetaList,
  presetModels,
  presetPricing,
} from '../../src/shared/presets'

describe('preset facade (generated catalog)', () => {
  it('exposes a large preset catalog', () => {
    expect(presetMetaList().length).toBeGreaterThan(100)
  })

  it('knows real presets and rejects unknown ids', () => {
    expect(isKnownPreset('openrouter')).toBe(true)
    expect(isKnownPreset('groq')).toBe(true)
    expect(isKnownPreset('definitely-not-a-provider')).toBe(false)
  })

  it('exposes a base URL + default model per preset', () => {
    const groq = presetMeta('groq')
    expect(groq?.baseUrl).toContain('groq.com')
    expect(groq?.defaultModelId.length).toBeGreaterThan(0)
  })

  it('decodes models with capabilities and memoizes', () => {
    const models = presetModels('groq')
    expect(models.length).toBeGreaterThan(0)
    expect(models[0]).toHaveProperty('capabilities.streaming', true)
    // Memoized: same array reference on a second call.
    expect(presetModels('groq')).toBe(models)
  })

  it('resolves pricing for a known model, undefined otherwise', () => {
    const models = presetModels('groq')
    const p = presetPricing('groq', models[0].id)
    if (p) expect(p.inputPerMTok).toBeGreaterThanOrEqual(0)
    expect(presetPricing('groq', 'no-such-model')).toBeUndefined()
    expect(presetPricing('no-such-preset', 'x')).toBeUndefined()
  })
})
