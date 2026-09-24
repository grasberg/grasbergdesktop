import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { CHANNELS } from '@shared/ipc'
import { useModalBehavior } from '@/hooks/useModalBehavior'
import { unwrap } from '@/api/uld'
import { formatBytes } from '@/lib/format'
import type { RemoteHost } from './remote-api'

type Selection = { uploadIds: string[] } | { paths: string[] }
interface Request { host: RemoteHost; kind: 'files' | 'folder' | 'binary'; multiple: boolean; resolve: (value: Selection | null) => void }
const dialog = create<{ request: Request | null }>(() => ({ request: null }))
export function selectRemoteFiles(host: RemoteHost, kind: Request['kind'], multiple = false): Promise<Selection | null> {
  if (dialog.getState().request) throw new Error('Finish the current file selection first.')
  return new Promise(resolve => dialog.setState({ request: { host, kind, multiple, resolve } }))
}
const asBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
interface Folder { path: string; parent: string | null; entries: Array<{ name: string; path: string; directory: boolean }>; truncated: boolean }

function SelectionForm({ request, close }: { request: Request; close: (value: Selection | null) => void }) {
  const [files, setFiles] = useState<File[]>([])
  const [folder, setFolder] = useState<Folder | null>(null)
  const [path, setPath] = useState('')
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [progress, setProgress] = useState('')
  const [busy, setBusy] = useState(false)
  const [abort] = useState(() => new AbortController())
  const cancel = (): void => { abort.abort(); close(null) }
  const ref = useModalBehavior(true, cancel)
  const browse = async (path?: string) => {
    setBusy(true); setError('')
    try {
      const next = await unwrap(request.host.request<Folder>(CHANNELS.remoteBrowse, [{ path, includeFiles: request.kind === 'binary' }]))
      setFolder(next); setPath(next.path); setSelected('')
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not list the desktop folder.') }
    finally { setBusy(false) }
  }
  useEffect(() => { if (request.kind !== 'files') void browse() }, [])
  useEffect(() => () => abort.abort(), [abort])
  const upload = async () => {
    if (busy) return
    setBusy(true); setError('')
    const ids: string[] = []
    try {
      for (const file of files) {
        const cap = request.host.capabilities()
        if (file.size > cap.maxUploadBytes) throw new Error(`${file.name} is too large. Maximum: ${formatBytes(cap.maxUploadBytes)}.`)
        const bytes = new Uint8Array(await file.arrayBuffer())
        const transfer = await unwrap(request.host.request<{ id: string }>(CHANNELS.remoteUploadBegin, [{ name: file.name, size: file.size }]))
        ids.push(transfer.id)
        for (let offset = 0; offset < bytes.length; offset += cap.chunkBytes) {
          if (abort.signal.aborted) throw new Error('Transfer cancelled.')
          setProgress(`${file.name} · ${Math.round(offset / bytes.length * 100)}%`)
          await unwrap(request.host.request(CHANNELS.remoteUploadChunk, [{ id: transfer.id, offset, data: asBase64(bytes.subarray(offset, offset + cap.chunkBytes)) }]))
        }
        if (abort.signal.aborted) throw new Error('Transfer cancelled.')
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
        await unwrap(request.host.request(CHANNELS.remoteUploadFinish, [{ id: transfer.id, sha256: Array.from(hash, b => b.toString(16).padStart(2, '0')).join('') }]))
      }
      close({ uploadIds: ids })
    } catch (e) {
      for (const id of ids) void request.host.request(CHANNELS.remoteTransferCancel, [id])
      if (abort.signal.aborted) close(null)
      else setError(e instanceof Error ? e.message : 'Transfer failed. Choose the files again to retry.')
    } finally { setBusy(false); setProgress('') }
  }
  return <div className="modal-backdrop" style={{ zIndex: 10050 }}><div ref={ref} className="modal remote-file-dialog" role="dialog" aria-modal="true" aria-labelledby="remote-files-title">
    <h2 id="remote-files-title">{request.kind === 'files' ? 'Choose files from this device' : request.kind === 'folder' ? 'Choose a folder on the desktop' : 'Choose a speech engine on the desktop'}</h2>
    {request.kind === 'files' ? <><p>Files travel through the encrypted tunnel to your desktop. Each file can be up to {formatBytes(request.host.capabilities().maxUploadBytes)}.</p><input type="file" aria-label="Files to upload" multiple={request.multiple} disabled={busy} onChange={e => { setFiles(Array.from(e.target.files ?? []).slice(0, 20)); setError('') }} /><ul>{files.map((f, i) => <li key={i}>{f.name} · {formatBytes(f.size)}</li>)}</ul></> : <><form onSubmit={e => { e.preventDefault(); void browse(path) }} className="remote-folder-path"><input className="input" aria-label="Desktop folder path" value={path} onChange={e => setPath(e.target.value)} /><button className="btn" disabled={busy}>Go</button></form><button className="btn" disabled={busy || !folder?.parent} onClick={() => void browse(folder?.parent ?? undefined)}>Parent folder</button><div className="remote-folder-list">{folder?.entries.map(entry => <button type="button" className="btn btn-ghost" disabled={busy} key={entry.path} aria-pressed={selected === entry.path} onClick={() => { if (entry.directory) void browse(entry.path); else setSelected(entry.path) }}>{entry.directory ? '📁' : '📄'} {entry.name}</button>)}</div>{folder?.truncated && <p>Showing the first 500 items. Enter a more specific folder path above.</p>}{selected && <p>{selected}</p>}</>}
    {error && <p role="alert" className="form-error">{error}</p>}{progress && <p role="status">Uploading {progress}</p>}
    <div className="form-actions"><button className="btn" onClick={cancel}>{busy ? 'Cancel transfer' : 'Cancel'}</button><button className="btn btn-primary" disabled={busy || (request.kind === 'files' ? !files.length : request.kind === 'binary' ? !selected : !folder)} onClick={() => { if (request.kind === 'files') void upload(); else close({ paths: [request.kind === 'folder' ? folder!.path : selected] }) }}>{request.kind === 'files' ? 'Upload selected files' : 'Use selected path'}</button></div>
  </div></div>
}

export default function RemoteFilesDialog() {
  const request = dialog(s => s.request)
  return request ? <SelectionForm request={request} close={value => { dialog.setState({ request: null }); request.resolve(value) }} /> : null
}
