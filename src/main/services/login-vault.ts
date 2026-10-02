/**
 * Credential vault (v53, dots "saved-password flows" / Muse vault): logins the
 * agent may use on a site without ever seeing the password. Metadata lives in
 * `browser_logins`; the password is encrypted with safeStorage into
 * tool_secrets (scope 'browser_login', owner = login id). The browser tool's
 * 'login' action asks the vault for the origin's login and main types it into
 * the page — the model only learns that a login was filled.
 *
 * A login is either shared (agent_id NULL — any agent, including ordinary
 * conversations) or scoped to one bot; a bot's own login wins over a shared
 * one for the same origin.
 */

import { randomUUID } from 'node:crypto'
import type { BrowserLogin, BrowserLoginInput } from '@shared/types'
import type { AppDatabase } from '../db/database'
import { originOf } from '../browser/sensitive'

export interface VaultKeystore {
  encryptKey(plain: string): { encryptedBase64: string; preview: string }
  decryptKey(stored: string): string
}

interface Row {
  id: string
  origin: string
  username: string
  label: string
  agent_id: string | null
  created_at: number
  updated_at: number
}

const SECRET_NAME = 'password'

function toLogin(row: Row): BrowserLogin {
  return {
    id: row.id,
    origin: row.origin,
    username: row.username,
    label: row.label,
    agentId: row.agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class LoginVault {
  constructor(
    private readonly db: AppDatabase,
    private readonly keystore: VaultKeystore
  ) {}

  list(): BrowserLogin[] {
    return this.db.driver
      .all<Row>('SELECT * FROM browser_logins ORDER BY origin, username')
      .map(toLogin)
  }

  save(input: BrowserLoginInput): BrowserLogin {
    const origin = originOf(input.origin)
    if (!origin) throw new Error('Enter the site as an http(s) address, e.g. https://example.com.')
    const username = input.username.trim()
    if (!username) throw new Error('A login needs a username or email.')
    if (!input.password) throw new Error('A login needs a password.')
    const agentId = input.agentId ?? null
    const existing = this.db.driver.get<Row>(
      'SELECT * FROM browser_logins WHERE origin = ? AND username = ? AND agent_id IS ?',
      [origin, username, agentId]
    )
    const now = Date.now()
    const id = existing?.id ?? randomUUID()
    const encrypted = this.keystore.encryptKey(input.password)
    this.db.driver.transaction(() => {
      if (existing) {
        this.db.driver.run('UPDATE browser_logins SET label = ?, updated_at = ? WHERE id = ?', [
          input.label?.trim() ?? existing.label,
          now,
          id,
        ])
      } else {
        this.db.driver.run(
          `INSERT INTO browser_logins (id, origin, username, label, agent_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, origin, username, input.label?.trim() ?? '', agentId, now, now]
        )
      }
      this.db.secrets.set('browser_login', id, SECRET_NAME, encrypted.encryptedBase64, '••••')
    })
    return toLogin(this.db.driver.get<Row>('SELECT * FROM browser_logins WHERE id = ?', [id])!)
  }

  remove(id: string): void {
    this.db.driver.transaction(() => {
      this.db.driver.run('DELETE FROM browser_logins WHERE id = ?', [id])
      this.db.secrets.deleteAllFor('browser_login', id)
    })
  }

  /** Drops a bot's own logins (profile deleted or reset). */
  removeForAgent(agentId: string): void {
    for (const row of this.db.driver.all<Row>('SELECT * FROM browser_logins WHERE agent_id = ?', [
      agentId,
    ])) {
      this.remove(row.id)
    }
  }

  /** Which saved usernames exist for an origin (no secrets) — for the model's hint. */
  usernamesFor(url: string, agentId: string | null): string[] {
    const origin = originOf(url)
    if (!origin) return []
    return this.candidates(origin, agentId).map((row) => row.username)
  }

  /**
   * The login to fill on `url` for this agent: its own first, then shared.
   * `username` picks one when several exist. Main-side only — the result
   * must never reach the model or the renderer.
   */
  resolve(
    url: string,
    agentId: string | null,
    username?: string | null
  ): { username: string; password: string } | null {
    const origin = originOf(url)
    if (!origin) return null
    const rows = this.candidates(origin, agentId)
    const wanted = username?.trim().toLowerCase()
    const row = wanted ? rows.find((r) => r.username.toLowerCase() === wanted) : rows[0]
    if (!row) return null
    const cipher = this.db.secrets.getCipher('browser_login', row.id, SECRET_NAME)
    if (!cipher) return null
    try {
      return { username: row.username, password: this.keystore.decryptKey(cipher.encryptedValue) }
    } catch {
      return null
    }
  }

  private candidates(origin: string, agentId: string | null): Row[] {
    const rows = this.db.driver.all<Row>(
      'SELECT * FROM browser_logins WHERE origin = ? AND (agent_id IS NULL OR agent_id = ?) ORDER BY updated_at DESC',
      [origin, agentId ?? '']
    )
    // A bot's own login outranks a shared one.
    return [...rows.filter((r) => r.agent_id !== null), ...rows.filter((r) => r.agent_id === null)]
  }
}
