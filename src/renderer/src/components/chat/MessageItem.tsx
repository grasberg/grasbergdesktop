import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'
import type { Attachment, FailoverReason, Message, MoaReferenceOutput } from '@shared/types'
import { estimateCost, findPricing, formatCost, PRICING_DISCLAIMER } from '@shared/pricing'
import { presetPricing } from '@shared/presets'
import { useCopied } from '@/hooks/useCopied'
import { formatBytes } from '@/lib/format'
import { ttsSupported } from '@/lib/tts'
import { useChatStore } from '@/stores/chat'
import { useCodeStore } from '@/stores/code'
import { useConversationsStore } from '@/stores/conversations'
import { useProvidersStore } from '@/stores/providers'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { sttReady, useVoiceStore } from '@/stores/voice'
import GeneratedImage from './GeneratedImage'
import Markdown from './Markdown'
import ModelPickList from './ModelPickList'
import ResearchProgress from './ResearchProgress'
import ToolCallCard from './ToolCallCard'
import './chat.css'

interface MessageItemProps {
  message: Message
  isLast: boolean
}

/** Attachment chip with a lazily-loaded thumbnail for stored images. */
function AttachmentChip({
  attachment,
  messageId,
}: {
  attachment: Attachment
  /** Set on persisted messages: lets audio Transcribe write onto the message. */
  messageId?: string
}): ReactElement {
  const [src, setSrc] = useState<string | null>(attachment.dataUrl ?? null)
  const [transcribing, setTranscribing] = useState(false)
  const voiceStatus = useVoiceStore((s) => s.status)
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

  const extractionNote =
    attachment.kind === 'pdf'
      ? [
          attachment.extraction === 'text'
            ? 'text extracted'
            : attachment.extraction === 'ocr'
              ? 'OCR'
              : 'no text extracted',
          ...(attachment.rawAttach ? ['sent as original PDF'] : []),
        ].join(', ')
      : attachment.kind === 'audio'
        ? attachment.extractedText
          ? 'transcribed'
          : 'not transcribed'
        : null

  // Persisted-message audio: transcribe + store the transcript on the message
  // (the conversationsChanged push then refreshes the transcript everywhere).
  const transcribe = (): void => {
    if (!attachment.storageKey || !messageId) return
    setTranscribing(true)
    void window.uld.voice
      .transcribeAttachment({
        storageKey: attachment.storageKey,
        messageId,
        attachmentId: attachment.id,
      })
      .then((res) => {
        if (!res.ok) {
          useUiStore.getState().toast(`Could not transcribe ${attachment.name}: ${res.error.message}`, 'error')
        }
      })
      .finally(() => setTranscribing(false))
  }

  const canTranscribe =
    attachment.kind === 'audio' &&
    !!attachment.storageKey &&
    !!messageId &&
    !attachment.extractedText &&
    sttReady(voiceStatus)

  return (
    <span
      className="msg-attachment-chip"
      title={extractionNote ? `${attachment.name} (${extractionNote})` : attachment.name}
    >
      {attachment.kind === 'image' && src ? (
        <img className="msg-attachment-thumb" src={src} alt="" />
      ) : null}
      {attachment.kind === 'pdf' ? (
        <span className="msg-attachment-badge" aria-hidden>
          PDF
        </span>
      ) : null}
      {attachment.kind === 'audio' ? (
        <span className="msg-attachment-badge" aria-hidden>
          AUDIO
        </span>
      ) : null}
      <span className="msg-attachment-name">{attachment.name}</span>
      <span className="msg-attachment-size">{formatBytes(attachment.sizeBytes)}</span>
      {attachment.kind === 'audio' && attachment.extractedText ? (
        <span className="msg-attachment-note">transcribed</span>
      ) : null}
      {transcribing ? (
        <span className="msg-attachment-note">Transcribing…</span>
      ) : canTranscribe ? (
        <button
          type="button"
          className="msg-attachment-transcribe"
          title="Transcribe this audio with the local whisper model"
          onClick={transcribe}
        >
          Transcribe
        </button>
      ) : null}
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
                  <AttachmentChip key={a.id} attachment={a} messageId={message.id} />
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
          <ForkAction message={message} />
        </div>
      )}
    </div>
  )
}

/**
 * Mixture of Agents transparency: the advisor (reference) model outputs that fed
 * the aggregator, as a collapsible section of labelled blocks above the answer.
 */
/**
 * The body of a single advisor/model reference: the same error → text →
 * running → empty ladder shared by the MoA list and the compare columns (only
 * the "unavailable" fallback wording differs).
 */
