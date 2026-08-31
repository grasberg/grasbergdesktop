/**
 * Pure text helpers for read-aloud (no DOM types, no runtime deps) — kept in
 * shared so the renderer voice store and plain-Node unit tests agree.
 */

/**
 * Splits a growing buffer into completed sentences + the unfinished rest, so
 * streaming deltas can be spoken as they complete. A sentence ends at
 * [.!?…]+ followed by whitespace, or at a blank line.
 */
export function splitSentences(buffer: string): { complete: string[]; rest: string } {
  const complete: string[] = []
  let rest = buffer
  const pattern = /([^\n]*?[.!?…]+)(?=\s)|([^\n]+?)(?=\n\s*\n)/
  for (;;) {
    const match = pattern.exec(rest)
    if (!match) break
    const sentence = (match[1] ?? match[2] ?? '').trim()
    const end = match.index + match[0].length
    if (end === 0) break
    if (sentence.length >= 2) complete.push(sentence)
    rest = rest.slice(end).replace(/^\s+/, '')
  }
  return { complete, rest }
}

/** Markdown → speakable plain text (code blocks omitted, syntax stripped). */
export function speakableText(md: string): string {
  return (
    md
      // Fenced code blocks are noise when spoken.
      .replace(/```[\s\S]*?(?:```|$)/g, ' code block omitted. ')
      .replace(/`([^`]*)`/g, '$1')
      // Links/images keep their text.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/(\*\*|__|\*|_|~~)/g, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/[ \t]+/g, ' ')
      .trim()
  )
}

/**
 * Consumes the speakable sentences of a growing raw-Markdown buffer from
 * `offset` (an index into the RAW buffer). Fence-aware: a multi-line ```
 * block is spoken as one 'code block omitted.' — an unclosed fence is held
 * back until its closing fence (or the final flush) arrives — fixing the
 * split-raw-then-transform order that spoke code lines aloud.
 */
export function consumeSpeakable(
  buffer: string,
  offset: number,
  final: boolean
): { sentences: string[]; offset: number } {
  const sentences: string[] = []
  const push = (text: string): void => {
    const spoken = speakableText(text)
    if (spoken.trim().length > 0) sentences.push(spoken)
  }
  for (;;) {
    const pending = buffer.slice(offset)
    const open = pending.indexOf('```')
    if (open === -1) {
      const { complete, rest } = splitSentences(pending)
      for (const sentence of complete) push(sentence)
      offset += pending.length - rest.length
      if (final) {
        if (rest.trim()) push(rest)
        offset += rest.length
      }
      return { sentences, offset }
    }
    // Everything before the fence: completed sentences, plus the unfinished
    // tail — the fence ends that flow either way.
    const before = splitSentences(pending.slice(0, open))
    for (const sentence of before.complete) push(sentence)
    if (before.rest.trim()) push(before.rest)
    const close = pending.indexOf('```', open + 3)
    if (close === -1) {
      if (!final) {
        // Unclosed fence mid-stream: hold it back until it closes.
        return { sentences, offset: offset + open }
      }
      sentences.push('code block omitted.')
      return { sentences, offset: offset + pending.length }
    }
    sentences.push('code block omitted.')
    offset += close + 3
  }
}
