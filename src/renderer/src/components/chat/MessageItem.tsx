import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { Attachment, Message, MoaReferenceOutput } from '@shared/types'
import { estimateCost, findPricing, formatCost, PRICING_DISCLAIMER } from '@shared/pricing'
import { presetPricing } from '@shared/presets'
import { useCopied } from '@/hooks/useCopied'
import { formatBytes } from '@/lib/format'
import { useChatStore } from '@/stores/chat'
import { useProvidersStore } from '@/stores/providers'
import Markdown from './Markdown'
import ToolCallCard from './ToolCallCard'
import './chat.css'

interface MessageItemProps {
  message: Message
  isLast: boolean
}

/** Attachment chip with a lazily-loaded thumbnail for stored images. */
function AttachmentChip({ attachment }: { attachment: Attachment }): ReactElement {
  const [src, setSrc] = useState<string | null>(attachment.dataUrl ?? null)
  useEffect(() => {
    if (attachment.kind !== 'image' || src || !attachment.storageKey) return
    let cancelled = false
    void window.uld.app.readAttachment(attachment.storageKey).then((res) => {
      if (!cancelled && res.ok && res.data) setSrc(res.data.dataUrl)
    })
    return () => {
      cancelled = true
    }
  }, [attachment.kind, attachment.storageKey, src])

  return (
    <span className="msg-attachment-chip" title={attachment.name}>
      {attachment.kind === 'image' && src ? (
        <img className="msg-attachment-thumb" src={src} alt="" />
      ) : null}
      <span className="msg-attachment-name">{attachment.name}</span>
      <span className="msg-attachment-size">{formatBytes(attachment.sizeBytes)}</span>
    </span>
  )
}

