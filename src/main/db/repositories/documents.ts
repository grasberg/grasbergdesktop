/**
 * Write-mode documents and Design-mode HTML prototypes (migration v9).
 * Each conversation has at most one 'doc' (the Write document) and any number
 * of 'html' prototypes (Design mode).
 */

import { randomUUID } from 'node:crypto'
import type { Document, DocumentKind } from '@shared/types'
import type { SqliteDriver } from '../driver'

export interface DocumentsRepository {
  listByConversation(conversationId: string, kind?: DocumentKind): Document[]
  getById(id: string): Document | null
  /** The single 'doc' for a conversation (Write mode), or null. */
  getDoc(conversationId: string): Document | null
  /**
   * Create or replace the conversation's 'doc' content/title. An omitted
   * title keeps the existing one ('Document' when the row doesn't exist yet).
   */
  upsertDoc(conversationId: string, title: string | undefined, content: string): Document
  /** Append an 'html' prototype (Design mode). */
  addHtml(conversationId: string, title: string, content: string): Document
  /** Update a document's content (user edit). */
  saveContent(id: string, content: string): Document | null
}

interface DocumentRow {
  id: string
  conversation_id: string
  kind: string
  title: string
  content: string
  created_at: number
  updated_at: number
}

function toRecord(row: DocumentRow): Document {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    kind: row.kind as DocumentKind,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createDocumentsRepository(driver: SqliteDriver): DocumentsRepository {
  const getById = (id: string): Document | null => {
    const row = driver.get<DocumentRow>('SELECT * FROM documents WHERE id = ?', [id])
    return row ? toRecord(row) : null
  }
  const getDoc = (conversationId: string): Document | null => {
    const row = driver.get<DocumentRow>(
      "SELECT * FROM documents WHERE conversation_id = ? AND kind = 'doc' ORDER BY created_at ASC LIMIT 1",
      [conversationId]
    )
    return row ? toRecord(row) : null
  }
  const insert = (conversationId: string, kind: DocumentKind, title: string, content: string): Document => {
    const now = Date.now()
    const record: Document = {
      id: randomUUID(),
      conversationId,
      kind,
      title,
      content,
      createdAt: now,
      updatedAt: now,
    }
    driver.run(
      `INSERT INTO documents (id, conversation_id, kind, title, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [record.id, conversationId, kind, title, content, now, now]
    )
    return record
  }

  return {
    listByConversation(conversationId, kind) {
      const rows = kind
        ? driver.all<DocumentRow>(
            'SELECT * FROM documents WHERE conversation_id = ? AND kind = ? ORDER BY updated_at DESC',
            [conversationId, kind]
          )
        : driver.all<DocumentRow>(
            'SELECT * FROM documents WHERE conversation_id = ? ORDER BY updated_at DESC',
            [conversationId]
          )
      return rows.map(toRecord)
    },

    getById,
    getDoc,

    upsertDoc(conversationId, title, content) {
      const existing = getDoc(conversationId)
      if (existing) {
        driver.run('UPDATE documents SET title = ?, content = ?, updated_at = ? WHERE id = ?', [
          title ?? existing.title,
          content,
          Date.now(),
          existing.id,
        ])
        return getById(existing.id)!
      }
      return insert(conversationId, 'doc', title ?? 'Document', content)
    },

    addHtml(conversationId, title, content) {
      return insert(conversationId, 'html', title, content)
    },

    saveContent(id, content) {
      driver.run('UPDATE documents SET content = ?, updated_at = ? WHERE id = ?', [
        content,
        Date.now(),
        id,
      ])
      return getById(id)
    },
  }
}
