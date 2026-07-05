import { useState } from 'react'
import { errorMessage } from '@/api/uld'
import { useUiStore } from '@/stores/ui'

/**
 * Busy flag + runner for fire-and-forget store actions: `run(fn)` sets `busy`
 * while `fn` is in flight and toasts `errorMessage(e)` if it rejects. Use only
 * where the failure handling is exactly that toast (inline form errors keep
 * their own try/catch).
 */
export function useAsyncAction(): [boolean, (fn: () => Promise<void>) => Promise<void>] {
  const toast = useUiStore((s) => s.toast)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return [busy, run]
}
