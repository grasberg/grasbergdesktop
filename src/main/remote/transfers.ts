import { randomUUID, createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const TRANSFER_CHUNK_BYTES = 128 * 1024
export const TRANSFER_MAX_BYTES = 64 * 1024 * 1024
const TOTAL_MAX_BYTES = 128 * 1024 * 1024
const TTL_MS = 10 * 60_000
export interface RemoteDownload { id: string; name: string; size: number }
interface Transfer extends RemoteDownload {
  owner: string; expires: number; parts: Buffer[]; received: number; ready: boolean; download: boolean; claimed?: boolean
}

/** Device-bound opaque transfers; paths and executable code never ride file frames. */
export class RemoteTransfers {
  private transfers = new Map<string, Transfer>()
  constructor(private now = Date.now) {}
  private prune() { for (const [id, transfer] of this.transfers) if (transfer.expires <= this.now()) this.transfers.delete(id) }
  private get(owner: string, id: string) {
    this.prune()
    const transfer = this.transfers.get(id)
    if (!transfer || transfer.owner !== owner) throw new Error('File transfer expired. Select the file again.')
    return transfer
  }
  begin(owner: string, name: string, size: number): RemoteDownload {
    this.prune()
    if (!owner || !name || name !== basename(name) || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name.length > 200 || ['.', '..'].includes(name)) throw new Error('Invalid file name.')
    if (!Number.isSafeInteger(size) || size < 0 || size > TRANSFER_MAX_BYTES) throw new Error('Each file must be 64 MB or smaller.')
    if (this.transfers.size >= 32 || [...this.transfers.values()].reduce((sum, t) => sum + t.size, size) > TOTAL_MAX_BYTES) throw new Error('Too many file transfers. Finish or cancel the current transfer first.')
    const id = randomUUID()
    this.transfers.set(id, { id, name, size, owner, expires: this.now() + TTL_MS, parts: [], received: 0, ready: false, download: false })
    return { id, name, size }
  }
  chunk(owner: string, id: string, offset: number, data: string): { received: number } {
    const t = this.get(owner, id)
    if (t.download || t.ready || data.length > Math.ceil(TRANSFER_CHUNK_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('Invalid file chunk.')
    const bytes = Buffer.from(data, 'base64')
    if (!bytes.length || bytes.length > TRANSFER_CHUNK_BYTES || !Number.isSafeInteger(offset) || offset < 0 || offset + bytes.length > t.size) throw new Error('Invalid file chunk size.')
    if (offset < t.received) {
      let position = 0
      const previous = t.parts.find(part => { const matches = position === offset; position += part.length; return matches })
      if (!previous?.equals(bytes)) throw new Error('This chunk conflicts with previously received data.')
      return { received: t.received }
    }
    if (offset !== t.received) throw new Error('File chunks arrived out of order. Retry from the last received offset.')
    t.parts.push(bytes); t.received += bytes.length; t.expires = this.now() + TTL_MS
    return { received: t.received }
  }
  finish(owner: string, id: string, sha256: string): RemoteDownload {
    const t = this.get(owner, id)
    if (t.download || t.received !== t.size) throw new Error('The upload is incomplete.')
    const hash = createHash('sha256')
    for (const part of t.parts) hash.update(part)
    if (hash.digest('hex') !== sha256) throw new Error('The file checksum did not match. Select the file again.')
    t.ready = true; t.expires = this.now() + TTL_MS
    return { id: t.id, name: t.name, size: t.size }
  }
  cancel(owner: string, id: string) { this.get(owner, id); this.transfers.delete(id) }
  offer(owner: string, name: string, bytes: Buffer): RemoteDownload {
    const metadata = this.begin(owner, name, bytes.length)
    const t = this.get(owner, metadata.id)
    t.parts = [bytes]; t.received = bytes.length; t.ready = true; t.download = true
    return metadata
  }
  read(owner: string, id: string, offset: number): { data: string; next: number; done: boolean } {
    const t = this.get(owner, id)
    if (!t.download || !Number.isSafeInteger(offset) || offset < 0 || offset > t.size) throw new Error('Invalid download offset.')
    const end = Math.min(offset + TRANSFER_CHUNK_BYTES, t.size)
    t.expires = this.now() + TTL_MS
    return { data: t.parts[0].subarray(offset, end).toString('base64'), next: end, done: end === t.size }
  }
  async withFiles<T>(owner: string, ids: string[], run: (paths: string[]) => Promise<T>): Promise<T> {
    if (new Set(ids).size !== ids.length) throw new Error('Select each upload only once.')
    const transfers = ids.map(id => this.get(owner, id))
    if (transfers.some(t => !t.ready || t.download || t.claimed)) throw new Error('Finish the upload before importing. Each upload can be imported once.')
    for (const t of transfers) t.claimed = true
    let dir: string | undefined
    try {
      dir = await mkdtemp(join(tmpdir(), 'grasberg-transfer-'))
      const paths: string[] = []
      for (const [index, t] of transfers.entries()) {
        const folder = join(dir, String(index))
        await mkdir(folder)
        const path = join(folder, t.name)
        await writeFile(path, Buffer.concat(t.parts))
        paths.push(path)
      }
      return await run(paths)
    } finally {
      for (const id of ids) this.transfers.delete(id)
      // dir is returned by mkdtemp under the fixed transfer prefix above.
      if (dir) await rm(dir, { recursive: true, force: true })
    }
  }
}

export async function localSelection(path: string): Promise<string> {
  if (!isAbsolute(path) || /^[\\/]{2}/.test(path) || path.includes('\0')) throw new Error('Choose a local desktop path.')
  const resolved = await realpath(path)
  if (/^[\\/]{2}/.test(resolved)) throw new Error('Network paths are not supported by this picker.')
  return resolved
}

export async function browseDesktop(path?: string, includeFiles = false) {
  const current = await localSelection(path || homedir())
  if (!(await stat(current)).isDirectory()) throw new Error('Choose a folder.')
  const entries = (await readdir(current, { withFileTypes: true })).filter(e => e.isDirectory() || (includeFiles && e.isFile())).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  return { path: current, parent: dirname(current) === current ? null : dirname(current), entries: entries.slice(0, 500).map(e => ({ name: e.name, path: resolve(current, e.name), directory: e.isDirectory() })), truncated: entries.length > 500 }
}
