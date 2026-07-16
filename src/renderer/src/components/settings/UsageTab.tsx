/**
 * Settings → Usage: a local, estimate-only summary of token usage and cost
 * per provider+model over a selectable window. Everything is computed from
 * locally stored messages — nothing is sent anywhere.
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { UsageSummaryEntry } from '@shared/types'
import { PRICING_DISCLAIMER, formatCost } from '@shared/pricing'
import { toNormalized, unwrap } from '@/api/uld'

const WINDOWS = [7, 30, 90] as const

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

export default function UsageTab(): ReactElement {
  const [days, setDays] = useState<number>(30)
  const [entries, setEntries] = useState<UsageSummaryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    setEntries(null)
    setError(null)
    unwrap(window.uld.usage.summary(days))
      .then((rows) => {
        if (!stale) setEntries(rows)
      })
      .catch((e: unknown) => {
        if (!stale) setError(toNormalized(e).message)
      })
    return () => {
      stale = true
    }
  }, [days])

  const totalCost = entries?.reduce((sum, e) => sum + (e.estimatedCostUsd ?? 0), 0) ?? 0
  const knowsAnyCost = entries?.some((e) => e.estimatedCostUsd !== null) ?? false

  return (
    <section className="settings-section" aria-label="Usage">
      <h3 className="section-head">Usage</h3>
      <p className="field-hint">
        Token usage recorded on locally stored messages, grouped by provider and model. Cost is an
        estimate from a built-in price list. {PRICING_DISCLAIMER}
      </p>

      <div className="param-row">
        <label className="field-label" htmlFor="usage-window">
          Window
        </label>
        <span className="param-spacer" aria-hidden="true" />
        <select
          id="usage-window"
          className="select param-num wide"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {WINDOWS.map((d) => (
            <option key={d} value={d}>
              Last {d} days
            </option>
          ))}
        </select>
      </div>

      {error ? (
        <p className="field-hint" role="alert">
          Could not load the summary: {error}
        </p>
      ) : null}
      {entries && entries.length === 0 ? (
        <p className="field-hint">No recorded usage in this window.</p>
      ) : null}

      {entries && entries.length > 0 ? (
        <>
          <table className="usage-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Model</th>
                <th className="num">Msgs</th>
                <th className="num">In</th>
                <th className="num">Out</th>
                <th className="num">Total</th>
                <th className="num">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={`${entry.providerId}-${entry.modelId}`}>
                  <td>{entry.providerLabel}</td>
                  <td className="mono" title={entry.modelId}>
                    {entry.modelId}
                  </td>
                  <td className="num">{entry.messages}</td>
                  <td className="num">{formatTokens(entry.promptTokens)}</td>
                  <td className="num">{formatTokens(entry.completionTokens)}</td>
                  <td className="num">{formatTokens(entry.totalTokens)}</td>
                  <td className="num">
                    {entry.estimatedCostUsd !== null ? formatCost(entry.estimatedCostUsd) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {knowsAnyCost ? (
            <p className="usage-total">
              Estimated total: <strong>{formatCost(totalCost)}</strong>
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
