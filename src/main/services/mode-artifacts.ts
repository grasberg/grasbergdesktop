/**
 * Parsers for the mode-specific artifact blocks assistants emit (formats are
 * instructed in prompts.ts): ```uld-change blocks in Code mode and ```uld-item
 * blocks in Cowork mode. Parsing is tolerant — malformed blocks are silently
 * skipped, never thrown on — and the message content itself is left untouched
 * (the renderer renders the blocks specially).
 */

import type { CodeChangeType, WorkspaceItemKind } from '@shared/types'

export interface ExtractedCodeChange {
  /** Relative path exactly as the model wrote it (validated by CodeService). */
  path: string
  type: CodeChangeType
  /** Complete new file content; '' for delete. */
  newContent: string
}

export interface ExtractedWorkspaceItem {
  kind: WorkspaceItemKind
  title: string
  /** Markdown body (trailing whitespace trimmed). */
  content: string
}

const CODE_CHANGE_TYPES: ReadonlySet<string> = new Set(['create', 'edit', 'delete'])
const WORKSPACE_ITEM_KINDS: ReadonlySet<string> = new Set([
  'note',
  'plan',
  'checklist',
  'doc',
  'task',
])

/**
 * Matches a fenced block whose opening fence is ```<tag> alone on its line and
 * whose closing ``` starts a line. Group 1 = everything between the fences
 * (header line + body, including the body's trailing newline).
 */
function blockRegex(tag: string): RegExp {
  return new RegExp('^```' + tag + '[ \\t]*\\r?\\n([\\s\\S]*?)^```[ \\t]*$', 'gm')
}

interface RawBlock {
  header: Record<string, unknown>
  body: string
}

/** Splits a block into its JSON header line and raw body; null when malformed. */
function parseRawBlocks(content: string, tag: string): RawBlock[] {
  const blocks: RawBlock[] = []
  const re = blockRegex(tag)
  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) {
    const inner = match[1]
    const newlineIdx = inner.indexOf('\n')
    const headerLine = (newlineIdx === -1 ? inner : inner.slice(0, newlineIdx)).trim()
    const body = newlineIdx === -1 ? '' : inner.slice(newlineIdx + 1)
    let header: unknown
    try {
      header = JSON.parse(headerLine)
    } catch {
      continue // malformed header — skip the block
    }
    if (typeof header !== 'object' || header === null || Array.isArray(header)) continue
    blocks.push({ header: header as Record<string, unknown>, body })
  }
  return blocks
}

/** Extracts ```uld-change blocks: {"path","type"} header + complete new content. */
export function extractCodeChanges(content: string): ExtractedCodeChange[] {
  const changes: ExtractedCodeChange[] = []
  for (const { header, body } of parseRawBlocks(content, 'uld-change')) {
    const path = header['path']
    const type = header['type']
    if (typeof path !== 'string' || path.trim().length === 0) continue
    if (typeof type !== 'string' || !CODE_CHANGE_TYPES.has(type)) continue
    changes.push({
      path: path.trim(),
      type: type as CodeChangeType,
      // File content is kept byte-for-byte (incl. trailing newline); deletes
      // carry no content.
      newContent: type === 'delete' ? '' : body,
    })
  }
  return changes
}

export interface ExtractedDocument {
  title: string
  /** Complete document content (Markdown for docs, HTML for prototypes). */
  content: string
}

/** Extracts the LAST ```uld-doc block: {"title"} header + full Markdown body. */
export function extractDocument(content: string): ExtractedDocument | null {
  const blocks = parseRawBlocks(content, 'uld-doc')
  const last = blocks[blocks.length - 1]
  if (!last) return null
  const title = last.header['title']
  return {
    title: typeof title === 'string' ? title.trim() : 'Document',
    content: last.body.trimEnd(),
  }
}

/** Extracts all ```uld-html prototype blocks: {"title"} header + full HTML body. */
export function extractHtmlArtifacts(content: string): ExtractedDocument[] {
  const out: ExtractedDocument[] = []
  for (const { header, body } of parseRawBlocks(content, 'uld-html')) {
    if (body.trim().length === 0) continue
    const title = header['title']
    out.push({
      title: typeof title === 'string' && title.trim() ? title.trim() : 'Prototype',
      content: body.trimEnd(),
    })
  }
  return out
}

/** Extracts ```uld-item blocks: {"kind","title"} header + markdown body. */
export function extractWorkspaceItems(content: string): ExtractedWorkspaceItem[] {
  const items: ExtractedWorkspaceItem[] = []
  for (const { header, body } of parseRawBlocks(content, 'uld-item')) {
    const kind = header['kind']
    const title = header['title']
    if (typeof kind !== 'string' || !WORKSPACE_ITEM_KINDS.has(kind)) continue
    if (typeof title !== 'string' || title.trim().length === 0) continue
    items.push({
      kind: kind as WorkspaceItemKind,
      title: title.trim(),
      content: body.trimEnd(),
    })
  }
  return items
}
