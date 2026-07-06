/**
 * Per-mode model defaults: which provider/model a new conversation in a given
 * mode should start with. Pure (no runtime deps) so it lives in `shared` and is
 * usable from both main (conversation creation) and tests.
 */

import type { AppSettings, ConversationMode, ModeModelDefault } from './types'

/**
 * The per-mode default provider/model for a new conversation in `mode`, or null
 * to fall back to the global default. Returns a value only when the feature is
 * enabled AND the mode has a provider chosen — a model without a provider is
 * meaningless, so such a mode is treated as "use the global default".
 */
export function modeModelDefault(
  settings: AppSettings,
  mode: ConversationMode
): ModeModelDefault | null {
  if (!settings.perModeModelsEnabled) return null
  const entry = settings.modeModels?.[mode]
  if (!entry || !entry.providerId) return null
  return { providerId: entry.providerId, modelId: entry.modelId }
}
