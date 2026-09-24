import { createUldApi } from '@shared/api-client'
import { CHANNELS, type ChannelName, type ConversationDraft, type IpcResult } from '@shared/ipc'
import type { RemoteCapabilities } from '@shared/remote-protocol'
import { selectRemoteFiles } from './RemoteFilesDialog'

async function download(host: RemoteHost, transfer: { id: string; name: string; size: number }): Promise<boolean> {
  if (!Number.isSafeInteger(transfer.size) || transfer.size < 0 || transfer.size > host.capabilities().maxUploadBytes) throw new Error('The download is too large for this device.')
  if (host.native) {
    const result = await host.request<{ canceled: boolean }>('client:saveDownload', [transfer])
    if (!result.ok) throw new Error(result.error.message)
    return !result.data.canceled
  }
  const parts: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  try {
    while (offset < transfer.size) {
      const result = await host.request<{ data: string; next: number; done: boolean }>(CHANNELS.remoteDownloadRead, [{ id: transfer.id, offset }])
      if (!result.ok) throw new Error(result.error.message)
      const bytes = Uint8Array.from(atob(result.data.data), c => c.charCodeAt(0))
      if (result.data.next !== offset + bytes.length || !bytes.length || result.data.next > transfer.size) throw new Error('The download was interrupted. Please export again.')
      parts.push(bytes); offset = result.data.next
    }
    const url = URL.createObjectURL(new Blob(parts))
    const link = document.createElement('a'); link.href = url; link.download = transfer.name; link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
    return true
  } finally { void host.request(CHANNELS.remoteTransferCancel, [transfer.id]) }
}

export interface RemoteHost {
  request<T>(channel: string, args?: unknown[]): Promise<IpcResult<T>>
  subscribe(callback: (channel: string, payload: unknown) => void): () => void
  capabilities(): RemoteCapabilities
  draftKey: string
  native?: boolean
}

/** The same method mapping as preload. Transport changes; app behavior does not. */
export function remoteApi(host: RemoteHost) {
  return createUldApi({
    async invoke<T>(channel: ChannelName, ...args: unknown[]): Promise<IpcResult<T>> {
      try {
        // JSON turns undefined array entries into null; optional trailing IPC
        // arguments must remain absent for the desktop's zod schemas.
        while (args.length && args[args.length - 1] === undefined) args.pop()
        if (channel === CHANNELS.spacesList) return { ok: true, data: [] as T }
        if (channel === CHANNELS.convDraftGet || channel === CHANNELS.convDraftSave) {
          if (host.native) return host.request<T>(channel === CHANNELS.convDraftGet ? 'client:draftGet' : 'client:draftSave', args)
          const request = args[0] as string | { conversationId: string; draft: ConversationDraft }
          const id = typeof request === 'string' ? request : request.conversationId
          const key = `${host.draftKey}.${id}`
          if (channel === CHANNELS.convDraftGet) return { ok: true, data: JSON.parse(localStorage.getItem(key) ?? 'null') as T }
          localStorage.setItem(key, JSON.stringify((request as { draft: ConversationDraft }).draft))
          return { ok: true, data: undefined as T }
        }
        if (!host.capabilities().requestChannels.includes(channel)) return { ok: false, error: { code: 'not_supported', message: 'This action needs the desktop, or a newer desktop version. Your changes have been kept.', retryable: false } }
        const fileDialog = [CHANNELS.appPickFiles, CHANNELS.appPickFolder, CHANNELS.backupPreview, CHANNELS.agentPackImport, CHANNELS.kbImportFiles, CHANNELS.voicePickBinary].includes(channel as never)
        if (fileDialog && !(channel === CHANNELS.voicePickBinary && args[0] === true)) {
          const selection = await selectRemoteFiles(host, channel === CHANNELS.appPickFolder ? 'folder' : channel === CHANNELS.voicePickBinary ? 'binary' : 'files', channel === CHANNELS.appPickFiles || channel === CHANNELS.kbImportFiles)
          return host.request<T>(CHANNELS.remoteFileInvoke, [{ channel, args, ...(selection ?? { paths: [] }) }])
        }
        if (channel === CHANNELS.voiceSttChunk) {
          const request = args[0] as { sessionId: string; chunk: ArrayBuffer | Uint8Array }
          const bytes = request.chunk instanceof ArrayBuffer ? new Uint8Array(request.chunk) : request.chunk
          const chunkBase64 = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
          args = [{ sessionId: request.sessionId, chunkBase64 }]
        }
        const result = await host.request<T>(channel, args)
        if (result.ok) {
          const transfer = (result.data as { remoteDownload?: { id: string; name: string; size: number } } | null)?.remoteDownload
          if (transfer && !await download(host, transfer)) return { ok: true, data: { canceled: true } as T }
        }
        return result
      } catch (e) {
        return { ok: false, error: { code: 'network', message: e instanceof Error ? e.message : 'Connection interrupted. Please retry.', retryable: true } }
      }
    },
    subscribe: (channel, callback) => host.subscribe((incoming, payload) => { if (incoming === channel) callback(payload as never) }),
  })
}
