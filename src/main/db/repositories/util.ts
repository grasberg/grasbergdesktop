/**
 * Small shared helpers for the repositories: the dynamic UPDATE builder and
 * safe JSON-column parsing. No repository-specific logic lives here.
 */

import type { SqliteDriver, SqlValue } from '../driver'

/**
 * Runs `UPDATE <table> SET ... WHERE id = ?` over the columns whose value is
 * not undefined, in the order given (callers encode values — JSON.stringify,
 * boolean-to-int — at the call site). When `touchUpdatedAt` is set and at
 * least one column changed, `updated_at = Date.now()` is appended as the last
 * SET column. A patch with no defined values is a no-op (no touch either).
 */
export function updateById(
  driver: SqliteDriver,
  table: string,
  id: string,
  columns: Record<string, SqlValue | undefined>,
  options: { touchUpdatedAt?: boolean } = {}
): void {
  const sets: string[] = []
  const params: SqlValue[] = []
  for (const [column, value] of Object.entries(columns)) {
    if (value === undefined) continue
    sets.push(`${column} = ?`)
    params.push(value)
  }
  if (sets.length === 0) return
  if (options.touchUpdatedAt) {
    sets.push('updated_at = ?')
    params.push(Date.now())
  }
  params.push(id)
  driver.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, params)
}

/**
 * JSON.parse that never throws: returns `fallback` for null/empty text,
 * corrupt JSON, or (when `guard` is given) a parsed value the guard rejects.
 */
export function parseJson<T>(
  text: string | null,
  fallback: T,
  guard?: (value: unknown) => value is T
): T {
  if (text === null || text === '') return fallback
  try {
    const value: unknown = JSON.parse(text)
    if (guard && !guard(value)) return fallback
    return value as T
  } catch {
    return fallback
  }
}

/**
 * Parses a JSON string array, dropping non-string entries. `fallback` when
 * the text is missing, corrupt, or not an array.
 */
export function parseStringArray<F>(text: string | null, fallback: string[] | F): string[] | F {
  const value = parseJson<unknown>(text, undefined)
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : fallback
}

/**
 * Parses a JSON object of string values, dropping non-string entries. `{}`
 * when the text is missing, corrupt, or not a plain object.
 */
export function parseStringMap(text: string | null): Record<string, string> {
  const value = parseJson<unknown>(text, undefined)
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v
    return out
  }
  return {}
}
