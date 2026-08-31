/**
 * Pure WAV encoding (no DOM types, no runtime deps) — kept in shared so the
 * renderer recorder and plain-Node unit tests use the same header math.
 */

export const RECORD_SAMPLE_RATE = 16_000

/** Encodes mono float samples as a 16-bit PCM RIFF WAV (44-byte header). */
export function encodeWav(samples: Float32Array, sampleRate = RECORD_SAMPLE_RATE): ArrayBuffer {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeTag = (offset: number, tag: string): void => {
    for (let i = 0; i < tag.length; i++) view.setUint8(offset + i, tag.charCodeAt(i))
  }
  writeTag(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeTag(8, 'WAVE')
  writeTag(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeTag(36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += 2
  }
  return buffer
}
