import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import { modeModelDefault } from '@shared/mode-models'

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, modeModels: { ...DEFAULT_SETTINGS.modeModels }, ...patch }
}

describe('modeModelDefault', () => {
  it('returns null when the feature is disabled', () => {
    const s = settings({
      perModeModelsEnabled: false,
      modeModels: { ...DEFAULT_SETTINGS.modeModels, code: { providerId: 'p1', modelId: 'm1' } },
    })
    expect(modeModelDefault(s, 'code')).toBeNull()
  })

  it('returns the mode provider/model when enabled and set', () => {
    const s = settings({
      perModeModelsEnabled: true,
      modeModels: { ...DEFAULT_SETTINGS.modeModels, code: { providerId: 'p1', modelId: 'm1' } },
    })
    expect(modeModelDefault(s, 'code')).toEqual({ providerId: 'p1', modelId: 'm1' })
  })

  it('returns null for a mode left blank (no provider) even when enabled', () => {
    const s = settings({
      perModeModelsEnabled: true,
      modeModels: { ...DEFAULT_SETTINGS.modeModels, code: { providerId: 'p1', modelId: 'm1' } },
    })
    // chat has no provider set -> falls back to global default.
    expect(modeModelDefault(s, 'chat')).toBeNull()
  })

  it('allows a provider with no explicit model (uses provider default later)', () => {
    const s = settings({
      perModeModelsEnabled: true,
      modeModels: { ...DEFAULT_SETTINGS.modeModels, write: { providerId: 'p2', modelId: null } },
    })
    expect(modeModelDefault(s, 'write')).toEqual({ providerId: 'p2', modelId: null })
  })
})
