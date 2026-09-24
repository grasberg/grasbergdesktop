import { expect, it } from 'vitest'
import type { ProviderConfig } from '../../src/shared/types'
import { conversationModel } from '../../src/renderer/src/lib/providers'

const providers = [
  { id: 'global', type: 'openai-compatible', defaultModelId: 'global-model' },
  { id: 'bot', type: 'openai-compatible', defaultModelId: 'provider-model' },
] as ProviderConfig[]
const settings = { defaultProviderId: 'global' }
const unpinned = { providerId: null, modelId: null }

it('displays the bot provider and model instead of unrelated global defaults', () => {
  expect(conversationModel(unpinned, settings, providers, { providerId: 'bot', modelId: 'advisor' }))
    .toEqual({ provider: providers[1], modelId: 'advisor' })
})

it('lets explicit conversation pins override the bot independently', () => {
  expect(conversationModel({ providerId: 'global', modelId: null }, settings, providers,
    { providerId: 'bot', modelId: 'advisor' }))
    .toEqual({ provider: providers[0], modelId: 'advisor' })
  expect(conversationModel({ providerId: null, modelId: 'override' }, settings, providers,
    { providerId: 'bot', modelId: 'advisor' }))
    .toEqual({ provider: providers[1], modelId: 'override' })
})

it('skips empty model pins and falls back to the selected provider', () => {
  expect(conversationModel({ providerId: 'bot', modelId: ' ' }, settings, providers,
    { providerId: null, modelId: '' }))
    .toEqual({ provider: providers[1], modelId: 'provider-model' })
})

it('does not replace a missing pinned provider with the global provider', () => {
  expect(conversationModel(unpinned, settings, providers,
    { providerId: 'removed', modelId: 'advisor' }).provider).toBeNull()
})
