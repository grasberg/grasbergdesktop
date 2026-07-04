import { describe, expect, it } from 'vitest'
import { diffLines, isProbablyBinary } from '../../src/main/utils/diff'

/** Minimal unified-diff applier used to verify diffs round-trip old -> new. */
function applyUnifiedDiff(oldText: string, diff: string): string {
  const oldLines = oldText.length === 0 ? [] : oldText.split('\n')
  if (oldLines[oldLines.length - 1] === '') oldLines.pop()

  const out: string[] = []
  let oldIdx = 0 // 0-based index of the next old line to copy

  const lines = diff.split('\n')
  let i = 0
  while (i < lines.length) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[i])
    if (!header) {
      i++
      continue
    }
    const aStart = Number(header[1])
    const aCount = Number(header[2])
    const insertAt = aCount === 0 ? aStart : aStart - 1
    while (oldIdx < insertAt) out.push(oldLines[oldIdx++])
    i++
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const line = lines[i]
      if (line.startsWith(' ')) {
        expect(oldLines[oldIdx]).toBe(line.slice(1)) // context must match old
        out.push(oldLines[oldIdx++])
      } else if (line.startsWith('-')) {
        expect(oldLines[oldIdx]).toBe(line.slice(1)) // removal must match old
        oldIdx++
      } else if (line.startsWith('+')) {
        out.push(line.slice(1))
      }
      i++
    }
  }
  while (oldIdx < oldLines.length) out.push(oldLines[oldIdx++])
  return out.length === 0 ? '' : out.join('\n') + '\n'
}

function numbered(from: number, to: number): string {
  const lines: string[] = []
  for (let n = from; n <= to; n++) lines.push(`line ${n}`)
  return lines.join('\n') + '\n'
}

describe('diffLines', () => {
  it('returns an empty string for identical input', () => {
    const text = numbered(1, 20)
    expect(diffLines(text, text, 'a/x', 'b/x')).toBe('')
    expect(diffLines('', '', 'a/x', 'b/x')).toBe('')
  })

  it('produces a create diff from empty old text', () => {
    const diff = diffLines('', 'alpha\nbeta\ngamma\n', '/dev/null', 'b/new.txt')
    const lines = diff.split('\n')
    expect(lines[0]).toBe('--- /dev/null')
    expect(lines[1]).toBe('+++ b/new.txt')
    expect(lines[2]).toBe('@@ -0,0 +1,3 @@')
    expect(lines.slice(3, 6)).toEqual(['+alpha', '+beta', '+gamma'])
  })

  it('produces a delete diff to empty new text', () => {
    const diff = diffLines('alpha\nbeta\n', '', 'a/old.txt', '/dev/null')
    const lines = diff.split('\n')
    expect(lines[0]).toBe('--- a/old.txt')
    expect(lines[1]).toBe('+++ /dev/null')
    expect(lines[2]).toBe('@@ -1,2 +0,0 @@')
    expect(lines.slice(3, 5)).toEqual(['-alpha', '-beta'])
  })

  it('edits a middle line with three lines of context on each side', () => {
    const oldText = numbered(1, 9)
    const newText = oldText.replace('line 5', 'LINE FIVE')
    const diff = diffLines(oldText, newText, 'a/f.txt', 'b/f.txt')
    const lines = diff.split('\n')
    expect(lines[2]).toBe('@@ -2,7 +2,7 @@')
    expect(lines.slice(3, 11)).toEqual([
      ' line 2',
      ' line 3',
      ' line 4',
      '-line 5',
      '+LINE FIVE',
      ' line 6',
      ' line 7',
      ' line 8',
    ])
    expect(applyUnifiedDiff(oldText, diff)).toBe(newText)
  })

  it('splits far-apart changes into separate hunks', () => {
    const oldText = numbered(1, 30)
    const newText = oldText.replace('line 3', 'CHANGED 3').replace('line 27', 'CHANGED 27')
    const diff = diffLines(oldText, newText, 'a/f', 'b/f')
    const hunkHeaders = diff.split('\n').filter((l) => l.startsWith('@@'))
    expect(hunkHeaders).toHaveLength(2)
    expect(applyUnifiedDiff(oldText, diff)).toBe(newText)
  })

  it('merges nearby changes into a single hunk', () => {
    const oldText = numbered(1, 20)
    const newText = oldText.replace('line 8', 'CHANGED 8').replace('line 11', 'CHANGED 11')
    const diff = diffLines(oldText, newText, 'a/f', 'b/f')
    const hunkHeaders = diff.split('\n').filter((l) => l.startsWith('@@'))
    expect(hunkHeaders).toHaveLength(1)
    expect(applyUnifiedDiff(oldText, diff)).toBe(newText)
  })

  it('anchors a change at the very first line correctly', () => {
    const oldText = numbered(1, 6)
    const newText = oldText.replace('line 1', 'FIRST')
    const diff = diffLines(oldText, newText, 'a/f', 'b/f')
    expect(diff.split('\n')[2]).toBe('@@ -1,4 +1,4 @@')
    expect(applyUnifiedDiff(oldText, diff)).toBe(newText)
  })

  it('round-trips a mixed edit (insertions, deletions, replacements, dupes)', () => {
    const oldText = [
      'header',
      'alpha',
      'same',
      'same',
      'beta',
      'gamma',
      'delta',
      'same',
      'epsilon',
      'footer',
    ].join('\n') + '\n'
    const newText = [
      'header',
      'ALPHA',
      'same',
      'inserted 1',
      'same',
      'gamma',
      'delta 2',
      'same',
      'inserted 2',
      'footer',
    ].join('\n') + '\n'
    const diff = diffLines(oldText, newText, 'a/f', 'b/f')
    expect(applyUnifiedDiff(oldText, diff)).toBe(newText)
  })

  it('round-trips a completely rewritten file (no common lines)', () => {
    const oldText = 'one\ntwo\nthree\n'
    const newText = 'four\nfive\n'
    const diff = diffLines(oldText, newText, 'a/f', 'b/f')
    expect(diff.split('\n')[2]).toBe('@@ -1,3 +1,2 @@')
    expect(applyUnifiedDiff(oldText, diff)).toBe(newText)
  })

  it('handles large files with scattered changes without blowing up', () => {
    const oldLines: string[] = []
    for (let n = 0; n < 5000; n++) oldLines.push(n % 7 === 0 ? 'repeated' : `unique ${n}`)
    const newLines = [...oldLines]
    for (let n = 100; n < 5000; n += 250) newLines[n] = `changed ${n}`
    const oldText = oldLines.join('\n') + '\n'
    const newText = newLines.join('\n') + '\n'
    const diff = diffLines(oldText, newText, 'a/big', 'b/big')
    expect(applyUnifiedDiff(oldText, diff)).toBe(newText)
  })
})

describe('isProbablyBinary', () => {
  it('flags a NUL byte within the first 8000 bytes', () => {
    expect(isProbablyBinary(Buffer.from([0x50, 0x4b, 0x00, 0x01]))).toBe(true)
  })

  it('accepts plain text (incl. unicode)', () => {
    expect(isProbablyBinary(Buffer.from('hello wörld\nsecond line\n', 'utf8'))).toBe(false)
    expect(isProbablyBinary(Buffer.alloc(0))).toBe(false)
  })

  it('ignores NUL bytes past the first 8000 bytes', () => {
    const buf = Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from([0x00])])
    expect(isProbablyBinary(buf)).toBe(false)
  })
})
