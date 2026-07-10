/**
 * Code mode file operations: project registration (from the OS folder picker),
 * file tree, safe read-only file access, and the proposed-change lifecycle.
 *
 * SAFETY INVARIANT: applyChange() is the ONLY place in the entire app that
 * writes into a user project. It is reachable from exactly two user-approved
 * paths: the code:changes:apply IPC channel (an explicit click on a proposed
 * change) and the edit_file/write_file tools (whose every call the user
 * approves in the tool-approval dialog before the executor may run it).
 * Everything else here is read-only. Every path from the model or the
 * database is re-validated against the project root before any fs call.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { CodeChange, CodeProject, FileTreeNode } from '@shared/types'
import type { CodeChangeWithContext, CodeReadFileResult } from '@shared/ipc'
import type { AppDatabase } from '../db/database'
import { ProviderError } from '../providers/errors'
import { diffLines, isProbablyBinary } from '../utils/diff'
import { extractCodeChanges } from '../services/mode-artifacts'

/** Directories never shown in the file tree (dependency/build output noise). */
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'release',
  'build',
  'coverage',
  '.next',
  '.venv',
  '__pycache__',
  'target',
])

const MAX_TREE_DEPTH = 8
const MAX_TREE_ENTRIES = 2000
const MAX_READ_BYTES = 256 * 1024
/** Old-side cap when computing diffs; larger files diff against empty. */
const MAX_DIFF_SOURCE_BYTES = 2 * 1024 * 1024

function invalid(message: string): ProviderError {
  return new ProviderError('invalid_request', message)
}

/** Normalizes a validated relative path to forward slashes for storage/display. */
function normalizeRel(relPath: string): string {
  return relPath
    .trim()
    .split(/[\\/]+/)
    .filter((seg) => seg.length > 0 && seg !== '.')
    .join('/')
}

export class CodeService {
  constructor(
    private readonly db: AppDatabase,
    /**
     * Called with the projectId whenever a change row is created or changes
     * status, so every window's review queue can refresh live — including for
     * changes proposed by OTHER conversations or background work. Best-effort.
     */
    private readonly onChangesChanged?: (projectId: string) => void
  ) {}

  /** Best-effort review-queue nudge; a broken renderer must never break IO. */
  private notifyChanges(projectId: string): void {
    try {
      this.onChangesChanged?.(projectId)
    } catch {
      // Broadcast failures are cosmetic.
    }
  }

  /**
   * Project-wide changes with their conversation titles — the cross-
   * conversation review queue ("All chats" scope in the Changes panel).
   */
  listChangesWithContext(projectId: string): CodeChangeWithContext[] {
    const titles = new Map<string, string | null>()
    return this.db.code.changesList(projectId).map((change) => {
      if (change.conversationId && !titles.has(change.conversationId)) {
        titles.set(
          change.conversationId,
          this.db.conversations.getById(change.conversationId)?.title ?? null
        )
      }
      return {
        ...change,
        conversationTitle: change.conversationId
          ? (titles.get(change.conversationId) ?? null)
          : null,
      }
    })
  }

  /**
   * Registers a project folder. The path always comes from the OS folder
   * picker, which constitutes the user's explicit read grant.
   */
  openProject(projectPath: string): CodeProject {
    const trimmed = projectPath.trim()
    if (trimmed.length === 0 || !isAbsolute(trimmed)) {
      throw invalid('Project path must be an absolute path.')
    }
    const root = resolve(trimmed)
    let stat
    try {
      stat = statSync(root)
    } catch {
      throw invalid('Folder not found — pick an existing folder.')
    }
    if (!stat.isDirectory()) {
      throw invalid('The selected path is not a folder.')
    }
    const name = basename(root) || root
    return this.db.code.projectUpsertByPath(root, name)
  }

  /**
   * Walks the project root: dirs first, alphabetical, ignoring dependency and
   * build directories, max depth 8, max 2000 entries (the walk just stops).
   * Symlinks are skipped entirely so the tree can never leave the root.
   */
  fileTree(projectId: string): FileTreeNode {
    const project = this.requireProject(projectId)
    const root = resolve(project.path)
    try {
      if (!statSync(root).isDirectory()) throw new Error('not a directory')
    } catch {
      throw invalid('The project folder no longer exists.')
    }
    const rootNode: FileTreeNode = { name: project.name, relPath: '', type: 'dir', children: [] }
    const budget = { remaining: MAX_TREE_ENTRIES }
    this.walk(root, '', rootNode, 0, budget)
    return rootNode
  }

