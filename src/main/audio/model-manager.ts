/**
 * Downloads and manages the whisper.cpp binary + ggml models under
 * {userData}/audio. Downloads are atomic (streamed to <name>.download, hashed
 * while streaming, renamed only after the SHA256 matches) and archive
 * extraction goes through the OS tar (bsdtar reads zip on Windows 10+) behind
 * an injectable seam — no new npm dependency, and no Electron imports so the
 * whole class runs in plain-Node tests.
 */

import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { join, relative, resolve, sep } from 'node:path'
import { CHANNELS } from '@shared/ipc'
import type { VoiceDownloadProgressEvent, VoiceModelId, VoiceStatus } from '@shared/types'
import {
  BINARY_CANDIDATES,
  platformKey,
  WHISPER_BINARIES,
  WHISPER_MODELS,
  WHISPER_RELEASE_TAG,
} from './constants'

interface VoiceManifest {
  releaseTag: string
  /** Path of the found whisper-cli, relative to the audio dir. */
  binaryRelPath: string
}

export type ExtractFn = (
  archivePath: string,
  destDir: string,
  archive: 'zip' | 'tar.gz'
) => Promise<void>

export interface VoiceModelManagerOptions {
  /** The app-owned audio directory ({userData}/audio). */
  dir: string
  broadcast: (channel: string, payload: unknown) => void
  /** settings.voiceWhisperBinaryPath (main-owned; overrides the download). */
  customBinaryPath: () => string | null
  /** settings.voiceModelId. */
  activeModelId: () => VoiceModelId
  fetchImpl?: typeof fetch
  /** Test seam; production extracts via the OS tar binary. */
  extract?: ExtractFn
  /** Test seams: override the pinned asset tables (fixture URLs + hashes). */
  binaries?: typeof WHISPER_BINARIES
  models?: typeof WHISPER_MODELS
  platform?: NodeJS.Platform
  arch?: string
}

/** bsdtar ships with Windows 10+ and opens zip via plain `tar -xf`. */
function defaultExtract(archivePath: string, destDir: string, archive: 'zip' | 'tar.gz'): Promise<void> {
  const argv =
    archive === 'zip' ? ['-xf', archivePath, '-C', destDir] : ['-xzf', archivePath, '-C', destDir]
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('tar', argv, { windowsHide: true, timeout: 120_000 }, (error) => {
      if (error) rejectPromise(new Error(`Archive extraction failed: ${error.message}`))
      else resolvePromise()
    })
  })
}

export class VoiceModelManager {
  private controller: AbortController | null = null
  private lastProgressAt = 0
  /** What the in-flight download is currently fetching (for error events). */
  private phase: { item: 'binary' | 'model'; modelId?: VoiceModelId } = { item: 'binary' }

  constructor(private readonly options: VoiceModelManagerOptions) {}

