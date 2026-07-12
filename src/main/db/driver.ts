/**
 * Thin synchronous wrapper around node-sqlite3-wasm.
 *
 * Keeps the rest of the storage layer independent of the concrete SQLite
 * binding: repositories only see `SqliteDriver`. Uses positional `?`
 * parameters exclusively.
 */

import { Database } from 'node-sqlite3-wasm'

/** Values that can be bound to a positional `?` parameter. */
export type SqlValue = number | bigint | string | boolean | Uint8Array | null

export type SqlParams = SqlValue[]

export interface SqliteDriver {
  /** Execute a single statement with optional positional params. */
  run(sql: string, params?: SqlParams): { changes: number }
  /** Fetch the first row, or undefined when there is none. */
  get<T>(sql: string, params?: SqlParams): T | undefined
  /** Fetch all rows. */
  all<T>(sql: string, params?: SqlParams): T[]
  /** Execute one or more statements without params (DDL, PRAGMA, ...). */
  exec(sql: string): void
  /**
   * Run `fn` inside BEGIN/COMMIT, rolling back on any thrown error. Re-entrant:
   * a repository method that opens its own transaction may be called from inside
   * a composed one (SQLite rejects a nested BEGIN).
   */
  transaction<T>(fn: () => T): T
  close(): void
}

export function open(filePath: string): SqliteDriver {
  const db = new Database(filePath)
  // Nesting level of driver-owned transactions; only used to name savepoints.
  let depth = 0

  db.exec('PRAGMA foreign_keys = ON')
  try {
    // The WASM VFS may not support WAL; the default journal mode is fine.
    db.exec('PRAGMA journal_mode = WAL')
  } catch {
    // ignore — see above
  }

  return {
    run(sql, params) {
      const result = db.run(sql, params)
      return { changes: result.changes }
    },

    get<T>(sql: string, params?: SqlParams): T | undefined {
      const row = db.get(sql, params)
      return row === null ? undefined : (row as unknown as T)
    },

    all<T>(sql: string, params?: SqlParams): T[] {
      return db.all(sql, params) as unknown as T[]
    },

    exec(sql) {
      db.exec(sql)
    },

    transaction<T>(fn: () => T): T {
      // The outermost level owns BEGIN/COMMIT; inner levels join it through a
      // SAVEPOINT, so a caught inner failure undoes only its own work.
      const savepoint = db.inTransaction ? `sp_${++depth}` : null
      db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN')
      try {
        const result = fn()
        db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT')
        return result
      } catch (error) {
        try {
          if (savepoint) {
            db.exec(`ROLLBACK TO ${savepoint}`)
            db.exec(`RELEASE ${savepoint}`)
          } else {
            db.exec('ROLLBACK')
          }
        } catch {
          // e.g. the error already aborted the transaction — nothing to roll back
        }
        throw error
      } finally {
        if (savepoint) depth--
      }
    },

    close() {
      db.close()
    },
  }
}
