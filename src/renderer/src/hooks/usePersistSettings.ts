import type { AppSettings } from '@shared/types'
import { errorMessage } from '@/api/uld'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

/**
 * `persist(patch)` saves a settings patch and toasts `errorMessage(e)` if the
 * update rejects. The returned promise never rejects, so callers can either
 * `void` it (fire-and-forget) or await it for ordering.
 */
export function usePersistSettings(): (patch: Partial<AppSettings>) => Promise<void> {
  const update = useSettingsStore((s) => s.update)
  const toast = useUiStore((s) => s.toast)

  return async (patch: Partial<AppSettings>): Promise<void> => {
    try {
      await update(patch)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
}