function ReferenceBody({
  reference,
  unavailableText,
}: {
  reference: MoaReferenceOutput
  unavailableText: string
}): ReactElement {
  if (reference.status === 'error') {
    return <div className="msg-moa-ref-error">{reference.error?.message ?? unavailableText}</div>
  }
  if (reference.text) return <Markdown content={reference.text} />
  if (reference.status === 'running') return <span className="chat-cursor" aria-hidden />
  return <div className="msg-moa-ref-empty">(no output)</div>
}

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
              <ReferenceBody reference={ref} unavailableText="This advisor was unavailable." />
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
            <ReferenceBody reference={ref} unavailableText="This model was unavailable." />
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

/**
 * The chevron half of the Regenerate split button: opens the shared
 * provider/model list and re-runs the answer with the picked model as a
 * ONE-OFF override — the conversation's own model choice stays untouched.
 */
function RegenerateWithMenu({ message }: { message: Message }): ReactElement {
  const regenerate = useChatStore((s) => s.regenerate)
  const streaming = useChatStore((s) => s.streaming)
  const [open, setOpen] = useState(false)
  const [keepOriginal, setKeepOriginal] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // Second opinion converts the message into a compare message — only offer
  // it for a plain completed answer (the backend guards the same way).
  const canSecondOpinion =
    message.status === 'complete' &&
    !message.compare &&
    (message.moaReferences?.length ?? 0) === 0 &&
    message.content.trim().length > 0

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Move focus into the popover on open (like ModelSelector) so Escape and
  // arrow-key navigation work immediately instead of landing on the trigger.
  useEffect(() => {
    if (!open) return
    const pop = popRef.current
    const first =
      pop?.querySelector<HTMLElement>('input[type="checkbox"]') ??
      pop?.querySelector<HTMLElement>('[data-nav-row]')
    first?.focus()
  }, [open])

  const onPopoverKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const pop = popRef.current
    if (!pop) return
    const rows = Array.from(pop.querySelectorAll<HTMLElement>('[data-nav-row]'))
    if (rows.length === 0) return
    e.preventDefault()
    const current = rows.indexOf(document.activeElement as HTMLElement)
    const delta = e.key === 'ArrowDown' ? 1 : -1
    const next = current === -1 ? 0 : (current + delta + rows.length) % rows.length
    rows[next]?.focus()
  }

  return (
    <div className="msg-regen-menu" ref={rootRef}>
      <button
        type="button"
        className="btn-icon msg-action"
        aria-label="Regenerate with another model"
        title="Regenerate with another model…"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={streaming !== null}
        onClick={() => setOpen((o) => !o)}
      >
        ▾
      </button>
      {open && (
        <div
          className="ms-popover msg-regen-popover"
          ref={popRef}
          role="listbox"
          aria-label="Regenerate with model"
          onKeyDown={onPopoverKeyDown}
        >
          <div className="ms-group-header">
            {keepOriginal && canSecondOpinion ? 'Second opinion from…' : 'Regenerate with…'}
          </div>
          {canSecondOpinion && (
            <label className="msg-regen-keep">
              <input
                type="checkbox"
                checked={keepOriginal}
                onChange={(e) => setKeepOriginal(e.target.checked)}
              />
              Keep this answer — show the new one beside it
            </label>
          )}
          <ModelPickList
            onPick={(providerId, modelId) => {
              setOpen(false)
              void regenerate(message.id, {
                overrides: { providerId, modelId },
                ...(keepOriginal && canSecondOpinion
                  ? { mode: 'second-opinion' as const }
                  : {}),
              })
            }}
          />
        </div>
      )}
    </div>
  )
}

/** "Fork from here": copies the conversation up to this message into a new one. */
function ForkAction({ message }: { message: Message }): ReactElement | null {
  const conversationId = useChatStore((s) => s.conversation?.id ?? null)
  const streaming = useChatStore((s) => s.streaming)
  if (!conversationId) return null
  return (
    <button
      type="button"
      className="btn-icon msg-action"
      aria-label="Fork from here"
      title="Fork from here"
      disabled={streaming !== null}
      onClick={() => void useConversationsStore.getState().fork(conversationId, message.id)}
    >
      ⑂
    </button>
  )
}

/**
 * "Undo file changes (n files)" for an assistant turn that applied changes:
 * shown when the conversation's checkpoints contain entries stamped with this
 * message's seq. Two-step confirm; the store reports partial outcomes honestly.
 */