  /** Read-only, root-jailed, text-only (binary rejected), capped at 256 KB. */
  readFile(projectId: string, relPath: string): CodeReadFileResult {
    const project = this.requireProject(projectId)
    const abs = this.resolveInsideRoot(project.path, relPath)
    // SECURITY: canonicalize with realpath and re-assert containment so an
    // in-project symlink cannot be followed out of the root. statSync alone
    // follows links and would leak the target.
    const real = this.realInsideRoot(project.path, abs)
    const stat = statSync(real)
    if (!stat.isFile()) throw invalid('Not a file.')

    const bytesToRead = Math.min(stat.size, MAX_READ_BYTES)
    const buf = Buffer.alloc(bytesToRead)
    const fd = openSync(real, 'r')
    try {
      readSync(fd, buf, 0, bytesToRead, 0)
    } finally {
      closeSync(fd)
    }
    if (isProbablyBinary(buf)) throw invalid('Binary file')

    return {
      relPath: normalizeRel(relPath),
      content: buf.toString('utf8'),
      truncated: stat.size > MAX_READ_BYTES,
      sizeBytes: stat.size,
    }
  }

  /**
   * Parses uld-change blocks from a completed assistant message and stores
   * them as 'proposed' CodeChange rows (with display diffs). Nothing touches
   * the disk here; paths escaping the project root are silently skipped.
   */
  registerProposedChanges(conversationId: string, assistantContent: string): CodeChange[] {
    const conversation = this.db.conversations.getById(conversationId)
    if (!conversation || !conversation.projectId) return []
    const project = this.db.code.projectGetById(conversation.projectId)
    if (!project) return []

    const created: CodeChange[] = []
    for (const change of extractCodeChanges(assistantContent)) {
      let abs: string
      try {
        abs = this.resolveInsideRoot(project.path, change.path)
      } catch {
        continue // path escapes the root (or is malformed) — never propose it
      }
      created.push(
        this.createProposedChange(
          project.id,
          conversationId,
          abs,
          normalizeRel(change.path),
          change.type,
          change.newContent
        )
      )
    }
    return created
  }

  /**
   * Creates ONE proposed CodeChange row for the edit_file/write_file tools
   * (same diff + staleness baseline as uld-change parsing). Nothing touches
   * the disk here; invalid/escaping paths throw instead of being skipped so
   * the tool can report the error.
   */
  proposeChange(
    conversationId: string,
    relPath: string,
    changeType: 'create' | 'edit',
    newContent: string
  ): CodeChange {
    const conversation = this.db.conversations.getById(conversationId)
    if (!conversation || !conversation.projectId) {
      throw invalid('This conversation has no granted project.')
    }
    const project = this.db.code.projectGetById(conversation.projectId)
    if (!project) throw invalid('Project not found.')

    const abs = this.resolveInsideRoot(project.path, relPath)
    return this.createProposedChange(
      project.id,
      conversationId,
      abs,
      normalizeRel(relPath),
      changeType,
      newContent
    )
  }

  /**
   * Applies a proposed change to disk. THE ONLY WRITE PATH INTO A PROJECT —
   * reached from the code:changes:apply IPC (explicit user click) and from
   * the approval-gated edit_file/write_file tools.
   */
  applyChange(changeId: string): CodeChange {
    const change = this.requireChange(changeId)
    if (change.status !== 'proposed') {
      throw invalid('Only proposed changes can be applied.')
    }
    const project = this.db.code.projectGetById(change.projectId)
    if (!project) throw invalid('Project not found.')
    // SECURITY: re-validate the stored path against the root before writing.
    const abs = this.resolveInsideRoot(project.path, change.filePath)

    switch (change.changeType) {
      case 'create': {
        if (change.newContent === null) throw invalid('This change has no content to write.')
        mkdirSync(dirname(abs), { recursive: true })
        // SECURITY: after mkdir, canonicalize the parent dir and re-assert
        // containment so a symlinked directory cannot redirect the write out
        // of the project root.
        const realDir = this.realInsideRoot(project.path, dirname(abs))
        const target = join(realDir, basename(abs))
        if (existsSync(target)) {
          // A file already exists where we meant to create — canonicalize it
          // (rejects a symlink escape) and require it match the proposal
          // baseline, otherwise the assistant's create is stale.
          const realTarget = this.realInsideRoot(project.path, target)
          this.assertNotStale(change, realTarget)
          writeFileSync(realTarget, change.newContent, 'utf8')
        } else {
          writeFileSync(target, change.newContent, 'utf8')
        }
        break
      }
      case 'edit': {
        if (change.newContent === null) throw invalid('This change has no content to write.')
        const real = this.realInsideRoot(project.path, abs)
        this.assertNotStale(change, real)
        writeFileSync(real, change.newContent, 'utf8')
        break
      }
      case 'delete': {
        const real = this.realInsideRoot(project.path, abs)
        this.assertNotStale(change, real)
        unlinkSync(real)
        break
      }
    }

    const updated = this.db.code.changeSetStatus(changeId, 'applied')
    if (!updated) throw invalid('Change not found.')
    this.notifyChanges(updated.projectId)
    return updated
  }

