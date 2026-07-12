/**
 * Per-task workspace folders for Work mode. A Work conversation without a
 * user-granted folder gets `{baseDir}/<conversationId>/` created lazily on its
 * first file write; the folder is registered as a code_projects row (so the
 * entire existing pipeline — tree, changes, path jail, git — works on it
 * unchanged) and linked via conversation.projectId.
 *
 * Auto workspaces are app-owned: they are the ONLY folders this service ever
 * deletes. User-granted folders are recognized by not being under baseDir and
 * are never touched.
 */

import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { CodeProject, Conversation } from '@shared/types'
import type { AppDatabase } from '../db/database'

export interface WorkspaceRoot {
  projectId: string
  root: string
}

export class WorkspaceRootService {
  private readonly base: string

  constructor(
    private readonly db: AppDatabase,
    baseDir: string
  ) {
    this.base = resolve(baseDir)
  }

  /** True when `path` is the workspaces base or lies inside it. */
  isAutoPath(path: string): boolean {
    const resolved = resolve(path)
    return resolved === this.base || resolved.startsWith(this.base + sep)
  }

  /**
   * Returns the conversation's working folder, creating and linking the
   * per-task workspace when none is set. Idempotent: an existing valid
   * projectId is returned as-is; a leftover dir from a previous install is
   * re-adopted via the path upsert.
   */
  ensure(conversationId: string): WorkspaceRoot {
    const conversation = this.db.conversations.getById(conversationId)
    if (!conversation) throw new Error('Conversation not found.')
    if (conversation.projectId) {
      const existing = this.db.code.projectGetById(conversation.projectId)
      if (existing) return { projectId: existing.id, root: existing.path }
    }
    // SECURITY: a conversation id can come from an imported backup, where it is
    // attacker-controlled — a traversal segment must never place the workspace
    // outside the app-owned base.
    const dir = resolve(join(this.base, conversationId))
    if (dir === this.base || !this.isAutoPath(dir)) {
      throw new Error('Invalid conversation id for a task workspace.')
    }
    mkdirSync(dir, { recursive: true })
    const project = this.db.code.projectUpsertByPath(
      dir,
      conversation.title.trim() || 'Task workspace'
    )
    this.db.conversations.update(conversationId, { projectId: project.id })
    return { projectId: project.id, root: project.path }
  }

  /**
   * Removes the conversation's workspace folder and its project row — ONLY
   * when the linked folder is an auto-created workspace. User-granted folders
   * are left untouched. Rows go first and synchronously (so a caller that does
   * not await still sees a consistent db); the dir removal runs off the main
   * thread and is best-effort (an open handle on Windows leaves an orphan
   * swept later by deleteAll).
   */
  async deleteIfAutoRegistered(conversation: Conversation): Promise<void> {
    if (!conversation.projectId) return
    const project = this.db.code.projectGetById(conversation.projectId)
    if (!project || !this.isAutoPath(project.path)) return
    // Cascades the project's code_changes rows via FK.
    this.db.code.projectForget(project.id)
    await this.removeDir(project.path)
  }

  /** Removes every auto workspace (rows + dirs). Used by data:deleteAllContent. */
  async deleteAll(): Promise<void> {
    const autos = this.db.code.projectsList().filter((project) => this.isAutoPath(project.path))
    for (const project of autos) this.db.code.projectForget(project.id)
    for (const project of autos) await this.removeDir(project.path)
    await this.removeDir(this.base)
  }

  /**
   * Recursive delete on the libuv threadpool — an auto workspace can hold a
   * node_modules tree, and a synchronous rm would freeze the whole main
   * process (every window, stream and IPC call) until it finished.
   */
  private async removeDir(path: string): Promise<void> {
    try {
      await rm(path, { recursive: true, force: true })
    } catch {
      // Best-effort: the rows are already gone; an orphan dir is harmless.
    }
  }

  /** Derives the transient autoCreated flag for renderer-bound project rows. */
  withAutoFlag(project: CodeProject): CodeProject {
    return { ...project, autoCreated: this.isAutoPath(project.path) }
  }
}
