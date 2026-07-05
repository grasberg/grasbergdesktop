/**
 * Shared editor for public/secret key-value rows (custom HTTP tool headers and
 * MCP env vars / headers). Secret values are write-only: an existing secret is
 * shown as a blank password field ("value blank = keep"), and removing its row
 * deletes the stored value.
 */

import type { Dispatch, ReactElement, SetStateAction } from 'react'

export interface SecretRow {
  name: string
  value: string
  secret: boolean
  /** A secret that already exists on the server (value blank = keep). */
  existing: boolean
}

/** Hydrates editor rows from stored public values plus write-only secret names. */
export function rowsFromExisting(
  publicValues: Record<string, string>,
  secretNames: readonly string[]
): SecretRow[] {
  const rows: SecretRow[] = []
  for (const [name, value] of Object.entries(publicValues)) {
    rows.push({ name, value, secret: false, existing: false })
  }
  for (const name of secretNames) rows.push({ name, value: '', secret: true, existing: true })
  return rows
}

/**
 * Splits rows back into the wire shape: public values, secrets to set (blank
 * existing secrets are kept as-is, not sent), and original secrets whose rows
 * were removed or un-marked (to delete).
 */
export function splitRows(
  rows: readonly SecretRow[],
  originalSecretNames: Iterable<string> = []
): {
  publicValues: Record<string, string>
  setSecrets: Record<string, string>
  deleteSecrets: string[]
} {
  const publicValues: Record<string, string> = {}
  const setSecrets: Record<string, string> = {}
  for (const r of rows) {
    const key = r.name.trim()
    if (key.length === 0) continue
    if (r.secret) {
      if (r.value.length > 0) setSecrets[key] = r.value
      // existing secret with a blank value -> keep as is (not sent)
    } else {
      publicValues[key] = r.value
    }
  }
  const keptSecretNames = new Set(rows.filter((r) => r.secret).map((r) => r.name.trim()))
  const deleteSecrets = [...originalSecretNames].filter((n) => !keptSecretNames.has(n))
  return { publicValues, setSecrets, deleteSecrets }
}

export function SecretRowsEditor({
  rows,
  setRows,
  namePlaceholder,
  nameAriaLabel,
  valueAriaLabel,
  removeAriaLabel,
  addLabel,
}: {
  rows: SecretRow[]
  setRows: Dispatch<SetStateAction<SecretRow[]>>
  namePlaceholder: string
  nameAriaLabel: string
  valueAriaLabel: string
  removeAriaLabel: string
  addLabel: string
}): ReactElement {
  const setRow = (i: number, patch: Partial<SecretRow>): void =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const addRow = (): void =>
    setRows((rs) => [...rs, { name: '', value: '', secret: false, existing: false }])
  const removeRow = (i: number): void => setRows((rs) => rs.filter((_, idx) => idx !== i))

  return (
    <>
      {rows.map((r, i) => (
        <div className="custom-tool-header-row" key={i}>
          <input
            className="input"
            value={r.name}
            placeholder={namePlaceholder}
            aria-label={nameAriaLabel}
            onChange={(e) => setRow(i, { name: e.target.value })}
          />
          <input
            className="input"
            type={r.secret ? 'password' : 'text'}
            value={r.value}
            placeholder={r.secret && r.existing ? '•••••• (unchanged)' : 'value'}
            aria-label={valueAriaLabel}
            onChange={(e) => setRow(i, { value: e.target.value })}
          />
          <label className="custom-tool-secret-toggle" title="Store this value encrypted">
            <input
              type="checkbox"
              checked={r.secret}
              onChange={(e) => setRow(i, { secret: e.target.checked })}
            />
            secret
          </label>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={removeAriaLabel}
            onClick={() => removeRow(i)}
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-ghost" onClick={addRow}>
        {addLabel}
      </button>
    </>
  )
}
