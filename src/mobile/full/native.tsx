import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import type { IpcResult } from '@shared/ipc'
import type { RemoteCapabilities } from '@shared/remote-protocol'
import FullApp from './FullApp'
import type { RemoteHost } from './remote-api'
import { navigateGuarded } from '@/hooks/useUnsavedChanges'

/** Packaged native UI only. Pairing keys and bearer tokens remain in Dart. */
export function startNative(): void {
  const bridge = (window as unknown as { GrasbergNative?: { postMessage(message: string): void } }).GrasbergNative
  const nonce = new URLSearchParams(location.hash.slice(1)).get('bridge')
  if (!bridge || !nonce || window !== window.top) throw new Error('The native connection is unavailable.')
  history.replaceState(null, '', location.pathname + location.search)
  const pending = new Map<string, { resolve: (result: IpcResult<unknown>) => void; timer: number }>()
  const listeners = new Set<(channel: string, payload: unknown) => void>()
  const disconnected = (): IpcResult<never> => ({ ok: false, error: { code: 'network', message: 'Connection interrupted. Your edits have been kept. Retry when connected.', retryable: true } })
  const host: RemoteHost = {
    native: true, draftKey: 'native',
    capabilities: () => capabilities,
    request<T>(channel: string, args: unknown[] = []): Promise<IpcResult<T>> {
      if (pending.size >= 60) return Promise.resolve({ ok: false, error: { code: 'rate_limit', message: 'Several actions are still finishing. Please wait and retry.', retryable: true } })
      return new Promise(resolve => {
        const id = crypto.randomUUID()
        const timer = window.setTimeout(() => { pending.delete(id); resolve(disconnected()) }, 180_000)
        pending.set(id, { resolve: result => resolve(result as IpcResult<T>), timer })
        bridge.postMessage(JSON.stringify({ nonce, id, channel, args }))
      })
    },
    subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback) } },
  }
  let capabilities: RemoteCapabilities = { revision: 2, access: 'limited', requestChannels: [], pushChannels: [], maxUploadBytes: 64 * 1024 * 1024, chunkBytes: 128 * 1024 }
  // Dart calls this top-frame receiver. The nonce is held in this closure.
  Object.defineProperty(window, '__grasbergReceive', { value: (message: { nonce: string; id?: string; result?: IpcResult<unknown>; channel?: string; payload?: unknown }) => {
    if (message.nonce !== nonce) return
    if (message.id && message.result) {
      const request = pending.get(message.id)
      if (request) { window.clearTimeout(request.timer); pending.delete(message.id); request.resolve(message.result) }
    } else if (message.channel) {
      if (message.channel === 'push:remoteCapabilities') capabilities = message.payload as RemoteCapabilities
      for (const listener of listeners) listener(message.channel, message.payload)
    }
  } })
  function NativeApp() {
    const [ready, setReady] = useState(false)
    const [online, setOnline] = useState(false)
    const [error, setError] = useState('')
    useEffect(() => {
      const back = () => navigateGuarded(() => { void host.request('client:device') })
      window.addEventListener('grasberg-native-back', back)
      const unsubscribe = host.subscribe((channel, payload) => { if (channel === 'client:connection') setOnline(payload === true) })
      void host.request<{ capabilities: RemoteCapabilities; online: boolean }>('client:ready').then(result => {
        if (!result.ok) { setError(result.error.message); return }
        capabilities = result.data.capabilities; setOnline(result.data.online); setReady(true)
      })
      return () => { unsubscribe(); window.removeEventListener('grasberg-native-back', back) }
    }, [])
    if (!ready) return <div role="status">{error || 'Connecting to your desktop…'}</div>
    return <FullApp host={host} online={online} onLeave={() => { void host.request('client:device') }} />
  }
  createRoot(document.getElementById('root')!).render(<NativeApp />)
}
