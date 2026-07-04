/**
 * Dependency-free line diff producing standard unified diffs (used for Code
 * mode change proposals). Histogram-style algorithm: trim common prefix and
 * suffix, then recursively split around the common line with the lowest
 * occurrence count. Adequate for files up to ~10k lines; always produces a
 * *correct* edit script (equal lines really are equal), possibly not the
 * minimal one for pathological inputs.
 */

interface LineOp {
  tag: ' ' | '-' | '+'
  line: string
}

const CONTEXT = 3

/** Split into lines, dropping the empty tail produced by a trailing newline. */
function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

interface Segment {
  aLo: number
  aHi: number
  bLo: number
  bHi: number
}

/**
 * Produces an ordered edit script. Iterative (explicit work stack) so deeply
 * fragmented files cannot overflow the call stack. Stack items are either a
 * segment still to diff or a block of already-resolved ops; pushing in reverse
 * order keeps the output in document order.
 */
function diffOps(a: string[], b: string[]): LineOp[] {
  const out: LineOp[] = []
  const stack: Array<Segment | LineOp[]> = [{ aLo: 0, aHi: a.length, bLo: 0, bHi: b.length }]

  while (stack.length > 0) {
    const item = stack.pop()!
    if (Array.isArray(item)) {
      for (const op of item) out.push(op)
      continue
    }
    let { aLo, aHi, bLo, bHi } = item

    // Common prefix goes straight to the output (everything before this
    // segment has already been emitted).
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
      out.push({ tag: ' ', line: a[aLo] })
      aLo++
      bLo++
    }
    // Common suffix is deferred: it must appear after the core of this segment.
    let aEnd = aHi
    let bEnd = bHi
    while (aEnd > aLo && bEnd > bLo && a[aEnd - 1] === b[bEnd - 1]) {
      aEnd--
      bEnd--
    }
    if (aEnd < aHi) {
      const suffix: LineOp[] = []
      for (let k = aEnd; k < aHi; k++) suffix.push({ tag: ' ', line: a[k] })
      stack.push(suffix)
    }
    aHi = aEnd
    bHi = bEnd

    if (aLo === aHi && bLo === bHi) continue
    if (aLo === aHi) {
      for (let i = bLo; i < bHi; i++) out.push({ tag: '+', line: b[i] })
      continue
    }
    if (bLo === bHi) {
      for (let i = aLo; i < aHi; i++) out.push({ tag: '-', line: a[i] })
      continue
    }

    // Histogram step: anchor on the common line with the lowest combined
    // occurrence count (unique lines win), then split around it.
    const countA = new Map<string, number>()
    const firstA = new Map<string, number>()
    for (let i = aLo; i < aHi; i++) {
      const line = a[i]
      countA.set(line, (countA.get(line) ?? 0) + 1)
      if (!firstA.has(line)) firstA.set(line, i)
    }
    const countB = new Map<string, number>()
    const firstB = new Map<string, number>()
    for (let i = bLo; i < bHi; i++) {
      const line = b[i]
      countB.set(line, (countB.get(line) ?? 0) + 1)
      if (!firstB.has(line)) firstB.set(line, i)
    }
    let best: { line: string; count: number; ai: number; bi: number } | null = null
    for (const [line, ca] of countA) {
      const cb = countB.get(line)
      if (cb === undefined) continue
      const count = ca + cb
      if (best === null || count < best.count) {
        best = { line, count, ai: firstA.get(line)!, bi: firstB.get(line)! }
      }
    }

    if (best === null) {
      // No common line at all: whole-block replacement.
      for (let i = aLo; i < aHi; i++) out.push({ tag: '-', line: a[i] })
      for (let i = bLo; i < bHi; i++) out.push({ tag: '+', line: b[i] })
      continue
    }

    // LIFO: push right part, then the anchor, then the left part, so the left
    // part is processed (and emitted) first.
    stack.push({ aLo: best.ai + 1, aHi, bLo: best.bi + 1, bHi })
    stack.push([{ tag: ' ', line: best.line }])
    stack.push({ aLo, aHi: best.ai, bLo, bHi: best.bi })
  }

  return out
}

/** Groups the edit script into @@ hunks with `CONTEXT` lines of context. */
function formatHunks(ops: LineOp[]): string[] {
  // Prefix sums: how many old/new lines are consumed by ops[0..i).
  const oldBefore = new Array<number>(ops.length + 1)
  const newBefore = new Array<number>(ops.length + 1)
  oldBefore[0] = 0
  newBefore[0] = 0
  for (let i = 0; i < ops.length; i++) {
    oldBefore[i + 1] = oldBefore[i] + (ops[i].tag !== '+' ? 1 : 0)
    newBefore[i + 1] = newBefore[i] + (ops[i].tag !== '-' ? 1 : 0)
  }

  const lines: string[] = []
  let i = 0
  while (i < ops.length) {
    if (ops[i].tag === ' ') {
      i++
      continue
    }
    // Extend the cluster: changes separated by at most 2*CONTEXT equal lines
    // share a hunk (their context regions would otherwise touch or overlap).
    let end = i + 1
    let gap = 0
    let j = end
    while (j < ops.length) {
      if (ops[j].tag === ' ') {
        gap++
        if (gap > CONTEXT * 2) break
        j++
      } else {
        end = j + 1
        gap = 0
        j++
      }
    }
    const start = Math.max(0, i - CONTEXT)
    const stop = Math.min(ops.length, end + CONTEXT)
    const aCount = oldBefore[stop] - oldBefore[start]
    const bCount = newBefore[stop] - newBefore[start]
    // Unified-diff convention: a zero-length range starts at the line *before*.
    const aStart = aCount === 0 ? oldBefore[start] : oldBefore[start] + 1
    const bStart = bCount === 0 ? newBefore[start] : newBefore[start] + 1
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`)
    for (let k = start; k < stop; k++) lines.push(ops[k].tag + ops[k].line)
    i = stop
  }
  return lines
}

/**
 * Standard unified diff of two texts ("\ No newline at end of file" markers
 * are intentionally not emitted). Returns '' when the line contents are
 * identical.
 */
export function diffLines(
  oldText: string,
  newText: string,
  oldLabel: string,
  newLabel: string
): string {
  const ops = diffOps(splitLines(oldText), splitLines(newText))
  const hunks = formatHunks(ops)
  if (hunks.length === 0) return ''
  return [`--- ${oldLabel}`, `+++ ${newLabel}`, ...hunks].join('\n') + '\n'
}

/** Heuristic used before showing file contents: a NUL byte in the first 8000 bytes. */
export function isProbablyBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0)
}
