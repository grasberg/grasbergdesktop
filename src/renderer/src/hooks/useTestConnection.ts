import { useState } from 'react'
import type { TestConnectionResult } from '@shared/types'
import { errorMessage } from '@/api/uld'
import { useProvidersStore } from '@/stores/providers'

/**
 * Runs a provider connection test and tracks its state. Failures become an
 * `{ ok: false }` result (never a throw), rendered by the shared TestResult.
 */
export function useTestConnection(providerId: string): {
  testing: boolean
  result: TestConnectionResult | null
  run: () => Promise<void>
} {
  const test = useProvidersStore((s) => s.test)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<TestConnectionResult | null>(null)

  const run = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    try {
      setResult(await test(providerId))
    } catch (e) {
      setResult({ ok: false, message: errorMessage(e) })
    } finally {
      setTesting(false)
    }
  }

  return { testing, result, run }
}
