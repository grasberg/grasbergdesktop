import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/types'
import { errorMessage } from '@/api/uld'
import { useUiStore } from '@/stores/ui'

const PLATFORM_LABELS: Record<AppInfo['platform'], string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
}

export default function AboutTab() {
  const toast = useUiStore((s) => s.toast)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.uld.app
      .getInfo()
      .then((r) => {
        if (cancelled) return
        if (r.ok) setInfo(r.data)
        else setError(r.error.message)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function copyDataPath() {
    if (!info) return
    try {
      await navigator.clipboard.writeText(info.userDataPath)
      toast('Data path copied', 'success')
    } catch {
      toast('Could not copy to clipboard', 'error')
    }
  }

  return (
    <section aria-label="About">
      <header className="tab-header">
        <div>
          <h3>About</h3>
        </div>
      </header>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {!info && !error ? <p className="field-hint">Loading…</p> : null}

      {info ? (
        <>
          <dl className="kv-table">
            <div className="kv-row">
              <dt>App version</dt>
              <dd className="mono">{info.appVersion}</dd>
            </div>
            <div className="kv-row">
              <dt>Electron</dt>
              <dd className="mono">{info.electronVersion}</dd>
            </div>
            <div className="kv-row">
              <dt>Platform</dt>
              <dd>{PLATFORM_LABELS[info.platform]}</dd>
            </div>
            <div className="kv-row">
              <dt>Data location</dt>
              <dd className="kv-path">
                <span className="mono" title={info.userDataPath}>
                  {info.userDataPath}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void copyDataPath()}
                  aria-label="Copy data path"
                >
                  Copy
                </button>
              </dd>
            </div>
          </dl>

          {!info.encryptionAvailable ? (
            <div className="callout callout-warning" role="alert">
              <strong>OS keychain unavailable.</strong> API keys fall back to obfuscated (not
              OS-encrypted) storage on this system. Anyone with access to your user account could
              recover them.
            </div>
          ) : null}
        </>
      ) : null}

      <p className="field-hint about-licenses">
        Grasberg Desktop is released under the MIT license. It is built with open-source
        software, including Electron, React, zustand and node-sqlite3-wasm — each distributed under
        its own permissive license.
      </p>
    </section>
  )
}
