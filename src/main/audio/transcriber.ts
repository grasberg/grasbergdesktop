/**
 * Runs the local whisper-cli over WAV bytes or stored audio files. Spawned via
 * pipes (execFile, no shell — the terminal-service discipline) with an
 * injectable spawn seam for tests. Transcriptions are serialized: whisper is
 * CPU-heavy, so one child runs at a time with a small FIFO behind it.
 */

import { randomUUID } from 'node:crypto'
import { execFile, type ChildProcess } from 'node:child_process'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProviderError } from '../providers/errors'
import { redactSecrets } from '../providers/redact'
import { TRANSCRIBE_TIMEOUT_MS } from './constants'

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
/** Queued + running calls beyond this reject with a busy error. */
const MAX_PENDING = 3

export interface WhisperRunResult {
  stdout: string
  stderr: string
  /** null = ran and exited 0. */
  failure: null | { kind: 'not_found' | 'timeout' | 'exit'; detail?: string }
}

export type WhisperSpawn = (
  file: string,
  argv: string[],
  opts: { timeout: number; maxBuffer: number; windowsHide: boolean }
) => Promise<WhisperRunResult>

export interface TranscriberOptions {
  /** The whisper-cli to spawn (VoiceModelManager.binaryPath), null = not ready. */
  resolveBinary: () => string | null
  /** The ggml model file, null = not downloaded. */
  resolveModel: () => string | null
  /** Where temp WAVs are written (unlinked after each run). */
  tmpDir: string
  /** Test seam; production spawns via execFile. */
  spawnImpl?: WhisperSpawn
}

function invalid(message: string): ProviderError {
  return new ProviderError('invalid_request', message)
}

/** RIFF/WAVE magic: bytes 0-3 'RIFF', 8-11 'WAVE'. */
export function looksLikeWav(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 44) return false
  const tag = (offset: number): string =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
  return tag(0) === 'RIFF' && tag(8) === 'WAVE'
}

export class Transcriber {
  private tail: Promise<unknown> = Promise.resolve()
  private pending = 0
  private readonly children = new Set<ChildProcess>()
  private disposed = false

  constructor(private readonly options: TranscriberOptions) {}

  /** Transcribes in-memory WAV bytes (push-to-talk). */
  async transcribeWav(bytes: Uint8Array): Promise<string> {
    if (!looksLikeWav(bytes)) {
      throw invalid('The recording is not a valid WAV file.')
    }
    return this.enqueue(async () => {
      await mkdir(this.options.tmpDir, { recursive: true })
      const wavPath = join(this.options.tmpDir, `${randomUUID()}.wav`)
      await writeFile(wavPath, bytes)
      try {
        return await this.run(wavPath)
      } finally {
        await unlink(wavPath).catch(() => undefined)
      }
    })
  }

  /** Transcribes a stored audio file in place (audio attachments). */
  async transcribeFile(absPath: string): Promise<string> {
    return this.enqueue(() => this.run(absPath))
  }

  /** Kills live children and blocks new work (app shutdown). */
  disposeAll(): void {
    this.disposed = true
    for (const child of this.children) {
      try {
        child.kill()
      } catch {
        // best-effort
      }
    }
    this.children.clear()
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.disposed) throw invalid('Transcription is shutting down.')
    if (this.pending >= MAX_PENDING) {
      throw invalid('Transcription is busy — try again in a moment.')
    }
    this.pending += 1
    const run = this.tail.then(fn, fn)
    // Settle bookkeeping via then(fn, fn): a .finally() here would mint a new
    // unhandled rejection alongside the one the caller already handles.
    const settle = (): void => {
      this.pending -= 1
    }
    this.tail = run.then(settle, settle)
    return run
  }

  private async run(audioPath: string): Promise<string> {
    const binary = this.options.resolveBinary()
    const model = this.options.resolveModel()
    if (!binary || !model) {
      throw invalid('The voice model is not downloaded — set it up in Settings → Voice.')
    }
    // -nt: no timestamps, -np: no progress prints, -l auto: language detection.
    const argv = ['-m', model, '-f', audioPath, '-nt', '-np', '-l', 'auto', '-t', '4']
    const spawn = this.options.spawnImpl ?? this.defaultSpawn
    const result = await spawn(binary, argv, {
      timeout: TRANSCRIBE_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    })
    if (result.failure) {
      if (result.failure.kind === 'not_found') {
        throw invalid('The whisper binary was not found — re-download it in Settings → Voice.')
      }
      if (result.failure.kind === 'timeout') {
        throw invalid('Transcription timed out.')
      }
      const detail = redactSecrets(
        (result.stderr || result.failure.detail || 'unknown error').trim().slice(0, 2000)
      )
      throw invalid(`Transcription failed: ${detail}`)
    }
    return result.stdout.trim()
  }

  private readonly defaultSpawn: WhisperSpawn = (file, argv, opts) =>
    new Promise((resolvePromise) => {
      const child = execFile(file, argv, opts, (error, stdout, stderr) => {
        this.children.delete(child)
        if (!error) {
          resolvePromise({ stdout, stderr, failure: null })
          return
        }
        const e = error as NodeJS.ErrnoException & { killed?: boolean }
        const failure: WhisperRunResult['failure'] =
          e.code === 'ENOENT'
            ? { kind: 'not_found' }
            : e.killed
              ? { kind: 'timeout' }
              : { kind: 'exit', detail: e.message }
        resolvePromise({ stdout: stdout ?? '', stderr: stderr ?? '', failure })
      })
      this.children.add(child)
    })
}