  rejectChange(changeId: string): CodeChange {
    const change = this.requireChange(changeId)
    if (change.status !== 'proposed') {
      throw invalid('Only proposed changes can be rejected.')
    }
    const updated = this.db.code.changeSetStatus(changeId, 'rejected')
    if (!updated) throw invalid('Change not found.')
    this.notifyChanges(updated.projectId)
    return updated
  }

  /**
   * Restores the pre-change content of an APPLIED change (the in-app "undo").
   * Reached only from the code:changes:revert IPC — an explicit user click.
   * Refuses when the file has diverged from the change's own after-content,
   * so a revert can never clobber later edits (by the user or a later change).
   */
  revertChange(changeId: string): CodeChange {
    const change = this.requireChange(changeId)
    if (change.status !== 'applied') {
      throw invalid('Only applied changes can be reverted.')
    }
    const project = this.db.code.projectGetById(change.projectId)
    if (!project) throw invalid('Project not found.')
    // SECURITY: re-validate the stored path against the root before writing.
    const abs = this.resolveInsideRoot(project.path, change.filePath)

    switch (change.changeType) {
      case 'create':
      case 'edit': {
        const real = this.realInsideRoot(project.path, abs)
        const current = this.readCurrentText(real)
        if (current === null || current !== (change.newContent ?? '')) {
          throw invalid(
            'The file changed on disk after this change was applied; revert it manually.'
          )
        }
        if (change.changeType === 'create' && (change.oldContent ?? '') === '') {
          // The change created this file: reverting removes it again.
          unlinkSync(real)
        } else {
          if (change.oldContent === null || change.oldContent === undefined) {
            throw invalid('No pre-change content was captured for this change.')
          }
          writeFileSync(real, change.oldContent, 'utf8')
        }
        break
      }
      case 'delete': {
        if (change.oldContent === null || change.oldContent === undefined) {
          throw invalid('No pre-change content was captured for this change.')
        }
        if (existsSync(abs)) {
          throw invalid('A file already exists at this path; revert it manually.')
        }
        mkdirSync(dirname(abs), { recursive: true })
        const realDir = this.realInsideRoot(project.path, dirname(abs))
        writeFileSync(join(realDir, basename(abs)), change.oldContent, 'utf8')
        break
      }
    }

    const updated = this.db.code.changeSetStatus(changeId, 'reverted')
    if (!updated) throw invalid('Change not found.')
    this.notifyChanges(updated.projectId)
    return updated
  }

  /**
   * Relative-path suggestions for @-file mentions in the composer: files whose
   * path contains `query` (case-insensitive), basename matches first. Reuses
   * the file-tree walk, so the same ignore rules and caps apply.
   */
  suggestFiles(projectId: string, query: string, limit: number): string[] {
    const needle = query.trim().toLowerCase()
    const max = Math.min(Math.max(limit, 1), 50)
    const files: string[] = []
    const collect = (node: FileTreeNode): void => {
      if (node.type === 'file') files.push(node.relPath)
      for (const child of node.children ?? []) collect(child)
    }
    collect(this.fileTree(projectId))
    const matches = needle
      ? files.filter((relPath) => relPath.toLowerCase().includes(needle))
      : files
    const basenameOf = (relPath: string): string => relPath.slice(relPath.lastIndexOf('/') + 1)
    return matches
      .sort((a, b) => {
        const aBase = basenameOf(a).toLowerCase().startsWith(needle)
        const bBase = basenameOf(b).toLowerCase().startsWith(needle)
        if (aBase !== bBase) return aBase ? -1 : 1
        if (a.length !== b.length) return a.length - b.length
        return a < b ? -1 : a > b ? 1 : 0
      })
      .slice(0, max)
  }

  // -- internals --------------------------------------------------------------

  private requireProject(projectId: string): CodeProject {
    const project = this.db.code.projectGetById(projectId)
    if (!project) throw invalid('Project not found.')
    return project
  }

  private requireChange(changeId: string): CodeChange {
    const change = this.db.code.changeGet(changeId)
    if (!change) throw invalid('Change not found.')
    return change
  }

