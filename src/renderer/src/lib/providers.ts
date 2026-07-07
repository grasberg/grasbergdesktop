import type { ProviderConfig } from '@shared/types'

/**
 * Whether a provider can actually back a generation. OAuth providers ("Sign in
 * with ChatGPT") authenticate with a stored token rather than an API key, so
 * they are usable when connected even though `hasKey` is false; api-key
 * providers need a stored key. Single source of truth so the composer, model
 * selector and every settings picker agree on what counts as usable.
 */
export function providerUsable(p: ProviderConfig): boolean {
  if (!p.enabled) return false
  return p.authMode === 'api_key' ? p.hasKey : !!p.oauthConnected
}