function UserMessage({ message }: { message: Message }): ReactElement {
  const editAndRerun = useChatStore((s) => s.editAndRerun)
  const streaming = useChatStore((s) => s.streaming)
  const [copied, copy] = useCopied()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing) textareaRef.current?.focus()
  }, [editing])

  const startEdit = (): void => {
    setDraft(message.content)
    setEditing(true)
  }

  const saveAndRerun = (): void => {
    const content = draft.trim()
    if (!content) return
    setEditing(false)
    void editAndRerun(message.id, content)
  }

  return (
    <div className="msg-row msg-row-user">
      <div className="msg-card msg-card-user">
        {editing ? (
          <div className="msg-edit">
            <textarea
              ref={textareaRef}
              className="textarea msg-edit-textarea"
              value={draft}
              rows={Math.min(10, Math.max(2, draft.split('\n').length))}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(false)
              }}
              aria-label="Edit message"
            />
            <div className="msg-edit-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={saveAndRerun}
                disabled={!draft.trim()}
              >
                Save &amp; rerun
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            {message.attachments && message.attachments.length > 0 && (
              <div className="msg-attachments">
                {message.attachments.map((a) => (
                  <AttachmentChip key={a.id} attachment={a} />
                ))}
              </div>
            )}
            <div className="msg-user-text">{message.content}</div>
          </>
        )}
      </div>
      {!editing && (
        <div className="msg-actions" role="toolbar" aria-label="Message actions">
          <button
            type="button"
            className="btn-icon msg-action"
            aria-label={copied ? 'Copied' : 'Copy message'}
            title="Copy"
            onClick={() => copy(message.content)}
          >
            {copied ? '✓' : '⧉'}
          </button>
          <button
            type="button"
            className="btn-icon msg-action"
            aria-label="Edit message"
            title="Edit"
            onClick={startEdit}
            disabled={streaming !== null}
          >
            ✎
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Mixture of Agents transparency: the advisor (reference) model outputs that fed
 * the aggregator, as a collapsible section of labelled blocks above the answer.
 */
function MoaReferences({
  references,
  label = 'Advisor models',
}: {
  references: MoaReferenceOutput[]
  label?: string
}): ReactElement {
  const [open, setOpen] = useState(false)
  const running = references.some((r) => r.status === 'running')
  const failed = references.filter((r) => r.status === 'error').length
  return (
    <div className="msg-moa">
      <button
        type="button"
        className="msg-moa-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`msg-moa-chevron${open ? ' open' : ''}`} aria-hidden>
          ▸
        </span>
        {label} ({references.length})
        {running && <span className="msg-moa-live">analyzing…</span>}
        {!running && failed > 0 && (
          <span className="msg-moa-failed">
            {failed} unavailable
          </span>
        )}
      </button>
      {open && (
        <div className="msg-moa-body">
          {references.map((ref) => (
            <div key={ref.index} className={`msg-moa-ref msg-moa-ref-${ref.status}`}>
              <div className="msg-moa-ref-head">
                <span className="msg-moa-ref-label">{ref.label}</span>
                {ref.status === 'running' && (
                  <span className="msg-moa-ref-status">analyzing…</span>
                )}
                {ref.status === 'error' && <span className="badge msg-error-code">unavailable</span>}
              </div>
              {ref.status === 'error' ? (
                <div className="msg-moa-ref-error">
                  {ref.error?.message ?? 'This advisor was unavailable.'}
                </div>
              ) : ref.text ? (
                <Markdown content={ref.text} />
              ) : ref.status === 'running' ? (
                <span className="chat-cursor" aria-hidden />
              ) : (
                <div className="msg-moa-ref-empty">(no output)</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Compare ("Arena") run: each advisor's answer in its own column with a
 * "Use this answer" action that promotes it to the message's content and
 * switches the conversation to that model.
 */
function CompareColumns({
  message,
  references,
}: {
  message: Message
  references: MoaReferenceOutput[]
}): ReactElement {
  const pickWinner = useChatStore((s) => s.pickCompareWinner)
  const streaming = useChatStore((s) => s.streaming)
  const picked = message.compare?.pickedIndex ?? null
  return (
    <div className="msg-compare" role="group" aria-label="Model comparison">
      {references.map((ref) => (
        <div
          key={ref.index}
          className={`msg-compare-col${picked === ref.index ? ' picked' : ''}`}
        >
          <div className="msg-compare-head">
            <span className="msg-compare-label">{ref.label}</span>
            {ref.status === 'running' && <span className="msg-moa-ref-status">answering…</span>}
            {ref.status === 'error' && <span className="badge msg-error-code">unavailable</span>}
          </div>
          <div className="msg-compare-body">
            {ref.status === 'error' ? (
              <div className="msg-moa-ref-error">
                {ref.error?.message ?? 'This model was unavailable.'}
              </div>
            ) : ref.text ? (
              <Markdown content={ref.text} />
            ) : ref.status === 'running' ? (
              <span className="chat-cursor" aria-hidden />
            ) : (
              <div className="msg-moa-ref-empty">(no output)</div>
            )}
          </div>
          {picked === null &&
            ref.status === 'done' &&
            (message.status === 'complete' || message.status === 'stopped') && (
            <div className="msg-compare-foot">
              <button
                type="button"
                className="btn btn-primary msg-compare-use"
                disabled={streaming !== null}
                onClick={() => void pickWinner(message.id, ref.index)}
              >
                Use this answer
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function AssistantMessage({ message, isLast }: MessageItemProps): ReactElement {
  const regenerate = useChatStore((s) => s.regenerate)
  const streaming = useChatStore((s) => s.streaming)
  const [copied, copy] = useCopied()
  const [reasoningOpen, setReasoningOpen] = useState(false)

  const isStreaming = message.status === 'streaming'
  // While the model is still thinking (reasoning arriving, no answer yet),
  // show the reasoning live regardless of the collapsed state.
  const reasoningLive = isStreaming && !!message.reasoning && !message.content
  const showReasoning = reasoningOpen || reasoningLive
  const isError = message.status === 'error'
  const usage = message.usage

  // Rough cost estimate from the model's list price (approximate; see tooltip).
  // Memoized: MessageItem re-renders per streaming delta for the live message.
  const providers = useProvidersStore((s) => s.providers)
  const cost = useMemo(() => {
    const provider = message.providerId
      ? providers.find((p) => p.id === message.providerId)
      : undefined
    const pricing =
      provider && message.modelId
        ? provider.presetId
          ? presetPricing(provider.presetId, message.modelId)
          : findPricing(provider.type, message.modelId)
        : undefined
    return usage && pricing ? estimateCost(usage, pricing) : undefined
  }, [providers, message.providerId, message.modelId, usage])

  return (
    <div className="msg-row msg-row-assistant">
      <div className={`msg-card msg-card-assistant${isError ? ' msg-card-error' : ''}`}>
        {message.moaReferences &&
          message.moaReferences.length > 0 &&
          (message.compare ? (
            message.compare.pickedIndex === null ? (
              <CompareColumns message={message} references={message.moaReferences} />
            ) : (
              <MoaReferences references={message.moaReferences} label="Compared models" />
            )
          ) : (
            <MoaReferences references={message.moaReferences} />
          ))}

        {message.reasoning && (
          <div className="msg-reasoning">
            <button
              type="button"
              className="msg-reasoning-toggle"
              aria-expanded={showReasoning}
              onClick={() => setReasoningOpen(!showReasoning)}
            >
              <span className={`msg-reasoning-chevron${showReasoning ? ' open' : ''}`} aria-hidden>
                ▸
              </span>
              Reasoning
              {reasoningLive && <span className="msg-reasoning-live">thinking…</span>}
            </button>
            {showReasoning && (
              <div className="msg-reasoning-body">
                <Markdown content={message.reasoning} />
                {reasoningLive && <span className="chat-cursor" aria-hidden />}
              </div>
            )}
          </div>
        )}

        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="msg-toolcalls">
            {message.toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}

        {message.content && <Markdown content={message.content} />}

        {isStreaming && message.content && <span className="chat-cursor" aria-hidden />}
        {isStreaming &&
          !message.content &&
          !message.reasoning &&
          !message.toolCalls?.length &&
          !message.compare && <span className="chat-cursor" aria-hidden />}

        {isError && (
          <div className="msg-error-detail">
            <span className="badge msg-error-code">{message.error?.code ?? 'error'}</span>
            <span>{message.error?.message ?? 'Something went wrong.'}</span>
          </div>
        )}

        {message.status === 'stopped' && <span className="badge msg-stopped-badge">stopped</span>}

        {usage &&
          (usage.promptTokens != null ||
            usage.completionTokens != null ||
            usage.totalTokens != null) && (
            <div className="msg-usage">
              {usage.promptTokens != null && <span>↑ {usage.promptTokens}</span>}
              {usage.cachedInputTokens != null && usage.cachedInputTokens > 0 && (
                <span title="Prompt tokens served from the provider's prompt cache (cheaper)">
                  {usage.cachedInputTokens} cached
                </span>
              )}
              {usage.completionTokens != null && <span>↓ {usage.completionTokens}</span>}
              {usage.totalTokens != null && <span>{usage.totalTokens} total</span>}
              {cost != null && (
                <span className="msg-cost" title={PRICING_DISCLAIMER}>
                  ≈ {formatCost(cost)}
                </span>
              )}
            </div>
          )}
      </div>
      {!isStreaming && (
        <div className="msg-actions" role="toolbar" aria-label="Message actions">
          <button
            type="button"
            className="btn-icon msg-action"
            aria-label={copied ? 'Copied' : 'Copy message'}
            title="Copy"
            onClick={() => copy(message.content)}
          >
            {copied ? '✓' : '⧉'}
          </button>
          {isLast && (
            <button
              type="button"
              className="btn-icon msg-action"
              aria-label="Regenerate response"
              title="Regenerate"
              onClick={() => void regenerate(message.id)}
              disabled={streaming !== null}
            >
              ↺
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function MessageItem({ message, isLast }: MessageItemProps): ReactElement {
  if (message.role === 'user') return <UserMessage message={message} />
  if (message.role === 'assistant') return <AssistantMessage message={message} isLast={isLast} />
  return (
    <div className="msg-row msg-row-meta">
      <div className="msg-meta">
        <span className="msg-meta-role">{message.role}</span>
        <span className="msg-meta-content">{message.content}</span>
      </div>
    </div>
  )
}

export default memo(MessageItem)
