/**
 * Notebooks (table `documents`, revived in v43): Home-level living Markdown
 * documents that both the user (Home Notes card) and the model (the
 * list/read/edit_document tools) edit. Rows carry kind 'doc' and a NULL
 * conversation_id; legacy conversation-scoped rows (and 'html' prototypes)
 * survive but are never listed here.
 *
 * Versioning lives in THIS module, not in its callers: every content-changing
 * update snapshots the previous content into `document_versions` first, and
 * revert snapshots the current content before restoring — so model edits,
 * manual UI edits and reverts are all undoable through the same code path.
 * Versions are capped at MAX_VERSIONS_PER_DOC per document (oldest pruned).
 */

import { randomUUID } from 'node:crypto'
import type {
  NotebookDoc,
  NotebookDocInput,
  NotebookDocPatch,
  NotebookDocSummary,
  NotebookDocVersion,
  NotebookDocVersionSummary,
} from '@shared/types'
import type { SqliteDriver } from '../driver'

export const MAX_VERSIONS_PER_DOC = 20

export interface DocumentsRepository {
  /** Notebook summaries (kind 'doc' only), updated_at DESC, without content. */
  list(): NotebookDocSummary[]
  getById(id: string): NotebookDoc | null
  /** Case-insensitive title lookup among notebooks (oldest wins on a tie). */
  findByTitle(title: string): NotebookDoc | null
  create(input: NotebookDocInput): NotebookDoc
  /** A changed content is snapshotted as a version before the write. */
  update(id: string, patch: NotebookDocPatch): NotebookDoc | null
  remove(id: string): void
  /** Version snapshots, newest first. */
  listVersions(documentId: string): NotebookDocVersion[]
  /** Same rows without content (the IPC/history-panel shape). */
  listVersionSummaries(documentId: string): NotebookDocVersionSummary[]
  /**
   * Restores a version's content (the version must belong to `documentId`,
   * else null). The pre-revert content is snapshotted as a new version first,
   * so a revert is itself undoable.
   */
  revert(documentId: string, versionId: number): NotebookDoc | null
}

interface DocumentRow {
  id: string
  conversation_id: string | null
  kind: string
  title: string
  content: string
  created_at: number
  updated_at: number
}

interface VersionRow {
  id: number
  document_id: string
  content: string
  created_at: number
}

function toDoc(row: DocumentRow): NotebookDoc {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    conversationId: row.conversation_id,
    kind: row.kind === 'html' ? 'html' : 'doc',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toVersion(row: VersionRow): NotebookDocVersion {
  return {
    id: row.id,
    documentId: row.document_id,
    content: row.content,
    createdAt: row.created_at,
  }
}

export function createDocumentsRepository(driver: SqliteDriver): DocumentsRepository {
  const getById = (id: string): NotebookDoc | null => {
    const row = driver.get<DocumentRow>('SELECT * FROM documents WHERE id = ?', [id])
    return row ? toDoc(row) : null
  }

  /** Inserts a snapshot of `content` and prunes past the per-doc cap. */
  const snapshot = (documentId: string, content: string): void => {
    driver.run(
      'INSERT INTO document_versions (document_id, content, created_at) VALUES (?, ?, ?)',
      [documentId, content, Date.now()]
    )
    driver.run(
      `DELETE FROM document_versions WHERE document_id = ? AND id NOT IN
         (SELECT id FROM document_versions WHERE document_id = ? ORDER BY id DESC LIMIT ?)`,
      [documentId, documentId, MAX_VERSIONS_PER_DOC]
    )
  }

  return {
    list() {
      const rows = driver.all<{
        id: string
        title: string
        content_length: number
        created_at: number
        updated_at: number
      }>(
        `SELECT id, title, length(content) AS content_length, created_at, updated_at
         FROM documents WHERE kind = 'doc' ORDER BY updated_at DESC`
      )
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        contentLength: row.content_length,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
    },

    getById,

    findByTitle(title) {
      const row = driver.get<DocumentRow>(
        `SELECT * FROM documents
         WHERE title = ? COLLATE NOCASE AND kind = 'doc'
         ORDER BY created_at ASC LIMIT 1`,
        [title]
      )
      return row ? toDoc(row) : null
    },

    create(input) {
      const now = Date.now()
      const doc: NotebookDoc = {
        id: randomUUID(),
        title: input.title,
        content: input.content ?? '',
        conversationId: null,
        kind: 'doc',
        createdAt: now,
        updatedAt: now,
      }
      driver.run(
        `INSERT INTO documents (id, conversation_id, kind, title, content, created_at, updated_at)
         VALUES (?, NULL, 'doc', ?, ?, ?, ?)`,
        [doc.id, doc.title, doc.content, now, now]
      )
      return doc
    },

    update(id, patch) {
      return driver.transaction(() => {
        const current = getById(id)
        if (!current) return null
        // The version insert and the content write must commit together —
        // hand-rolled UPDATE instead of the updateById util.
        if (patch.content !== undefined && patch.content !== current.content) {
          snapshot(id, current.content)
        }
        driver.run('UPDATE documents SET title = ?, content = ?, updated_at = ? WHERE id = ?', [
          patch.title ?? current.title,
          patch.content ?? current.content,
          Date.now(),
          id,
        ])
        return getById(id)
      })
    },

    remove(id) {
      // Versions cascade via the document_versions FK.
      driver.run('DELETE FROM documents WHERE id = ?', [id])
    },

    listVersions(documentId) {
      const rows = driver.all<VersionRow>(
        'SELECT * FROM document_versions WHERE document_id = ? ORDER BY id DESC',
        [documentId]
      )
      return rows.map(toVersion)
    },

    listVersionSummaries(documentId) {
      const rows = driver.all<{
        id: number
        document_id: string
        content_length: number
        created_at: number
      }>(
        `SELECT id, document_id, length(content) AS content_length, created_at
         FROM document_versions WHERE document_id = ? ORDER BY id DESC`,
        [documentId]
      )
      return rows.map((row) => ({
        id: row.id,
        documentId: row.document_id,
        contentLength: row.content_length,
        createdAt: row.created_at,
      }))
    },

    revert(documentId, versionId) {
      return driver.transaction(() => {
        const current = getById(documentId)
        if (!current) return null
        // Scoping to the document doubles as an ownership check: a versionId
        // from another notebook is simply "not found".
        const version = driver.get<VersionRow>(
          'SELECT * FROM document_versions WHERE id = ? AND document_id = ?',
          [versionId, documentId]
        )
        if (!version) return null
        if (version.content !== current.content) snapshot(documentId, current.content)
        driver.run('UPDATE documents SET content = ?, updated_at = ? WHERE id = ?', [
          version.content,
          Date.now(),
          documentId,
        ])
        return getById(documentId)
      })
    },
  }
}
