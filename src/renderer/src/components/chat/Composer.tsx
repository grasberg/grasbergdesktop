import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { Attachment } from '@shared/types'
import { UNKNOWN_MODEL_CAPS, findCatalogModel } from '@shared/catalog'
import { useChatStore } from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'
import { useProvidersStore } from '@/stores/providers'
import { usePromptsStore } from '@/stores/prompts'
import { useUiStore } from '@/stores/ui'
import './chat.css'

const MAX_TEXTAREA_HEIGHT = 240 // ~10 lines
const CHAR_COUNT_THRESHOLD = 2000

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function Composer(): ReactElement {
  const conversation = useChatStore((s) => s.conversation)
  const streaming = useChatStore((s) => s.streaming)
  const send = useChatStore((s) => s.send)
  const stop = useChatStore((s) => s.stop)
  const settings = useSettingsStore((s) => s.settings)
  const providers = useProvidersStore((s) => s.providers)
  const openSettings = useUiStore((s) => s.openSettings)
  const toast = useUiStore((s) => s.toast)

  const promptTemplates = usePromptsStore((s) => s.templates)
  const loadPrompts = usePromptsStore((s) => s.load)

  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [pendingFiles, setPendingFiles] = useState<Attachment[] | null>(null)
  const [confirmFlash, setConfirmFlash] = useState(false)
  const [promptMenuOpen, setPromptMenuOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const confirmRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadPrompts()
  }, [loadPrompts])

  const insertPrompt = (body: string): void => {
    setPromptMenuOpen(false)
    setValue((cur) => (cur.trim().length > 0 ? `${cur}\n\n${body}` : body))
    textareaRef.current?.focus()
  }

  const effectiveProviderId = conversation?.providerId ?? settings?.defaultProviderId ?? null
  const effectiveProvider =
    (effectiveProviderId ? providers.find((p) => p.id === effectiveProviderId) : undefined) ??
    providers.find((p) => p.enabled && p.hasKey) ??
    null

  const providerUsable = (() => {
    if (providers.length === 0) return false
    // A per-conversation override must resolve to an enabled, keyed provider.
    // If it doesn't, don't silently fall back to the global default — the send
    // would fail against the stale override, so surface the banner instead.
    if (conversation?.providerId) {
      const p = providers.find((x) => x.id === conversation.providerId)
      return !!p && p.enabled && p.hasKey
    }
    if (settings?.defaultProviderId) {
      const p = providers.find((x) => x.id === settings.defaultProviderId)
      if (p) return p.enabled && p.hasKey
    }
    return providers.some((p) => p.enabled && p.hasKey)
  })()

  const effectiveModelId = conversation?.modelId ?? effectiveProvider?.defaultModelId ?? ''
  const visionSupported = effectiveProvider
    ? (findCatalogModel(effectiveProvider.type, effectiveModelId)?.capabilities.vision ??
      UNKNOWN_MODEL_CAPS.vision)
    : false

  const isStreaming = streaming !== null
  const disabled = !conversation || isStreaming || !providerUsable

  const resize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden'
  }, [])

  useEffect(() => {
    resize()
  }, [value, resize])

  // Refocus after a generation finishes.
  useEffect(() => {
    if (!isStreaming && conversation) textareaRef.current?.focus()
  }, [isStreaming, conversation])

  const flashConfirm = (): void => {
    setConfirmFlash(true)
    confirmRef.current?.focus()
    window.setTimeout(() => setConfirmFlash(false), 800)
  }

  const submit = (): void => {
    const content = value.trim()
    if (!content && attachments.length === 0) return
    if (disabled) return
    // Never silently drop attachments still awaiting the send-confirmation:
    // block the send and pull attention to the confirm bar instead.
    if (pendingFiles && pendingFiles.length > 0) {
      toast('Confirm or cancel the attached files before sending.', 'error')
      flashConfirm()
      return
    }
    const sentAttachments = attachments.length > 0 ? attachments : undefined
    setValue('')
    setAttachments([])
    void (async () => {
      await send(content, sentAttachments)
      // send() sets `error` (without starting a stream) when the send fails —
      // e.g. a stale provider override. Restore the draft so it isn't lost.
      const st = useChatStore.getState()
      if (!st.streaming && st.error) {
        setValue((cur) => (cur.length > 0 ? cur : content))
        if (sentAttachments) setAttachments((cur) => (cur.length > 0 ? cur : sentAttachments))
        textareaRef.current?.focus()
      }
    })()
  }

  const handleAttach = async (): Promise<void> => {
    const res = await window.uld.app.pickFiles()
    if (!res.ok) {
      toast(res.error.message, 'error')
      return
    }
    let files = res.data.attachments
    // Drop images the effective model can't see, rather than sending them to a
    // text-only endpoint that would reject or ignore them.
    if (!visionSupported && files.some((f) => f.kind === 'image')) {
      files = files.filter((f) => f.kind !== 'image')
      toast('This model has no vision support — images were not attached.', 'info')
    }
    if (files.length === 0) return
    if (settings?.warnBeforeSendingFiles) {
      // Merge into any files already awaiting confirmation rather than
      // replacing them (which would silently drop the earlier picks).
      setPendingFiles((prev) => [...(prev ?? []), ...files])
    } else {
      setAttachments((prev) => [...prev, ...files])
    }
  }

  const placeholder = !conversation
    ? 'Select or create a conversation to start'
    : isStreaming
      ? 'Generating… press Stop to interrupt'
      : !providerUsable
        ? 'Configure a provider to start chatting'
        : 'Send a message… (Enter to send, Shift+Enter for a new line)'

  return (
    <div className="composer">
      {!providerUsable && (
        <div className="composer-banner" role="status">
          <span>
            {providers.length === 0
              ? 'No providers configured yet.'
              : 'The selected provider has no API key or is disabled.'}
          </span>
          <button type="button" className="btn btn-primary" onClick={() => openSettings(true)}>
            Open Settings
          </button>
        </div>
      )}

      {pendingFiles && pendingFiles.length > 0 && (
        <div
          ref={confirmRef}
          tabIndex={-1}
          className={`composer-confirm${confirmFlash ? ' composer-confirm-flash' : ''}`}
          role="alertdialog"
          aria-label="Confirm file attachment"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // Cancel the attachment; don't let Escape reach the global handler
              // (which would stop an in-flight generation).
              e.preventDefault()
              e.stopPropagation()
              setPendingFiles(null)
              textareaRef.current?.focus()
            }
          }}
        >
          <span>
            File contents will be sent to{' '}
            <strong>{effectiveProvider?.label ?? 'the provider'}</strong>. Continue?
          </span>
          <div className="composer-confirm-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setAttachments((prev) => [...prev, ...pendingFiles])
                setPendingFiles(null)
              }}
            >
              Continue
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setPendingFiles(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((a) => (
            <span key={a.id} className="composer-attachment-chip" title={a.name}>
              {a.kind === 'image' && a.dataUrl ? (
                <img className="composer-attachment-thumb" src={a.dataUrl} alt="" />
              ) : null}
              <span className="composer-attachment-name">{a.name}</span>
              <span className="composer-attachment-size">{formatBytes(a.sizeBytes)}</span>
              <button
                type="button"
                className="composer-attachment-remove"
                aria-label={`Remove attachment ${a.name}`}
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="composer-inputrow">
        <button
          type="button"
          className="btn-icon composer-attach"
          aria-label="Attach files"
          title="Attach files"
          disabled={disabled}
          onClick={() => void handleAttach()}
        >
          📎
        </button>
        {promptTemplates.length > 0 && (
          <div className="composer-prompts">
            <button
              type="button"
              className="btn-icon composer-attach"
              aria-label="Insert a saved prompt"
              title="Insert a saved prompt"
              aria-haspopup="menu"
              aria-expanded={promptMenuOpen}
              disabled={!conversation || isStreaming}
              onClick={() => setPromptMenuOpen((o) => !o)}
            >
              ⚡
            </button>
            {promptMenuOpen && (
              <>
                <div
                  className="composer-prompts-backdrop"
                  onClick={() => setPromptMenuOpen(false)}
                  aria-hidden
                />
                <ul className="composer-prompts-menu" role="menu">
                  {promptTemplates.map((t) => (
                    <li key={t.id} role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="composer-prompts-item"
                        title={t.body}
                        onClick={() => insertPrompt(t.body)}
                      >
                        {t.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="textarea composer-textarea"
          rows={1}
          value={value}
          placeholder={placeholder}
          disabled={!conversation || isStreaming}
          aria-label="Message"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {isStreaming ? (
          <button
            type="button"
            className="btn btn-danger composer-send"
            aria-label="Stop generating"
            onClick={() => void stop()}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary composer-send"
            aria-label="Send message"
            disabled={disabled || (!value.trim() && attachments.length === 0)}
            onClick={submit}
          >
            Send
          </button>
        )}
      </div>

      {value.length >= CHAR_COUNT_THRESHOLD && (
        <div className="composer-charcount" aria-hidden>
          {value.length.toLocaleString()} characters
        </div>
      )}
    </div>
  )
}
