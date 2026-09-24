import type { AgentProfile, AppSettings, Conversation, ProviderConfig } from '@shared/types'
import { PROVIDER_TYPES } from '@shared/catalog'
import { isLoopbackBaseUrl } from '@shared/schemas'

/** Static model pins in the same order as ChatService.resolveTarget. */
export function conversationModel(
  conversation: Pick<Conversation, 'providerId' | 'modelId'> | null,
  settings: Pick<AppSettings, 'defaultProviderId'> | null,
  providers: ProviderConfig[],
  agent?: Pick<AgentProfile, 'providerId' | 'modelId'> | null
): { provider: ProviderConfig | null; modelId: string | null } {
  const providerId = conversation?.providerId ?? agent?.providerId ?? settings?.defaultProviderId
  const provider = providers.find((p) => p.id === providerId) ?? null
  const modelId = [
    conversation?.modelId,
    agent?.modelId,
    provider?.defaultModelId,
    provider ? PROVIDER_TYPES[provider.type].defaultModelId : null,
  ].find((id) => id?.trim())?.trim() ?? null
  return { provider, modelId }
}

/**
 * Whether a provider can actually back a generation. OAuth providers ("Sign in
 * with ChatGPT") authenticate with a stored token rather than an API key, so
 * they are usable when connected even though `hasKey` is false; api-key
 * providers need a stored key — EXCEPT keyless OpenAI-compatible providers
 * pointing at a loopback server (Ollama, LM Studio, Jan), which accept any
 * bearer. Keep the loopback carve-out in sync with the key resolution in
 * src/main/services/chat-service.ts. Single source of truth so the composer,
 * model selector and every settings picker agree on what counts as usable.
 */
export function providerUsable(p: ProviderConfig): boolean {
  if (!p.enabled) return false
  if (p.authMode !== 'api_key') return !!p.oauthConnected
  if (p.hasKey) return true
  return p.type === 'openai-compatible' && isLoopbackBaseUrl(p.baseUrl)
}