function UndoTurnAction({ message }: { message: Message }): ReactElement | null {
  const conversationId = useChatStore((s) => s.conversation?.id ?? null)
  const streaming = useChatStore((s) => s.streaming)
  const checkpoints = useCodeStore((s) => s.checkpoints)
  const checkpointsConversationId = useCodeStore((s) => s.checkpointsConversationId)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  // The code store is a singleton that outlives WorkView: after switching to
  // a chat-mode conversation it can still hold ANOTHER conversation's
  // checkpoints, and per-conversation seqs collide across conversations —
  // only trust checkpoints that belong to the open conversation.
  const ownCheckpoints =
    conversationId !== null && checkpointsConversationId === conversationId

  const files = useMemo(() => {
    if (!ownCheckpoints) return []
    const paths = new Set<string>()
    for (const checkpoint of checkpoints) {
      if (checkpoint.messageSeq === message.seq) {
        for (const path of checkpoint.filePaths) paths.add(path)
      }
    }
    return [...paths]
  }, [ownCheckpoints, checkpoints, message.seq])

  if (!conversationId || files.length === 0) return null

  if (confirming) {
    return (
      <>
        <button
          type="button"
          className="btn-icon msg-action"
          aria-label={`Confirm: revert ${files.length} file${files.length === 1 ? '' : 's'}`}
          title={`Yes, revert ${files.join(', ')}`}
          disabled={busy}
          onClick={() => {
            setConfirming(false)
            setBusy(true)
            void useCodeStore
              .getState()
              .revertTurn(conversationId, message.seq)
              .finally(() => setBusy(false))
          }}
        >
          ✓
        </button>
        <button
          type="button"
          className="btn-icon msg-action"
          aria-label="Cancel undo"
          title="Cancel"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          ✕
        </button>
      </>
    )
  }

  return (
    <button
      type="button"
      className="btn-icon msg-action"
      aria-label={`Undo file changes (${files.length} file${files.length === 1 ? '' : 's'})`}
      title={`Undo file changes (${files.length} file${files.length === 1 ? '' : 's'})`}
      disabled={busy || streaming !== null}
      onClick={() => setConfirming(true)}
    >
      ⎌
    </button>
  )
}

/**
 * Read-aloud (offline system voice). Also rendered while the message is still
 * streaming — the voice store follows the stream and speaks sentences as they
 * complete. Hidden unless the toggle is on and this platform can speak.
 */
function ReadAloudAction({ message }: { message: Message }): ReactElement | null {
  const enabled = useSettingsStore((s) => s.settings?.voiceReadAloudEnabled === true)
  const speakingId = useVoiceStore((s) => s.speakingMessageId)
  if (!enabled || !ttsSupported()) return null
  const speaking = speakingId === message.id
  return (
    <button
      type="button"
      className={`btn-icon msg-action${speaking ? ' msg-action-active' : ''}`}
      aria-label={speaking ? 'Stop reading' : 'Read aloud'}
      title={speaking ? 'Stop reading' : 'Read aloud'}
      onClick={() =>
        speaking
          ? useVoiceStore.getState().stopSpeaking()
          : useVoiceStore.getState().play(message.id)
      }
    >
      {speaking ? '◼' : '▶'}
    </button>
  )
}

/** Human reason for a Reliability Autopilot hop (the header note). */
function failoverReasonText(code: FailoverReason): string {
  switch (code) {
    case 'rate_limit':
      return 'rate limited'
    case 'server':
      return 'provider error'
    case 'network':
      return 'network error'
    case 'timeout':
      return 'timed out'
    case 'empty_reply':
      return 'empty reply'
    default:
      return code
  }
}

function AssistantMessage({ message, isLast }: MessageItemProps): ReactElement {
  const regenerate = useChatStore((s) => s.regenerate)
  const streaming = useChatStore((s) => s.streaming)
  const readAloudOn = useSettingsStore((s) => s.settings?.voiceReadAloudEnabled === true)
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
        {message.failedOverFrom && message.failedOverFrom.length > 0 && (
          <div className="msg-failover-note">
            Fell back from{' '}
            {message.failedOverFrom
              .map(
                (hop) =>
                  `${providers.find((p) => p.id === hop.providerId)?.label ?? hop.providerId} · ${
                    hop.modelId
                  } (${failoverReasonText(hop.code)})`
              )
              .join(', ')}
          </div>
        )}

        {message.research && (
          <ResearchProgress research={message.research} streaming={isStreaming} />
        )}

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

        {message.attachments && message.attachments.length > 0 && (
          <div className="msg-genimages">
            {message.attachments.map((a) =>
              a.kind === 'image' ? (
                <GeneratedImage key={a.id} attachment={a} />
              ) : (
                <AttachmentChip key={a.id} attachment={a} messageId={message.id} />
              )
            )}
          </div>
        )}

        {message.content && (
          <Markdown content={message.content} citations={message.research?.sources} />
        )}

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
      {(!isStreaming || readAloudOn) && (
        <div className="msg-actions" role="toolbar" aria-label="Message actions">
          <ReadAloudAction message={message} />
          {!isStreaming && (
            <>
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
                <>
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
                  <RegenerateWithMenu message={message} />
                </>
              )}
              <ForkAction message={message} />
              <UndoTurnAction message={message} />
            </>
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