  /**
   * Builds and stores one 'proposed' CodeChange row. Captures the current file
   * content as the staleness baseline ('' for create; null when we cannot read
   * it — binary/oversized/unreadable — in which case staleness cannot be
   * verified at apply time) and computes the display diff. `abs` must already
   * be validated inside the project root by the caller, which also owns the
   * error policy (skip vs throw) for invalid paths.
   */
  private createProposedChange(
    projectId: string,
    conversationId: string,
    abs: string,
    rel: string,
    changeType: CodeChange['changeType'],
    proposedContent: string
  ): CodeChange {
    const oldContent: string | null = changeType === 'create' ? '' : this.readCurrentText(abs)
    const newContent = changeType === 'delete' ? null : proposedContent
    const diff = diffLines(
      oldContent ?? '',
      newContent ?? '',
      changeType === 'create' ? '/dev/null' : `a/${rel}`,
      changeType === 'delete' ? '/dev/null' : `b/${rel}`
    )
    const created = this.db.code.changeCreate({
      projectId,
      conversationId,
      filePath: rel,
      changeType,
      diff,
      newContent,
      oldContent,
    })
    this.notifyChanges(projectId)
    return created
  }

  /**
   * SECURITY: resolves `relPath` against the project root and rejects anything
   * that could escape it — absolute paths (POSIX or drive-letter/UNC), any
   * '..' segment, and resolved paths outside `root + sep`.
   */
  private resolveInsideRoot(rootPath: string, relPath: string): string {
    const rel = relPath.trim()
    if (rel.length === 0) throw invalid('File path is required.')
    if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\')) {
      throw invalid('File path must be relative to the project root.')
    }
    if (rel.split(/[\\/]+/).includes('..')) {
      throw invalid('File path must not contain "..".')
    }
    const root = resolve(rootPath)
    const abs = resolve(root, rel)
    const prefix = root.endsWith(sep) ? root : root + sep
    if (!abs.startsWith(prefix)) {
      throw invalid('File path escapes the project root.')
    }
    return abs
  }

  /**
   * SECURITY: canonicalizes `abs` with realpath (resolving every symlink) and
   * re-asserts it stays inside the project root. Defeats in-project symlinks
   * that point outside the root. Throws invalid_request on a missing path or
   * an escape. Returns the real, root-contained absolute path.
   */
  private realInsideRoot(rootPath: string, abs: string): string {
    let real: string
    try {
      real = realpathSync.native(abs)
    } catch {
      throw invalid('File not found.')
    }
    let realRoot: string
    try {
      realRoot = realpathSync.native(resolve(rootPath))
    } catch {
      throw invalid('The project folder no longer exists.')
    }
    const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep
    if (real !== realRoot && !real.startsWith(prefix)) {
      throw invalid('File path escapes the project root.')
    }
    return real
  }

  /** Reads a file's current text, or null when missing/binary/oversized. */
  private readCurrentText(abs: string): string | null {
    try {
      const stat = statSync(abs)
      if (!stat.isFile() || stat.size > MAX_DIFF_SOURCE_BYTES) return null
      const raw = readFileSync(abs)
      if (isProbablyBinary(raw)) return null
      return raw.toString('utf8')
    } catch {
      return null
    }
  }

  /**
   * Rejects applying a change whose on-disk file diverged from the content
   * captured when the change was proposed. Skipped when no baseline was
   * captured (null) or the current content can't be read as text.
   */
  private assertNotStale(change: CodeChange, abs: string): void {
    if (change.oldContent === null || change.oldContent === undefined) return
    const current = this.readCurrentText(abs)
    if (current === null) return
    if (current !== change.oldContent) {
      throw invalid(
        'File changed on disk since this change was proposed; re-ask the assistant to regenerate.'
      )
    }
  }

  private walk(
    absDir: string,
    relDir: string,
    node: FileTreeNode,
    depth: number,
    budget: { remaining: number }
  ): void {
    if (depth >= MAX_TREE_DEPTH) return
    let entries
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
    } catch {
      return // unreadable directory — show it empty rather than fail the tree
    }
    // Deterministic, locale-independent, case-insensitive alphabetical order.
    const byName = (x: { name: string }, y: { name: string }): number => {
      const a = x.name.toLowerCase()
      const b = y.name.toLowerCase()
      if (a !== b) return a < b ? -1 : 1
      return x.name < y.name ? -1 : x.name > y.name ? 1 : 0
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name))
      .sort(byName)
    const files = entries.filter((e) => e.isFile()).sort(byName)

    for (const dir of dirs) {
      if (budget.remaining <= 0) return
      budget.remaining--
      const child: FileTreeNode = {
        name: dir.name,
        relPath: relDir ? `${relDir}/${dir.name}` : dir.name,
        type: 'dir',
        children: [],
      }
      node.children!.push(child)
      this.walk(join(absDir, dir.name), child.relPath, child, depth + 1, budget)
    }
    for (const file of files) {
      if (budget.remaining <= 0) return
      budget.remaining--
      const child: FileTreeNode = {
        name: file.name,
        relPath: relDir ? `${relDir}/${file.name}` : file.name,
        type: 'file',
      }
      try {
        child.sizeBytes = statSync(join(absDir, file.name)).size
      } catch {
        // size is cosmetic — leave it undefined when stat fails
      }
      node.children!.push(child)
    }
  }
}
