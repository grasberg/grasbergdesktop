import { useEffect, useState, type ReactElement } from 'react'
import type { LocalServerInfo } from '@shared/ipc'
import type { ProviderConfig } from '@shared/types'
import { errorMessage } from '@/api/uld'
import { useProvidersStore } from '@/stores/providers'
import { useUiStore } from '@/stores/ui'
import './settings.css'

/**
 * Zero-key quickstart: probes localhost for running OpenAI-compatible model
 * servers (Ollama, LM Studio, Jan, llama.cpp) and offers each as a one-click
 * provider — no API key needed, nothing leaves the machine. Renders nothing
 * while probing; servers that already have a provider at the same base URL
 * are not offered again. `showFallback` adds a quiet ollama.com hint when
 * nothing is running (used by onboarding).
 */
export default function LocalServerCard({
  onCreated,
  showFallback = false,
}: {
  onCreated?: (provider: ProviderConfig) => void
  showFallback?: boolean
}): ReactElement | null {
  const providers = useProvidersStore((s) => s.providers)
  const detectLocal = useProvidersStore((s) => s.detectLocal)
  const createProvider = useProvidersStore((s) => s.create)
  const toast = useUiStore((s) => s.toast)
  const [servers, setServers] = useState<LocalServerInfo[] | null>(null)
  const [busyUrl, setBusyUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void detectLocal().then((found) => {
      if (!cancelled) setServers(found)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (servers === null) return null // probing — stay quiet

  const knownBaseUrls = new Set(providers.map((p) => p.baseUrl))
  const fresh = servers.filter((s) => !knownBaseUrls.has(s.baseUrl))

  if (fresh.length === 0) {
    if (!showFallback || servers.length > 0) return null
    return (
      <p className="field-hint">
        No API key? Run a free local model with{' '}
        <a href="https://ollama.com" target="_blank" rel="noreferrer">
          Ollama ↗
        </a>{' '}
        and it will be detected here.
      </p>
    )
  }

  const use = async (server: LocalServerInfo): Promise<void> => {
    setBusyUrl(server.baseUrl)
    try {
      const provider = await createProvider({
        type: 'openai-compatible',
        label: server.name,
        baseUrl: server.baseUrl,
        ...(server.models[0] ? { defaultModelId: server.models[0] } : {}),
        enabled: true,
      })
      onCreated?.(provider)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusyUrl(null)
    }
  }

  return (
    <div className="local-server-cards">
      {fresh.map((server) => (
        <div key={server.baseUrl} className="card local-server-card">
          <div className="local-server-info">
            <strong>{server.name} detected</strong>
            <span className="field-hint">
              {server.models.length > 0
                ? `${server.models.length} local model${server.models.length === 1 ? '' : 's'} — no API key needed.`
                : 'Running locally — no API key needed.'}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busyUrl !== null}
            onClick={() => void use(server)}
          >
            {busyUrl === server.baseUrl ? 'Adding…' : `Use ${server.name}`}
          </button>
        </div>
      ))}
    </div>
  )
}
