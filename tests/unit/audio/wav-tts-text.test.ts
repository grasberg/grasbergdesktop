/**
 * Pure voice helpers (shared, DOM-free so they run under the node tsconfig):
 * WAV encoding header math, streaming sentence splitting, markdown-to-speech
 * text stripping.
 */

import { describe, expect, it } from 'vitest'
import { encodeWav } from '@shared/wav-encode'
import { consumeSpeakable, speakableText, splitSentences } from '@shared/tts-text'

function tag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  )
}

describe('encodeWav', () => {
  it('writes a correct 44-byte RIFF/WAVE header for 16 kHz mono 16-bit PCM', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1])
    const buffer = encodeWav(samples)
    const view = new DataView(buffer)

    expect(buffer.byteLength).toBe(44 + samples.length * 2)
    expect(tag(view, 0)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2)
    expect(tag(view, 8)).toBe('WAVE')
    expect(tag(view, 12)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(28, true)).toBe(32_000) // byte rate
    expect(view.getUint16(32, true)).toBe(2) // block align
    expect(view.getUint16(34, true)).toBe(16) // bits/sample
    expect(tag(view, 36)).toBe('data')
    expect(view.getUint32(40, true)).toBe(samples.length * 2)
  })

  it('scales and clamps samples to int16', () => {
    const buffer = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]))
    const view = new DataView(buffer)
    const sample = (i: number): number => view.getInt16(44 + i * 2, true)
    expect(sample(0)).toBe(0)
    expect(sample(1)).toBe(0x7fff)
    expect(sample(2)).toBe(-0x8000)
    expect(sample(3)).toBe(0x7fff) // clamped
    expect(sample(4)).toBe(-0x8000) // clamped
    expect(sample(5)).toBe(Math.trunc(0.5 * 0x7fff))
  })
})

describe('splitSentences', () => {
  it('yields nothing for a mid-sentence buffer, then the sentence once terminated', () => {
    const first = splitSentences('The build is still ')
    expect(first.complete).toEqual([])
    expect(first.rest).toBe('The build is still ')

    const second = splitSentences('The build is still running. And now')
    expect(second.complete).toEqual(['The build is still running.'])
    expect(second.rest).toBe('And now')
  })

  it('splits multiple sentences and keeps the unfinished tail across flushes', () => {
    const { complete, rest } = splitSentences('One done. Two also done! Is three done? Half of four')
    expect(complete).toEqual(['One done.', 'Two also done!', 'Is three done?'])
    expect(rest).toBe('Half of four')
  })

  it('a blank line ends a sentence even without punctuation', () => {
    const { complete, rest } = splitSentences('A heading line\n\nNext paragraph starts')
    expect(complete).toEqual(['A heading line'])
    expect(rest).toBe('Next paragraph starts')
  })
})

describe('consumeSpeakable (the store feed order: fences before sentence splits)', () => {
  const fenced = [
    'The fix follows.',
    '',
    '```js',
    'const x = 1. // initial value',
    '',
    'run()',
    '```',
    '',
    'Done now.',
  ].join('\n')

  it('speaks a multi-line fence as one omission, never code lines', () => {
    const { sentences } = consumeSpeakable(fenced, 0, true)
    expect(sentences).toContain('The fix follows.')
    expect(sentences).toContain('code block omitted.')
    expect(sentences).toContain('Done now.')
    expect(sentences.some((s) => s.includes('const x'))).toBe(false)
    expect(sentences.some((s) => s.includes('run()'))).toBe(false)
  })

  it('holds back an unclosed fence mid-stream and releases it when it closes', () => {
    const partial = fenced.slice(0, fenced.indexOf('run()'))
    const first = consumeSpeakable(partial, 0, false)
    expect(first.sentences).toEqual(['The fix follows.'])
    // Nothing inside the open fence was consumed or spoken.
    expect(partial.slice(first.offset).startsWith('```')).toBe(true)

    const second = consumeSpeakable(fenced, first.offset, true)
    expect(second.sentences).toEqual(['code block omitted.', 'Done now.'])
    expect(second.offset).toBe(fenced.length)
  })

  it('an unclosed fence at the final flush still reports the omission', () => {
    const { sentences } = consumeSpeakable('Look:\n\n```py\nprint(1)', 0, true)
    expect(sentences).toEqual(['Look:', 'code block omitted.'])
  })
})

describe('speakableText', () => {
  it('replaces fenced code blocks and strips inline markdown', () => {
    const md = [
      '# Result',
      '',
      'The fix is **simple** — change `foo()` to call [the docs](https://example.com).',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      'Done.',
    ].join('\n')
    const text = speakableText(md)
    expect(text).toContain('The fix is simple')
    expect(text).toContain('foo()')
    expect(text).toContain('the docs')
    expect(text).not.toContain('https://example.com')
    expect(text).not.toContain('const x = 1')
    expect(text).toContain('code block omitted.')
    expect(text).not.toContain('#')
    expect(text).not.toContain('**')
  })
})
