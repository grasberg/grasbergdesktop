/**
 * VoiceModelManager: atomic SHA256-verified downloads into a temp dir with a
 * mocked fetch and an injected extract seam — no network, no real archives.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHANNELS } from '@shared/ipc'
import type { VoiceDownloadProgressEvent, VoiceModelId } from '@shared/types'
import {
  VoiceModelManager,
  type VoiceModelManagerOptions,
} from '../../../src/main/audio/model-manager'
import { WHISPER_BINARIES, WHISPER_MODELS, platformKey } from '../../../src/main/audio/constants'
import { makeFetchSequence } from '../../helpers/mock-fetch'

const ARCHIVE_BYTES = Buffer.from('fake whisper archive bytes for the extract seam')
const MODEL_BYTES = Buffer.from('fake ggml model weights — small but hashed for real')

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function fixtureBinaries(sha = sha256(ARCHIVE_BYTES)): typeof WHISPER_BINARIES {
  const asset = {
    url: 'https://example.com/whisper-bin-x64.zip',
    sha256: sha,
    sizeBytes: ARCHIVE_BYTES.byteLength,
    archive: 'zip' as const,
  }
  return { 'win32-x64': asset, 'linux-x64': asset, 'linux-arm64': asset }
}

function fixtureModels(sha = sha256(MODEL_BYTES)): typeof WHISPER_MODELS {
  const asset = (id: string) => ({
    url: `https://example.com/ggml-${id}.bin`,
    sha256: sha,
    sizeBytes: MODEL_BYTES.byteLength,
    label: id,
  })
  return { tiny: asset('tiny'), base: asset('base') }
}

let dir: string
let events: VoiceDownloadProgressEvent[]

function collectingBroadcast() {
  return (channel: string, payload: unknown): void => {
    if (channel === CHANNELS.voiceDownloadProgress) {
      events.push(payload as VoiceDownloadProgressEvent)
    }
  }
}

function makeManager(overrides: Partial<VoiceModelManagerOptions> = {}): VoiceModelManager {
  return new VoiceModelManager({
    dir,
    broadcast: collectingBroadcast(),
    customBinaryPath: () => null,
    activeModelId: () => 'tiny',
    binaries: fixtureBinaries(),
    models: fixtureModels(),
    platform: 'win32',
    arch: 'x64',
    ...overrides,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-voice-'))
  events = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('VoiceModelManager.download', () => {
  it('downloads, verifies, extracts and records the found binary + model', async () => {
    const extractCalls: Array<{ archivePath: string; destDir: string; archive: string }> = []
    const fetchImpl = makeFetchSequence(
      new Response(new Uint8Array(ARCHIVE_BYTES)),
      new Response(new Uint8Array(MODEL_BYTES))
    )
    const manager = makeManager({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      extract: async (archivePath, destDir, archive) => {
        extractCalls.push({ archivePath, destDir, archive })
        // Nested layout: the scan must find whisper-cli.exe below the root.
        const nested = join(destDir, 'build', 'bin')
        mkdirSync(nested, { recursive: true })
        writeFileSync(join(nested, 'whisper-cli.exe'), 'binary')
      },
    })

    await manager.download('tiny')

    expect(fetchImpl.requests.map((r) => r.url)).toEqual([
      'https://example.com/whisper-bin-x64.zip',
      'https://example.com/ggml-tiny.bin',
    ])
    expect(extractCalls).toHaveLength(1)
    expect(extractCalls[0].archivePath).toBe(join(dir, 'whisper-bin-x64.zip'))
    expect(extractCalls[0].archive).toBe('zip')

    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    expect(existsSync(join(dir, manifest.binaryRelPath))).toBe(true)
    expect(manifest.binaryRelPath).toContain('whisper-cli.exe')

    // The model landed atomically: final file present, no temp left behind.
    expect(readFileSync(join(dir, 'ggml-tiny.bin'))).toEqual(MODEL_BYTES)
    expect(readdirSync(dir).some((name) => name.endsWith('.download'))).toBe(false)

    const statuses = events.map((e) => e.status)
    expect(statuses).toContain('downloading')
    expect(statuses).toContain('verifying')
    expect(statuses).toContain('extracting')
    expect(events[events.length - 1]).toMatchObject({ item: 'model', modelId: 'tiny', status: 'done' })

    const status = manager.status()
    expect(status.binaryReady).toBe(true)
    expect(status.binarySource).toBe('downloaded')
    expect(status.models.find((m) => m.id === 'tiny')?.downloaded).toBe(true)
    expect(manager.binaryPath()).toBe(join(dir, manifest.binaryRelPath))
    expect(manager.modelPath('tiny')).toBe(join(dir, 'ggml-tiny.bin'))
  })

  it('checksum mismatch deletes the temp, broadcasts error and rejects', async () => {
    const fetchImpl = makeFetchSequence(new Response(new Uint8Array(ARCHIVE_BYTES)))
    const manager = makeManager({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      binaries: fixtureBinaries('0'.repeat(64)),
      extract: async () => {
        throw new Error('extract must not run on a failed checksum')
      },
    })

    await expect(manager.download('tiny')).rejects.toThrow(/checksum mismatch/i)
    expect(readdirSync(dir).some((name) => name.endsWith('.download'))).toBe(false)
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false)
    expect(events[events.length - 1]?.status).toBe('error')
    expect(manager.status().downloading).toBe(false)
  })

  it('cancel aborts mid-stream and leaves no partial file', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1024))
          init?.signal?.addEventListener('abort', () =>
            controller.error(new Error('The operation was aborted'))
          )
        },
      })
      return new Response(stream)
    }
    const manager = makeManager({ fetchImpl })

    const pending = manager.download('tiny')
    await new Promise((r) => setTimeout(r, 50))
    manager.cancel()
    await expect(pending).rejects.toThrow()
    expect(readdirSync(dir).some((name) => name.endsWith('.download'))).toBe(false)
    expect(events[events.length - 1]?.status).toBe('error')
  })

  it('refuses a second download while one is in flight', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
        },
      })
      return new Response(stream)
    }
    const manager = makeManager({ fetchImpl })
    const pending = manager.download('tiny')
    await new Promise((r) => setTimeout(r, 20))
    await expect(manager.download('base')).rejects.toThrow(/already in progress/i)
    manager.cancel()
    await expect(pending).rejects.toThrow()
  })
})

describe('platform support + remove', () => {
  it('darwin has no downloadable binary: status says so and download refuses', async () => {
    const manager = makeManager({ platform: 'darwin', arch: 'arm64' })
    expect(platformKey('darwin', 'arm64')).toBeNull()
    expect(manager.status().platformDownloadSupported).toBe(false)
    await expect(manager.download('tiny')).rejects.toThrow(/not available on this OS/i)
  })

  it('a custom binary path wins and reports binarySource custom', () => {
    const custom = join(dir, 'my-whisper.exe')
    writeFileSync(custom, 'x')
    const manager = makeManager({ customBinaryPath: () => custom })
    expect(manager.status()).toMatchObject({ binaryReady: true, binarySource: 'custom' })
    expect(manager.binaryPath()).toBe(custom)
  })

  it('remove refuses a path that escapes the audio dir', async () => {
    const manager = makeManager()
    // A crafted "model id" whose ggml-<id>.bin resolves above the audio dir.
    const evil = 'x/../../../evil' as VoiceModelId
    await expect(manager.remove(evil)).rejects.toThrow(/outside the audio directory/i)
  })

  it('remove unlinks only the model file', async () => {
    writeFileSync(join(dir, 'ggml-tiny.bin'), 'weights')
    const manager = makeManager()
    await manager.remove('tiny')
    expect(existsSync(join(dir, 'ggml-tiny.bin'))).toBe(false)
  })
})
