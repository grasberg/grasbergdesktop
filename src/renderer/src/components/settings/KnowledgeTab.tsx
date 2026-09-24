/**
 * Settings → Knowledge: knowledge bases (RAG). Each base embeds imported text
 * documents with a provider's /embeddings model; a conversation attaches one
 * (⚙ in the chat header) and the assistant retrieves passages with the
 * knowledge_search tool.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { KnowledgeBase } from '@shared/types'
import { ConfirmButton } from '@/components/common/controls'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { useProvidersStore } from '@/stores/providers'
import { useUiStore } from '@/stores/ui'
import { providerUsable } from '@/lib/providers'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'
import { confirmAction } from '@/components/common/ConfirmDialog'
import { toNormalized } from '@/api/uld'
import './settings.css'

function CreateForm({ onDone }: { onDone: () => void }): ReactElement {
  const providers = useProvidersStore((s) => s.providers)
  const toast = useUiStore((s) => s.toast)
  const [compatible, setCompatible] = useState<string[]>([])
  useEffect(() => { void window.uld.knowledge.providers().then(r => { if (r.ok) setCompatible(r.data.map(p => p.id)); else toast(r.error.message, 'error') }) }, [toast])
  const usable = providers.filter(p => providerUsable(p) && compatible.includes(p.id))
  const [name, setName] = useState('')
  const [providerId, setProviderId] = useState(usable[0]?.id ?? '')
  const [modelId, setModelId] = useState('')
  const [busy, run] = useAsyncAction()
  const guard = useUnsavedChanges(!!name || !!modelId, 'settings')
  useEffect(() => { if (!usable.some(p => p.id === providerId)) setProviderId(usable[0]?.id ?? '') }, [compatible, providers])

  const submit = async (): Promise<void> => {
    if (!name.trim() || !providerId || !modelId.trim()) {
      toast('Fill in a name, provider and embedding model.', 'error')
      return
    }
    await run(async () => {
      const res = await window.uld.knowledge.create({
        name: name.trim(),
        providerId,
        modelId: modelId.trim(),
      })
      if (!res.ok) {
        toast(res.error.message, 'error')
        return
      }
      guard.markSaved(); onDone()
    })
  }

  return (
    <div className="card prompt-form">
      <h5>New knowledge base</h5>
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="input"
          value={name}
          maxLength={200}
          placeholder="e.g. Product docs"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">Embeddings provider</span>
        <select className="select" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
          {usable.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <p className="field-hint">
          Only providers with an embeddings adapter are listed. Creating the base sends a small test to the chosen embedding model and may incur a provider charge.
        </p>
      </label>
      <label className="field">
        <span className="field-label">Embedding model</span>
        <input
          className="input mono"
          value={modelId}
          placeholder="e.g. text-embedding-3-small or nomic-embed-text"
          onChange={(e) => setModelId(e.target.value)}
        />
      </label>
      <div className="prompt-form-actions">
        <button type="button" className="btn btn-primary" disabled={busy || !name.trim() || !providerId || !modelId.trim()} onClick={() => void submit()}>
          {busy ? 'Testing embeddings…' : 'Test and create'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => guard.discard(onDone)}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function BaseCard({ base, onChanged }: { base: KnowledgeBase; onChanged: () => void }): ReactElement {
  const toast = useUiStore((s) => s.toast)
  const [sources, setSources] = useState<Array<{ source: string; chunks: number }>>([])
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState('')
  const [failures, setFailures] = useState<Array<{ source: string; error: string }>>([])
  useEffect(() => window.uld.knowledge.onProgress(e => {
    if (e.kbId !== base.id) return
    setImporting(e.status !== 'done')
    setProgress(e.status === 'done' ? '' : `Document ${e.file}/${e.totalFiles}: ${e.source} · ${e.completed}/${e.total || '?'} chunks`)
  }), [base.id])

  const loadSources = useCallback(async () => {
    const res = await window.uld.knowledge.sources(base.id)
    if (res.ok) setSources(res.data)
  }, [base.id])

  useEffect(() => {
    void loadSources()
  }, [loadSources])

  const importFiles = async (): Promise<void> => {
    setImporting(true)
    try {
      const res = await window.uld.knowledge.importFiles(base.id)
      if (!res.ok) {
        toast(res.error.message, 'error')
        return
      }
      if (res.data.canceled) return
      setFailures(res.data.failures ?? [])
      const skipped = res.data.skipped > 0 ? ` (${res.data.skipped} files skipped)` : ''
      toast(
        `Imported ${res.data.imported} documents as ${res.data.chunks} chunks${skipped}.`,
        'success'
      )
      await loadSources()
      onChanged()
    } catch (e) { toast(toNormalized(e).message, 'error') } finally {
      setImporting(false)
    }
  }

  const removeSource = async (source: string): Promise<void> => {
    if (!await confirmAction('Remove document?', `Remove “${source}” from this knowledge base? The original file is kept.`, 'Remove document')) return
    const res = await window.uld.knowledge.removeSource(base.id, source)
    if (!res.ok) toast(res.error.message, 'error')
    await loadSources()
    onChanged()
  }

  const remove = async (): Promise<void> => {
    const res = await window.uld.knowledge.delete(base.id)
    if (!res.ok) toast(res.error.message, 'error')
    onChanged()
  }

  return (
    <li className="prompt-item card">
      <div className="prompt-item-main">
        {progress && <p role="status">{progress}</p>}
        {failures.length > 0 && <div role="alert" className="form-error">Some documents could not be imported. Successful documents were kept. Select the failed files again to retry.{failures.map(f => <p key={f.source}>{f.source}: {f.error}</p>)}</div>}
        <strong className="prompt-item-title">{base.name}</strong>
        <p className="prompt-item-body">
          {base.chunkCount} chunks · embeddings: <span className="mono">{base.modelId}</span>
        </p>
        {sources.length > 0 && (
          <ul className="kb-source-list">
            {sources.map((s) => (
              <li key={s.source} className="kb-source">
                <span className="kb-source-name">{s.source}</span>
                <span className="kb-source-chunks">{s.chunks} chunks</span>
                <button
                  type="button"
                  className="btn-icon"
                  aria-label={`Remove document ${s.source}`}
                  title="Remove document"
                  onClick={() => void removeSource(s.source)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="prompt-item-actions">
        <button type="button" className="btn" disabled={importing} onClick={() => void importFiles()}>
          {importing ? 'Embedding…' : '+ Add documents'}
        </button>
        <ConfirmButton label="Delete" prompt="Delete this knowledge base?" onConfirm={() => void remove()} />
      </div>
    </li>
  )
}

export default function KnowledgeTab(): ReactElement {
  const [bases, setBases] = useState<KnowledgeBase[]>([])
  const [loaded, setLoaded] = useState(false)
  const [formOpen, setFormOpen] = useState(false)

  const load = useCallback(async () => {
    const res = await window.uld.knowledge.list()
    if (res.ok) setBases(res.data)
    setLoaded(true)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section aria-label="Knowledge">
      <header className="tab-header">
        <div>
          <h3>Knowledge bases</h3>
          <p className="field-hint">
            Import your documents and the assistant retrieves relevant passages with the
            knowledge_search tool. Attach a base to a conversation via the ⚙ button in the chat
            header.
          </p>
        </div>
        {!formOpen ? (
          <button type="button" className="btn" onClick={() => setFormOpen(true)}>
            + New knowledge base
          </button>
        ) : null}
      </header>

      {formOpen ? (
        <CreateForm
          onDone={() => {
            setFormOpen(false)
            void load()
          }}
        />
      ) : null}

      {!loaded ? (
        <p className="field-hint">Loading…</p>
      ) : bases.length === 0 && !formOpen ? (
        <div className="empty-state card">
          <p>No knowledge bases yet. Create one and add your documents.</p>
        </div>
      ) : (
        <ul className="prompt-list">
          {bases.map((b) => (
            <BaseCard key={b.id} base={b} onChanged={() => void load()} />
          ))}
        </ul>
      )}
    </section>
  )
}
