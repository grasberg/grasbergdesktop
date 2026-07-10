/**
 * Deep Research citation helpers, shared by main (Sources section appended to
 * the persisted report) and the renderer (linkifying [n] markers at render
 * time). Pure string functions — no runtime deps, unit-tested in isolation.
 */

import type { ResearchSource } from './types'

/**
 * Splits markdown into alternating segments outside/inside code, so
 * transformations can skip fenced blocks (``` … ```) and inline spans (`…`).
 */
function splitByCode(content: string): Array<{ text: string; code: boolean }> {
  const segments: Array<{ text: string; code: boolean }> = []
  const re = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g
  let last = 0
  for (let match = re.exec(content); match !== null; match = re.exec(content)) {
    if (match.index > last) segments.push({ text: content.slice(last, match.index), code: false })
    segments.push({ text: match[0], code: true })
    last = match.index + match[0].length
  }
  if (last < content.length) segments.push({ text: content.slice(last), code: false })
  return segments
}

/**
 * Replaces bare [n] citation markers with markdown links to their source URL
 * ("[1]" -> "[[1]](https://…)"), so the renderer's anchor override can style
 * them as chips. Skips code fences/inline code, markers already followed by a
 * link "(" and ids without a matching source (left as plain text).
 */
export function linkifyCitations(content: string, sources: ResearchSource[]): string {
  if (sources.length === 0) return content
  const byId = new Map(sources.map((s) => [s.id, s]))
  return splitByCode(content)
    .map((segment) => {
      if (segment.code) return segment.text
      return segment.text.replace(/\[(\d{1,3})\](?!\()/g, (marker, digits: string) => {
        const source = byId.get(Number(digits))
        return source ? `[[${digits}]](${source.url})` : marker
      })
    })
    .join('')
}

/**
 * Deterministic "## Sources" markdown section built from the app-collected
 * registry (never from model output). Appended to the report content in main
 * so exports, the Telegram bridge and webhooks carry the sources verbatim.
 */
export function formatSourcesSection(sources: ResearchSource[]): string {
  const lines = sources.map((s) => {
    const label = s.title.trim().length > 0 ? s.title.trim() : s.url
    return `${s.id}. [${escapeLinkText(label)}](${s.url})`
  })
  return `## Sources\n\n${lines.join('\n')}`
}

/** Keeps a title from breaking the enclosing markdown link syntax. */
function escapeLinkText(text: string): string {
  return text.replace(/\[/g, '(').replace(/\]/g, ')').replace(/\n+/g, ' ')
}
