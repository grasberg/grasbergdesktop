/**
 * Thin synchronous wrapper around node-sqlite3-wasm.
 *
 * Keeps the rest of the storage layer independent of the concrete SQLite
 * binding: repositories only see `SqliteDriver`. Uses positional `?`
 * parameters exclusively.
 */

import { Database, type Statement } from 'node-sqlite3-wasm'

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
  /**
   * Registers a callback fired after the OUTERMOST transaction ends — whether
   * it committed or rolled back. Lets caches built from table reads inside a
   * transaction discard values that a rollback may have just un-written.
   */
  onTransactionEnd(fn: () => void): void
  close(): void
}

export function open(filePath: string): SqliteDriver {
  const db = new Database(filePath)
  // Nesting level of driver-owned transactions; only used to name savepoints.
  let depth = 0

  /**
   * Compiled-statement cache. node-sqlite3-wasm's convenience methods prepare
   * + finalize on EVERY call; on the synchronous main-process thread that is a
   * per-query recompile of the same handful of SQL strings. A cached Statement
   * resets and rebinds on each use (its _bind always runs clear_bindings +
   * reset), so reuse is safe. Bounded LRU: statements hold WASM resources, so
   * evicted entries are finalized immediately.
   */
   const MAX_CACHED_STATEMENTS = 256
  const stmts = new Map<string, Statement>()
  const stmtFor = (sql: string): Statement => {
    const cached = stmts.get(sql)
    if (cached) {
      // Re-insert so the Map order reflects recency (eviction takes from the front).
      stmts.delete(sql)
      stmts.set(sql, cached)
      return cached
    }
    const stmt = db.prepare(sql)
    if (stmts.size >= MAX_CACHED_STATEMENTS) {
      const oldest = stmts.keys().next()
      if (!oldest.done) {
        stmts.get(oldest.value)?.finalize()
        stmts.delete(oldest.value)
      }
    }
    stmts.set(sql, stmt)
    return stmt
  }

  /**
   * Runs one cached-statement operation, evicting + finalizing the statement if
   * it throws. node-sqlite3-wasm leaves a statement whose step() failed (a
   * constraint violation, an FK error) in a state where the NEXT reset/bind on
   * that same cached handle throws a spurious "Could not reset statement prior
   * to binding new values" — turning one error into a second on an unrelated,
   * valid call that happens to share the SQL string. Dropping the handle on
   * error means the next call recompiles a clean statement.
   */
  const withStmt = <T>(sql: string, fn: (stmt: Statement) => T): T => {
    const stmt = stmtFor(sql)
    try {
      return fn(stmt)
    } catch (error) {
      stmts.delete(sql)
      try {
        if (!stmt.isFinalized) stmt.finalize()
      } catch {
        // Best-effort teardown of a statement that is already in a bad state.
      }
      throw error
    }
  }

  /** Subscribers fired when the outermost transaction commits or rolls back. */
  const transactionEndHooks = new Set<() => void>()
  const fireTransactionEnd = (): void => {
    for (const hook of transactionEndHooks) hook()
  }

  db.exec('PRAGMA foreign_keys = ON')
  try {
    // The WASM VFS may not support WAL; the default journal mode is fine.
    db.exec('PRAGMA journal_mode = WAL')
  } catch {
    // ignore — see above
  }

  return {
    run(sql, params) {
      return withStmt(sql, (stmt) => ({ changes: stmt.run(params).changes }))
    },

    get<T>(sql: string, params?: SqlParams): T | undefined {
      // Must drain to completion, NOT stop at the first row: a statement
      // paused mid-iteration keeps its read cursor open, and any later DDL or
      // write transaction on this connection then fails with SQLITE_LOCKED
      // ("database table is locked") — e.g. migrations rebuilding a table.
      // Reaching SQLITE_DONE releases the cursor.
      return withStmt(sql, (stmt) => {
        const rows = stmt.iterate(params)
        let first: T | undefined
        let seen = false
        for (const row of rows) {
          if (!seen) {
            first = row as unknown as T
            seen = true
          }
        }
        return first
      })
    },

    all<T>(sql: string, params?: SqlParams): T[] {
      // Array.from over iterate() drains to completion (same requirement).
      return withStmt(sql, (stmt) => Array.from(stmt.iterate(params)) as unknown as T[])
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
        if (!savepoint) fireTransactionEnd()
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
        if (!savepoint) fireTransactionEnd()
        throw error
      } finally {
        if (savepoint) depth--
      }
    },

    onTransactionEnd(fn) {
      transactionEndHooks.add(fn)
    },

    close() {
      for (const stmt of stmts.values()) {
        if (!stmt.isFinalized) stmt.finalize()
      }
      stmts.clear()
      db.close()
    },
  }
}
