/**
 * Pinned whisper.cpp download sources — the single place URLs, sizes and
 * SHA256 digests live. Binary assets come from the ggml-org/whisper.cpp
 * release tagged below (digests re-verified against the GitHub release API);
 * model digests come from Hugging Face's git-lfs pointers. Nothing is bundled
 * with the app: everything downloads on demand into {userData}/audio and is
 * hash-verified before use.
 */

import type { VoiceModelId } from '@shared/types'

export const WHISPER_RELEASE_TAG = 'b4938'

export interface WhisperBinaryAsset {
  url: string
  sha256: string
  sizeBytes: number
  archive: 'zip' | 'tar.gz'
}

const RELEASE_BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE_TAG}`

/**
 * Per-OS/arch CLI builds. The release ships NO macOS CLI binary (only an
 * xcframework), so darwin — and any other platform/arch missing here — cannot
 * auto-download; the Voice tab offers a local whisper-cli picker instead.
 */
export const WHISPER_BINARIES: Record<
  'win32-x64' | 'linux-x64' | 'linux-arm64',
  WhisperBinaryAsset
> = {
  'win32-x64': {
    url: `${RELEASE_BASE}/whisper-bin-x64.zip`,
    sha256: 'c2a4b60edb11f7e11a9191ffb50929535527d4d91c9903dbe3e554583bbbc63d',
    sizeBytes: 8_361_840,
    archive: 'zip',
  },
  'linux-x64': {
    url: `${RELEASE_BASE}/whisper-bin-ubuntu-x64.tar.gz`,
    sha256: 'f4cfc1f969a13805908fb72043ce7cc896eb42e0b8afbe841dc8e7298923b061',
    sizeBytes: 9_503_425,
    archive: 'tar.gz',
  },
  'linux-arm64': {
    url: `${RELEASE_BASE}/whisper-bin-ubuntu-arm64.tar.gz`,
    sha256: '94a33318650c57cc3d9a91439e0e3f0b94ba96bacd34203a06db395cf9204e40',
    sizeBytes: 4_572_294,
    archive: 'tar.gz',
  },
}

export interface WhisperModelAsset {
  url: string
  sha256: string
  sizeBytes: number
  label: string
}

/** Multilingual ggml models ('-l auto' handles Swedish and English alike). */
export const WHISPER_MODELS: Record<VoiceModelId, WhisperModelAsset> = {
  tiny: {
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
    sizeBytes: 77_691_713,
    label: 'Tiny (75 MB, fastest)',
  },
  base: {
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    sizeBytes: 147_951_465,
    label: 'Base (142 MB, recommended)',
  },
}

/** Per-session byte cap for a chunked push-to-talk upload. */
export const MAX_STT_SESSION_BYTES = 64 * 1024 * 1024
/** Per-chunk byte cap (mirrored in voiceSttChunkSchema). */
export const STT_CHUNK_MAX_BYTES = 8 * 1024 * 1024
export const TRANSCRIBE_TIMEOUT_MS = 5 * 60_000

/** Executable names scanned for inside an extracted archive, best first. */
export const BINARY_CANDIDATES = ['whisper-cli.exe', 'whisper-cli', 'main.exe', 'main']

/** The WHISPER_BINARIES key for a platform/arch, or null when unsupported. */
export function platformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): keyof typeof WHISPER_BINARIES | null {
  if (platform === 'win32' && arch === 'x64') return 'win32-x64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64'
  return null
}
