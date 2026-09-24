import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type {
  ChatParams,
  ConversationMode,
  FailoverChainEntry,
  ModeModelDefault,
  ResearchDepth,
} from '@shared/types'

import { usePersistSettings } from '@/hooks/usePersistSettings'
import { useSettingsStore } from '@/stores/settings'
import { useProvidersStore } from '@/stores/providers'
import ModelField from '@/components/chat/ModelField'



const MODE_LABELS: ReadonlyArray<{ mode: ConversationMode; label: string }> = [
  { mode: 'chat', label: 'Chat' },
  { mode: 'work', label: 'Work' },
]

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** One mode's provider + model picker for the per-mode defaults section. */
function ModeModelRow({ label, value, onChange }: { label: string; value: ModeModelDefault; onChange: (next: ModeModelDefault) => void }): React.JSX.Element {
  return <ModelField label={label} providerId={value.providerId} modelId={value.modelId} onChange={(providerId, modelId) => onChange({ providerId, modelId })} />
}

/**
 * Provider + model picker for image generation. Unlike ModeModelRow the model
 * list comes from the family's static image catalog (no live /models call —
 * image models rarely appear there), with the usual custom-id escape hatch.
 */
function ImageModelRow({ value, onChange }: { value: ModeModelDefault; onChange: (next: ModeModelDefault) => void }): React.JSX.Element {
  return <ModelField label="Image model" purpose="image" providerId={value.providerId} modelId={value.modelId} defaultLabel="First image-capable provider and its image model" onChange={(providerId, modelId) => onChange({ providerId, modelId })} />
}

function FailoverRow({ ariaLabel, providerId, modelId, onPick, onRemove, onMoveUp, onMoveDown }: {
  ariaLabel: string; providerId: string; modelId: string | null; onPick: (providerId: string, modelId: string) => void; onRemove: () => void; onMoveUp?: () => void; onMoveDown?: () => void
}): React.JSX.Element {
  return <div className="failover-chain-row"><ModelField label={ariaLabel} providerId={providerId} modelId={modelId} allowDefault={false} onChange={(p, m) => { if (p && m) onPick(p, m) }} /><div className="failover-chain-actions"><button type="button" className="btn btn-ghost btn-sm" disabled={!onMoveUp} aria-label={`${ariaLabel}: move up`} onClick={onMoveUp}>↑</button><button type="button" className="btn btn-ghost btn-sm" disabled={!onMoveDown} aria-label={`${ariaLabel}: move down`} onClick={onMoveDown}>↓</button><button type="button" className="btn btn-ghost btn-sm" aria-label={`${ariaLabel}: remove`} onClick={onRemove}>×</button></div></div>
}
function FailoverChainEditor({
  label,
  entries,
  onChange,
}: {
  label: string
  entries: FailoverChainEntry[]
  onChange: (next: FailoverChainEntry[]) => void
}): React.JSX.Element {
  // The one row being edited: an appended "Add fallback" row, or an existing
  // row whose provider was switched (its persisted entry stays until commit).
  const [draft, setDraft] = useState<{
    index: number
    providerId: string
    modelId: string | null
  } | null>(null)

  const commitOrHold = (index: number, providerId: string, modelId: string | null): void => {
    if (providerId && modelId) {
      const next = [...entries]
      next.splice(index, index < entries.length ? 1 : 0, { providerId, modelId })
      onChange(next)
      setDraft(null)
    } else {
      setDraft({ index, providerId, modelId })
    }
  }

  const move = (index: number, delta: number): void => {
    const next = [...entries]
    const [entry] = next.splice(index, 1)
    if (!entry) return
    next.splice(index + delta, 0, entry)
    setDraft(null)
    onChange(next)
  }

  const rows: Array<{
    key: string
    index: number
    providerId: string
    modelId: string | null
    isDraft: boolean
  }> = entries.map((entry, i) => ({
    key: `entry-${i}`,
    index: i,
    providerId: entry.providerId,
    modelId: entry.modelId,
    isDraft: false,
  }))
  if (draft) {
    const draftRow = { key: 'draft', ...draft, isDraft: true }
    if (draft.index < entries.length) rows[draft.index] = draftRow
    else rows.push(draftRow)
  }

  return (
    <div className="failover-chain">
      <span className="field-label">{label}</span>
      {rows.length === 0 && <p className="field-hint">No fallbacks configured.</p>}
      {rows.map((row, i) => (
        <FailoverRow
          key={row.key}
          ariaLabel={`${label} fallback ${i + 1}`}
          providerId={row.providerId}
          modelId={row.modelId}
          onPick={(p, m) => commitOrHold(row.index, p, m)}
          onRemove={() => {
            setDraft(null)
            if (!row.isDraft) onChange(entries.filter((_, j) => j !== row.index))
          }}
          onMoveUp={!row.isDraft && row.index > 0 ? () => move(row.index, -1) : undefined}
          onMoveDown={
            !row.isDraft && row.index < entries.length - 1 ? () => move(row.index, 1) : undefined
          }
        />
      ))}
      {entries.length < 5 && !draft && (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setDraft({ index: entries.length, providerId: '', modelId: null })}
        >
          Add fallback
        </button>
      )}
    </div>
  )
}