  private get dir(): string {
    return this.options.dir
  }

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform
  }

  private get arch(): string {
    return this.options.arch ?? process.arch
  }

  private modelFile(id: VoiceModelId): string {
    return join(this.dir, `ggml-${id}.bin`)
  }

  private get binaryAssets(): typeof WHISPER_BINARIES {
    return this.options.binaries ?? WHISPER_BINARIES
  }

  private get modelAssets(): typeof WHISPER_MODELS {
    return this.options.models ?? WHISPER_MODELS
  }

  private readManifest(): VoiceManifest | null {
    try {
      const parsed = JSON.parse(readFileSync(join(this.dir, 'manifest.json'), 'utf8')) as unknown
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as VoiceManifest).binaryRelPath === 'string'
      ) {
        return parsed as VoiceManifest
      }
    } catch {
      // Missing/corrupt manifest = no downloaded binary.
    }
    return null
  }

  /** Custom override wins; else the downloaded binary from the manifest. */
  binaryPath(): string | null {
    const custom = this.options.customBinaryPath()
    if (custom && existsSync(custom)) return custom
    const manifest = this.readManifest()
    if (manifest) {
      const path = join(this.dir, manifest.binaryRelPath)
      if (existsSync(path)) return path
    }
    return null
  }

  /** Absolute path of a downloaded model file, or null when absent. */
  modelPath(id: VoiceModelId): string | null {
    const path = this.modelFile(id)
    return existsSync(path) ? path : null
  }

  get downloading(): boolean {
    return this.controller !== null
  }

  status(): VoiceStatus {
    const custom = this.options.customBinaryPath()
    const customOk = custom !== null && custom.length > 0 && existsSync(custom)
    const manifest = this.readManifest()
    const downloadedOk =
      manifest !== null && existsSync(join(this.dir, manifest.binaryRelPath))
    return {
      platformDownloadSupported: platformKey(this.platform, this.arch) !== null,
      binaryReady: customOk || downloadedOk,
      binarySource: customOk ? 'custom' : downloadedOk ? 'downloaded' : null,
      models: (Object.keys(this.modelAssets) as VoiceModelId[]).map((id) => ({
        id,
        sizeBytes: this.modelAssets[id].sizeBytes,
        downloaded: existsSync(this.modelFile(id)),
      })),
      activeModelId: this.options.activeModelId(),
      downloading: this.controller !== null,
    }
  }

  /**
   * Downloads the whisper binary (when missing and the platform has one) and
   * the given model. One download at a time; progress rides the push channel
   * and a terminal 'done'/'error' event is always sent.
   */
  async download(modelId: VoiceModelId): Promise<void> {
    if (this.controller) throw new Error('A voice download is already in progress.')
    const controller = new AbortController()
    this.controller = controller
    try {
      await mkdir(this.dir, { recursive: true })

      if (!this.binaryPath()) {
        const key = platformKey(this.platform, this.arch)
        if (!key) {
          throw new Error(
            'Automatic download is not available on this OS — pick a local whisper-cli binary in Settings → Voice.'
          )
        }
        const asset = this.binaryAssets[key]
        const archivePath = join(this.dir, asset.url.split('/').pop() ?? 'whisper-archive')
        await this.streamDownload(
          asset.url,
          archivePath,
          asset.sha256,
          asset.sizeBytes,
          { item: 'binary' },
          controller.signal
        )
        this.progress(
          {
            item: 'binary',
            receivedBytes: asset.sizeBytes,
            totalBytes: asset.sizeBytes,
            status: 'extracting',
          },
          true
        )
        const binDir = join(this.dir, `bin-${WHISPER_RELEASE_TAG}`)
        await mkdir(binDir, { recursive: true })
        const extract = this.options.extract ?? defaultExtract
        await extract(archivePath, binDir, asset.archive)
        await unlink(archivePath).catch(() => undefined)
        // Upstream archive layout is not contractual — scan for the CLI.
        const found = await this.findBinary(binDir)
        if (!found) throw new Error('The downloaded archive did not contain a whisper-cli binary.')
        if (this.platform !== 'win32') await chmod(found, 0o755).catch(() => undefined)
        const manifest: VoiceManifest = {
          releaseTag: WHISPER_RELEASE_TAG,
          binaryRelPath: relative(this.dir, found),
        }
        await writeFile(join(this.dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
        this.progress(
          {
            item: 'binary',
            receivedBytes: asset.sizeBytes,
            totalBytes: asset.sizeBytes,
            status: 'done',
          },
          true
        )
      }

      const model = this.modelAssets[modelId]
      if (!this.modelPath(modelId)) {
        await this.streamDownload(
          model.url,
          this.modelFile(modelId),
          model.sha256,
          model.sizeBytes,
          { item: 'model', modelId },
          controller.signal
        )
      }
      this.progress(
        {
          item: 'model',
          modelId,
          receivedBytes: model.sizeBytes,
          totalBytes: model.sizeBytes,
          status: 'done',
        },
        true
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.progress(
        { ...this.phase, receivedBytes: 0, totalBytes: null, status: 'error', error: message },
        true
      )
      throw e
    } finally {
      this.controller = null
    }
  }

  /** Aborts the in-flight download (its temp file is deleted by the catch path). */
  cancel(): void {
    this.controller?.abort()
  }

  /** Deletes a downloaded model file. Only ever unlinks under the audio dir. */
  async remove(modelId: VoiceModelId): Promise<void> {
    const file = resolve(this.modelFile(modelId))
    const root = resolve(this.dir)
    if (!file.startsWith(root + sep)) {
      throw new Error('Refusing to delete a file outside the audio directory.')
    }
    await unlink(file).catch(() => undefined)
  }

  /** Streams url → dest atomically, verifying the SHA256 while downloading. */
  private async streamDownload(
    url: string,
    dest: string,
    sha256: string,
    sizeFallback: number,
    phase: { item: 'binary' | 'model'; modelId?: VoiceModelId },
    signal: AbortSignal
  ): Promise<void> {
    this.phase = phase
    const fetchImpl = this.options.fetchImpl ?? fetch
    const res = await fetchImpl(url, { signal, redirect: 'follow' })
    if (!res.ok || !res.body) {
      throw new Error(`Download failed (HTTP ${res.status}).`)
    }
    const headerLength = Number(res.headers.get('content-length') ?? '')
    const totalBytes =
      Number.isFinite(headerLength) && headerLength > 0 ? headerLength : sizeFallback
    const temp = `${dest}.download`
    const hash = createHash('sha256')
    const out = createWriteStream(temp)
    // A write error between writes (disk full while the buffer isn't
    // saturated) would otherwise hit a stream with no 'error' listener — an
    // uncaught exception in main instead of the cleanup path below.
    const writeError: { current: Error | null } = { current: null }
    out.on('error', (err: Error) => {
      writeError.current = err
    })
    let received = 0
    try {
      const reader = res.body.getReader()
      for (;;) {
        if (writeError.current) throw writeError.current
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        hash.update(value)
        received += value.byteLength
        if (!out.write(Buffer.from(value))) await once(out, 'drain')
        this.progress({ ...phase, receivedBytes: received, totalBytes, status: 'downloading' })
      }
      if (writeError.current) throw writeError.current
      await new Promise<void>((resolvePromise, rejectPromise) => {
        out.end((err?: Error | null) => (err ? rejectPromise(err) : resolvePromise()))
      })
      if (writeError.current) throw writeError.current
      this.progress({ ...phase, receivedBytes: received, totalBytes, status: 'verifying' }, true)
      const digest = hash.digest('hex')
      if (digest !== sha256) {
        throw new Error('Checksum mismatch — the download was discarded.')
      }
      await rename(temp, dest)
    } catch (e) {
      out.destroy()
      await unlink(temp).catch(() => undefined)
      throw e
    }
  }

  /** Recursive scan (depth ≤ 3) for the best BINARY_CANDIDATES match. */
  private async findBinary(root: string): Promise<string | null> {
    const matches: Array<{ path: string; rank: number }> = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full, depth + 1)
        else {
          const rank = BINARY_CANDIDATES.indexOf(entry.name)
          if (rank !== -1) matches.push({ path: full, rank })
        }
      }
    }
    await walk(root, 0)
    matches.sort((a, b) => a.rank - b.rank)
    return matches[0]?.path ?? null
  }

  /** Throttled broadcast (~4/s while downloading; phase changes always sent). */
  private progress(event: VoiceDownloadProgressEvent, force = false): void {
    const now = Date.now()
    if (!force && event.status === 'downloading' && now - this.lastProgressAt < 250) return
    this.lastProgressAt = now
    this.options.broadcast(CHANNELS.voiceDownloadProgress, event)
  }
}
