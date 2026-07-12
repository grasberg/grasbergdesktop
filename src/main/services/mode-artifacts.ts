/**
 * Parsers for the artifact blocks assistants emit (formats are instructed in
 * prompts.ts): ```uld-change and ```uld-item blocks in Work mode, and
 * mode-independent ```uld-memory blocks (assistant memories). Parsing is
 * tolerant — malformed blocks are silently skipped, never thrown on — and the
 * message content itself is left untouched (the renderer renders the blocks
 * specially).
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
  /** Optional task status from the header; set only when it is a valid value. */
  status?: 'todo' | 'doing' | 'done'
}

const CODE_CHANGE_TYPES: ReadonlySet<string> = new Set(['create', 'edit', 'delete'])
const WORKSPACE_ITEM_KINDS: ReadonlySet<string> = new Set([
  'note',
  'plan',
  'checklist',
  'doc',
  'task',
])

const WORKSPACE_ITEM_STATUSES: ReadonlySet<string> = new Set(['todo', 'doing', 'done'])

/** Any line that opens or closes a fence: group 1 = backticks, group 2 = info string. */
const FENCE_LINE = /^(`{3,})(.*)$/

interface RawBlock {
  header: Record<string, unknown>
  body: string
}

/**
 * Splits `content` into the fenced blocks tagged `tag`, each as its JSON header
 * line + raw body. Fences follow CommonMark: the opening fence is ```<tag>
 * alone on its line (four or more backticks are allowed) and only a fence at
 * least as long closes it, so a body containing its own ```lang code block —
 * an artifact's file content very often does — is passed through whole instead
 * of being cut at the nested block's bare closing fence. Unterminated and
 * malformed-header blocks are skipped.
 */
function parseRawBlocks(content: string, tag: string): RawBlock[] {
  const blocks: RawBlock[] = []
  const openRe = new RegExp('^(`{3,})' + tag + '[ \\t]*$')
  // Line starts, so a body can be sliced out of `content` byte-for-byte.
  const lines = content.split('\n')
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }

  for (let i = 0; i < lines.length; i++) {
    const open = openRe.exec(lines[i].replace(/\r$/, ''))
    if (!open) continue
    const fence = open[1].length

    // Scan for this block's closing fence, stepping over nested fenced blocks.
    let nested = 0
    let close = -1
    for (let j = i + 1; j < lines.length; j++) {
      const line = FENCE_LINE.exec(lines[j].replace(/\r$/, ''))
      if (!line) continue
      const ticks = line[1].length
      const info = line[2].trim()
      if (nested > 0) {
        if (info === '' && ticks >= nested) nested = 0
      } else if (info === '' && ticks >= fence) {
        close = j
        break
      } else if (info !== '' && !info.includes('`')) {
        nested = ticks
      }
    }
    if (close === -1) continue // unterminated — skip the block

    const headerLine = close > i + 1 ? lines[i + 1].trim() : ''
    const body = close > i + 1 ? content.slice(starts[i + 2], starts[close]) : ''
    i = close
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

export interface ExtractedMemoryDirective {
  action: 'remember' | 'forget'
  title: string
  /** Markdown body (trailing whitespace trimmed); '' for forget. */
  content: string
}

/**
 * Extracts ```uld-memory blocks: {"title","action"?} header + markdown body.
 * "action" defaults to 'remember'; unknown actions are skipped, as are
 * 'remember' directives with an empty body.
 */
export function extractMemoryDirectives(content: string): ExtractedMemoryDirective[] {
  const directives: ExtractedMemoryDirective[] = []
  for (const { header, body } of parseRawBlocks(content, 'uld-memory')) {
    const title = header['title']
    if (typeof title !== 'string' || title.trim().length === 0) continue
    const rawAction = header['action']
    let action: ExtractedMemoryDirective['action']
    if (rawAction === undefined || rawAction === 'remember') {
      action = 'remember'
    } else if (rawAction === 'forget') {
      action = 'forget'
    } else {
      continue // unknown action — skip the block
    }
    const text = body.trimEnd()
    if (action === 'remember' && text.trim().length === 0) continue
    directives.push({
      action,
      title: title.trim(),
      content: action === 'forget' ? '' : text,
    })
  }
  return directives
}

/** Extracts ```uld-item blocks: {"kind","title","status"?} header + markdown body. */
export function extractWorkspaceItems(content: string): ExtractedWorkspaceItem[] {
  const items: ExtractedWorkspaceItem[] = []
  for (const { header, body } of parseRawBlocks(content, 'uld-item')) {
    const kind = header['kind']
    const title = header['title']
    if (typeof kind !== 'string' || !WORKSPACE_ITEM_KINDS.has(kind)) continue
    if (typeof title !== 'string' || title.trim().length === 0) continue
    const item: ExtractedWorkspaceItem = {
      kind: kind as WorkspaceItemKind,
      title: title.trim(),
      content: body.trimEnd(),
    }
    // Optional status (tolerant like the rest of the parser: invalid → absent).
    const status = header['status']
    if (typeof status === 'string' && WORKSPACE_ITEM_STATUSES.has(status)) {
      item.status = status as ExtractedWorkspaceItem['status']
    }
    items.push(item)
  }
  return items
}