export default function DefaultsTab() {
  const settings = useSettingsStore((s) => s.settings)
  const persist = usePersistSettings()


  const [prompt, setPrompt] = useState('')
  const [temp, setTemp] = useState('')
  const [topP, setTopP] = useState('')
  const [maxTok, setMaxTok] = useState('')

  const promptValue = settings?.defaultSystemPrompt ?? ''
  const tempValue = settings?.defaultParams.temperature
  const topPValue = settings?.defaultParams.topP
  const maxTokValue = settings?.defaultParams.maxTokens

  // Sync each local draft from its persisted value (per-field deps so an
  // update to one field never clobbers in-progress edits of another).
  useEffect(() => setPrompt(promptValue), [promptValue])
  useEffect(() => setTemp(tempValue != null ? String(tempValue) : ''), [tempValue])
  useEffect(() => setTopP(topPValue != null ? String(topPValue) : ''), [topPValue])
  useEffect(() => setMaxTok(maxTokValue != null ? String(maxTokValue) : ''), [maxTokValue])

  if (!settings) {
    return <p className="field-hint">Loading settings…</p>
  }

  function buildParams(): ChatParams {
    // Preserve keys this tab does not edit (frequency/presence penalties).
    const out: ChatParams = { ...settings!.defaultParams }
    const t = parseFloat(temp)
    if (temp.trim() !== '' && Number.isFinite(t)) out.temperature = clamp(t, 0, 2)
    else delete out.temperature
    const p = parseFloat(topP)
    if (topP.trim() !== '' && Number.isFinite(p)) out.topP = clamp(p, 0, 1)
    else delete out.topP
    const m = Math.floor(Number(maxTok))
    if (maxTok.trim() !== '' && Number.isFinite(m) && m > 0) out.maxTokens = m
    else delete out.maxTokens
    return out
  }

  function commitParams() {
    void persist({ defaultParams: buildParams() })
  }

  const commitOnEnter = (commit: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    }
  }

  return (
    <section aria-label="Defaults">
      <header className="tab-header">
        <div>
          <h3>Defaults</h3>
          <p className="field-hint">Used for new conversations. Each conversation can override these.</p>
        </div>
      </header>

      <ModelField label="Default model" providerId={settings.defaultProviderId} modelId={settings.defaultModelId} onChange={(defaultProviderId, defaultModelId) => void persist({ defaultProviderId, defaultModelId })} />

      <h4 className="section-subhead">Model per mode</h4>
      <label className="field-checkbox">
        <input
          type="checkbox"
          checked={settings.perModeModelsEnabled}
          onChange={(e) => void persist({ perModeModelsEnabled: e.target.checked })}
        />
        <span>
          Use a different model for each mode
          <span className="field-hint">
            Off: every mode uses the default provider/model above. On: a new conversation in each
            mode starts with the model you pick below — modes left as “Use default” fall back to the
            default above. You can still change any conversation’s model afterwards.
          </span>
        </span>
      </label>
      {settings.perModeModelsEnabled ? (
        <div className="mode-model-list">
          {MODE_LABELS.map(({ mode, label }) => (
            <ModeModelRow
              key={mode}
              label={label}
              value={settings.modeModels[mode]}
              onChange={(next) =>
                void persist({ modeModels: { ...settings.modeModels, [mode]: next } })
              }
            />
          ))}
        </div>
      ) : null}

      <div className="settings-field">
        <label className="field-label" htmlFor="def-system-prompt">
          Default system prompt
        </label>
        <textarea
          id="def-system-prompt"
          className="textarea"
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={() => void persist({ defaultSystemPrompt: prompt })}
          placeholder="You are a helpful assistant…"
        />
      </div>

      <h4 className="section-subhead">Sampling parameters</h4>
      <p className="field-hint">Leave a field blank to use the provider's default.</p>

      <div className="param-row">
        <label className="field-label" htmlFor="def-temp-num">
          Temperature <span className="field-hint-inline">0–2</span>
        </label>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={temp === '' ? 1 : Number(temp)}
          onChange={(e) => setTemp(e.target.value)}
          onPointerUp={commitParams}
          onKeyUp={commitParams}
          aria-label="Temperature slider"
        />
        <input
          id="def-temp-num"
          className="input param-num"
          type="number"
          min={0}
          max={2}
          step={0.1}
          value={temp}
          placeholder="default"
          onChange={(e) => setTemp(e.target.value)}
          onBlur={commitParams}
          onKeyDown={commitOnEnter(commitParams)}
        />
      </div>

      <div className="param-row">
        <label className="field-label" htmlFor="def-topp-num">
          Top P <span className="field-hint-inline">0–1</span>
        </label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={topP === '' ? 1 : Number(topP)}
          onChange={(e) => setTopP(e.target.value)}
          onPointerUp={commitParams}
          onKeyUp={commitParams}
          aria-label="Top P slider"
        />
        <input
          id="def-topp-num"
          className="input param-num"
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={topP}
          placeholder="default"
          onChange={(e) => setTopP(e.target.value)}
          onBlur={commitParams}
          onKeyDown={commitOnEnter(commitParams)}
        />
      </div>

      <div className="param-row">
        <label className="field-label" htmlFor="def-maxtok">
          Max tokens
        </label>
        <span className="param-spacer" aria-hidden="true" />
        <input
          id="def-maxtok"
          className="input param-num wide"
          type="number"
          min={1}
          step={1}
          value={maxTok}
          placeholder="provider default"
          onChange={(e) => setMaxTok(e.target.value)}
          onBlur={commitParams}
          onKeyDown={commitOnEnter(commitParams)}
        />
      </div>

      <div className="param-row">
        <label className="field-label" htmlFor="def-reasoning">
          Reasoning effort
        </label>
        <span className="param-spacer" aria-hidden="true" />
        <select
          id="def-reasoning"
          className="select param-num wide"
          value={settings.defaultParams.reasoningEffort ?? ''}
          onChange={(e) => {
            const params: ChatParams = { ...settings.defaultParams }
            const v = e.target.value
            if (v === 'low' || v === 'medium' || v === 'high') params.reasoningEffort = v
            else delete params.reasoningEffort
            void persist({ defaultParams: params })
          }}
        >
          <option value="">Provider default</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>
      <p className="field-hint">
        How much thinking reasoning-capable models spend before answering. Sent as
        reasoning_effort (OpenAI-style), an extended-thinking budget (Anthropic) or a thinking
        budget (Gemini); models without reasoning ignore it.
      </p>

      <h4 className="section-subhead">Long conversations</h4>
      <label className="field-checkbox">
        <input
          type="checkbox"
          checked={settings.compactionEnabled}
          onChange={(e) => void persist({ compactionEnabled: e.target.checked })}
        />
        <span>
          Automatically condense long conversations
          <span className="field-hint">
            When a chat nears the model&apos;s context limit, older messages are summarized so the
            conversation can continue. The summary is kept and shown above the chat.
          </span>
        </span>
      </label>

      <h4 className="section-subhead">Economy model</h4>
      <p className="field-hint">
        A cheap model for internal plumbing generations — condensing long conversations, commit
        message suggestions and memory consolidation. Your conversations still use their own
        model. Unset = the default model handles these too.
      </p>
      <div className="mode-model-list">
        <ModeModelRow
          label="Economy model"
          value={{
            providerId: settings.economyProviderId,
            modelId: settings.economyModelId,
          }}
          onChange={(next) =>
            void persist({
              economyProviderId: next.providerId,
              economyModelId: next.modelId,
            })
          }
        />
      </div>

      <h4 className="section-subhead">Deep Research</h4>
      <p className="field-hint">
        The /research command (and the DR composer toggle) searches the web with web_search and
        fetch_url — those two tools run without per-call approval during a research run — and
        writes a report with numbered, clickable sources. The conversation&apos;s model writes the
        final report; the worker model below (often a cheaper one) plans and gathers.
      </p>
      <div className="mode-model-list">
        <ModeModelRow
          label="Worker model"
          value={{
            providerId: settings.researchWorkerProviderId,
            modelId: settings.researchWorkerModelId,
          }}
          onChange={(next) =>
            void persist({
              researchWorkerProviderId: next.providerId,
              researchWorkerModelId: next.modelId,
            })
          }
        />
      </div>
      <div className="param-row">
        <label className="field-label" htmlFor="def-research-depth">
          Default depth
        </label>
        <span className="param-spacer" aria-hidden="true" />
        <select
          id="def-research-depth"
          className="select param-num wide"
          value={settings.researchDefaultDepth}
          onChange={(e) =>
            void persist({ researchDefaultDepth: e.target.value as ResearchDepth })
          }
        >
          <option value="quick">Quick — a couple of searches</option>
          <option value="standard">Standard — several topics, more pages</option>
          <option value="deep">Deep — the most topics, rounds and sources</option>
        </select>
      </div>

      <h4 className="section-subhead">Image generation</h4>
      <p className="field-hint">
        Used by the generate_image tool (each call still asks for approval). Unset = the first
        enabled provider that can generate images (OpenAI, Google Gemini or GLM/Zhipu). The model
        dropdown lists that family&apos;s image models — or type a custom id.
      </p>
      <div className="mode-model-list">
        <ImageModelRow
          value={{
            providerId: settings.defaultImageProviderId,
            modelId: settings.defaultImageModelId,
          }}
          onChange={(next) =>
            void persist({
              defaultImageProviderId: next.providerId,
              defaultImageModelId: next.modelId,
            })
          }
        />
      </div>

      <h4 className="section-subhead">Reliability fallbacks</h4>
      <p className="field-hint">
        If a model fails mid-answer (rate limit, outage, network error) or returns nothing before
        any tool has run, the app retries with these models in order before showing an error.
        Interactive covers chats; Background covers workflows, scheduled tasks and other
        background runs.
      </p>
      <FailoverChainEditor
        label="Interactive"
        entries={settings.failoverChains.interactive ?? []}
        onChange={(next) =>
          void persist({ failoverChains: { ...settings.failoverChains, interactive: next } })
        }
      />
      <FailoverChainEditor
        label="Background"
        entries={settings.failoverChains.headless ?? []}
        onChange={(next) =>
          void persist({ failoverChains: { ...settings.failoverChains, headless: next } })
        }
      />
    </section>
  )
}
