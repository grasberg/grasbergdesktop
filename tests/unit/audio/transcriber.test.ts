/**
 * Transcriber: RIFF validation, whisper argv shape, temp-wav cleanup, error
 * mapping and the serialized queue — via the injectable spawn seam plus two
 * real-execFile cases (missing binary, non-zero exit).
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Transcriber,
  looksLikeWav,
  type WhisperRunResult,
  type WhisperSpawn,
} from '../../../src/main/audio/transcriber'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-stt-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Minimal valid-looking WAV bytes (RIFF....WAVE + 44-byte header). */
function wavBytes(): Uint8Array {
  const bytes = Buffer.alloc(64)
  bytes.write('RIFF', 0)
  bytes.write('WAVE', 8)
  return new Uint8Array(bytes)
}

function makeTranscriber(spawnImpl?: WhisperSpawn, overrides?: {
  binary?: string | null
  model?: string | null
}): Transcriber {
  return new Transcriber({
    resolveBinary: () => (overrides && 'binary' in overrides ? (overrides.binary ?? null) : '/fake/whisper-cli'),
    resolveModel: () => (overrides && 'model' in overrides ? (overrides.model ?? null) : '/fake/ggml-base.bin'),
    tmpDir: join(dir, 'tmp'),
    ...(spawnImpl ? { spawnImpl } : {}),
  })
}

describe('transcribeWav', () => {
  it('spawns whisper with the expected argv and returns trimmed stdout', async () => {
    const calls: Array<{ file: string; argv: string[]; wavExisted: boolean }> = []
    const spawn: WhisperSpawn = async (file, argv, _opts) => {
      const wavPath = argv[argv.indexOf('-f') + 1]
      calls.push({ file, argv, wavExisted: existsSync(wavPath) })
      return { stdout: '  hej världen \n', stderr: '', failure: null }
    }
    const transcriber = makeTranscriber(spawn)

    const text = await transcriber.transcribeWav(wavBytes())

    expect(text).toBe('hej världen')
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('/fake/whisper-cli')
    const argv = calls[0].argv
    expect(argv[argv.indexOf('-m') + 1]).toBe('/fake/ggml-base.bin')
    expect(argv).toContain('-nt')
    expect(argv).toContain('-np')
    expect(argv[argv.indexOf('-l') + 1]).toBe('auto')
    const wavPath = argv[argv.indexOf('-f') + 1]
    expect(wavPath.startsWith(join(dir, 'tmp'))).toBe(true)
    expect(wavPath.endsWith('.wav')).toBe(true)
    // The temp wav existed during the run and is unlinked afterwards.
    expect(calls[0].wavExisted).toBe(true)
    expect(readdirSync(join(dir, 'tmp'))).toHaveLength(0)
  })

  it('unlinks the temp wav on failure too and surfaces stderr', async () => {
    const spawn: WhisperSpawn = async () => ({
      stdout: '',
      stderr: 'ggml: model load failed',
      failure: { kind: 'exit', detail: 'exit 1' },
    })
    const transcriber = makeTranscriber(spawn)
    await expect(transcriber.transcribeWav(wavBytes())).rejects.toThrow(/model load failed/)
    expect(readdirSync(join(dir, 'tmp'))).toHaveLength(0)
  })

  it('rejects non-WAV bytes before any spawn', async () => {
    let spawned = 0
    const spawn: WhisperSpawn = async () => {
      spawned += 1
      return { stdout: '', stderr: '', failure: null }
    }
    const transcriber = makeTranscriber(spawn)
    await expect(
      transcriber.transcribeWav(new TextEncoder().encode('definitely not a wav'))
    ).rejects.toThrow(/valid WAV/i)
    expect(spawned).toBe(0)
    expect(looksLikeWav(wavBytes())).toBe(true)
    expect(looksLikeWav(new Uint8Array(10))).toBe(false)
  })

  it('missing binary/model reports "not downloaded" without spawning', async () => {
    let spawned = 0
    const spawn: WhisperSpawn = async () => {
      spawned += 1
      return { stdout: '', stderr: '', failure: null }
    }
    const transcriber = makeTranscriber(spawn, { binary: null, model: null })
    await expect(transcriber.transcribeWav(wavBytes())).rejects.toThrow(/not downloaded/i)
    expect(spawned).toBe(0)
  })
})

describe('real execFile error mapping (default spawn)', () => {
  it('ENOENT maps to a "not found" error', async () => {
    const transcriber = makeTranscriber(undefined, {
      binary: join(dir, 'definitely-missing-whisper.exe'),
      model: join(dir, 'ggml.bin'),
    })
    await expect(transcriber.transcribeFile(join(dir, 'x.wav'))).rejects.toThrow(/not found/i)
  })

  it('a non-zero exit surfaces the child stderr', async () => {
    // node rejects the whisper argv ('-m …') with "bad option" on stderr.
    const transcriber = makeTranscriber(undefined, {
      binary: process.execPath,
      model: join(dir, 'ggml.bin'),
    })
    await expect(transcriber.transcribeFile(join(dir, 'x.wav'))).rejects.toThrow(
      /Transcription failed/i
    )
  })
})

describe('serialization', () => {
  it('runs one child at a time and rejects the 4th pending call as busy', async () => {
    const resolvers: Array<(r: WhisperRunResult) => void> = []
    const spawn: WhisperSpawn = () => new Promise((resolve) => resolvers.push(resolve))
    const transcriber = makeTranscriber(spawn)

    const first = transcriber.transcribeWav(wavBytes())
    const second = transcriber.transcribeWav(wavBytes())
    const third = transcriber.transcribeWav(wavBytes())
    await new Promise((r) => setTimeout(r, 20))
    // Only the first has actually spawned; the rest wait in the FIFO.
    expect(resolvers).toHaveLength(1)

    await expect(transcriber.transcribeWav(wavBytes())).rejects.toThrow(/busy/i)

    resolvers[0]({ stdout: 'one', stderr: '', failure: null })
    await expect(first).resolves.toBe('one')
    await new Promise((r) => setTimeout(r, 20))
    expect(resolvers).toHaveLength(2)
    resolvers[1]({ stdout: 'two', stderr: '', failure: null })
    await expect(second).resolves.toBe('two')
    await new Promise((r) => setTimeout(r, 20))
    resolvers[2]({ stdout: 'three', stderr: '', failure: null })
    await expect(third).resolves.toBe('three')
  })
})
