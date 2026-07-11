import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type ReactElement,
} from 'react'
import type { Attachment, ChatParams, ResearchDepth } from '@shared/types'
import { modelSupportsVision } from '@shared/catalog'
import { formatBytes } from '@/lib/format'
import { providerUsable as isProviderUsable } from '@/lib/providers'
import { useChatStore } from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'
import { useProvidersStore } from '@/stores/providers'
import { usePromptsStore } from '@/stores/prompts'
import { useSkillsStore } from '@/stores/skills'
import { useUiStore } from '@/stores/ui'
import { toNormalized, unwrap } from '@/api/uld'
import ModelSelector from './ModelSelector'
import './chat.css'

const MAX_TEXTAREA_HEIGHT = 240 // ~10 lines
const CHAR_COUNT_THRESHOLD = 2000
const MENTION_DEBOUNCE_MS = 150
const MAX_PASTED_IMAGE_BYTES = 4 * 1024 * 1024
const PASTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the pasted image'))
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Could not read the pasted image'))
        return
      }
      const separator = reader.result.indexOf(',')
      if (separator < 0) {
        reject(new Error('Could not decode the pasted image'))
        return
      }
      resolve(reader.result.slice(separator + 1))
    }
    reader.readAsDataURL(file)
  })
}

/** One entry in the composer's slash-command menu. */
interface SlashItem {
  /** Text inserted into the input when picked. */
  command: string
  label: string
  description: string
  /** Command expects arguments after it (a trailing space is inserted). */
  takesArgs: boolean
}

/**
 * The @-mention token surrounding the caret: '@partial' with no whitespace,
 * either at the start of the text or after whitespace. Null when the caret is
 * not inside one.
 */
function mentionTokenAt(
  text: string,
  caret: number
): { start: number; end: number; query: string } | null {
  let start = caret
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1
  const token = text.slice(start, caret)
  if (!/^@[^\s@]*$/.test(token)) return null
  return { start, end: caret, query: token.slice(1) }
}

export default function Composer(): ReactElement {
  const conversation = useChatStore((s) => s.conversation)
  const streaming = useChatStore((s) => s.streaming)
  const send = useChatStore((s) => s.send)
  const stop = useChatStore((s) => s.stop)
  const updateConversation = useChatStore((s) => s.updateConversation)
  const settings = useSettingsStore((s) => s.settings)
  const providers = useProvidersStore((s) => s.providers)
  const openSettings = useUiStore((s) => s.openSettings)
  const toast = useUiStore((s) => s.toast)

  const promptTemplates = usePromptsStore((s) => s.templates)
  const loadPrompts = usePromptsStore((s) => s.load)
  const skills = useSkillsStore((s) => s.skills)
  const skillsLoaded = useSkillsStore((s) => s.loaded)

  const [value, setValue] = useState('')
  const [compareOn, setCompareOn] = useState(false)
  const [researchOn, setResearchOn] = useState(false)
  // '' = use the settings default depth for this run.
  const [researchDepth, setResearchDepth] = useState<ResearchDepth | ''>('')
  const [planBusy, setPlanBusy] = useState(false)
  const [autoAcceptBusy, setAutoAcceptBusy] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [pendingFiles, setPendingFiles] = useState<Attachment[] | null>(null)
  const [confirmFlash, setConfirmFlash] = useState(false)
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  // Slash-command / @-mention autocomplete state.
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null)
  const [mentionItems, setMentionItems] = useState<string[]>([])
  const [suggestIndex, setSuggestIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const confirmRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadPrompts()
  }, [loadPrompts])

  useEffect(() => {
    if (!skillsLoaded) void useSkillsStore.getState().load()
  }, [skillsLoaded])

  const insertPrompt = (body: string): void => {
    setPlusMenuOpen(false)
    setValue((cur) => (cur.trim().length > 0 ? `${cur}\n\n${body}` : body))
    textareaRef.current?.focus()
  }

  const effectiveProviderId = conversation?.providerId ?? settings?.defaultProviderId ?? null
  const effectiveProvider =
    (effectiveProviderId ? providers.find((p) => p.id === effectiveProviderId) : undefined) ??
    providers.find(isProviderUsable) ??
    null

  const providerUsable = (() => {
    if (providers.length === 0) return false
    // A per-conversation override must resolve to an enabled, keyed provider.
    // If it doesn't, don't silently fall back to the global default — the send
    // would fail against the stale override, so surface the banner instead.
    if (conversation?.providerId) {
      const p = providers.find((x) => x.id === conversation.providerId)
      return !!p && isProviderUsable(p)
    }
    if (settings?.defaultProviderId) {
      const p = providers.find((x) => x.id === settings.defaultProviderId)
      if (p) return isProviderUsable(p)
    }
    return providers.some(isProviderUsable)
  })()

  // Mixture of Agents: the composer toggle + preset dropdown. An active preset
  // supplies its own aggregator provider, so usability is checked against that
  // provider rather than the conversation's single-model selection.
  const enabledPresets = (settings?.moaPresets ?? []).filter((p) => p.enabled)
  const activePreset =
    conversation?.moaPresetId != null
      ? (enabledPresets.find((p) => p.id === conversation.moaPresetId) ?? null)
      : null
  const moaUsable = activePreset
    ? (() => {
        const p = providers.find((x) => x.id === activePreset.aggregator.providerId)
        return !!p && isProviderUsable(p)
      })()
    : false
  const usable = activePreset ? moaUsable : providerUsable

  // Compare ("Arena"): fan the preset's advisors out side by side instead of
  // aggregating. Uses the conversation's preset when set, else the default.
  const comparePreset =
    activePreset ??
    enabledPresets.find((p) => p.id === settings?.defaultMoaPresetId) ??
    enabledPresets[0] ??
    null

  // The toggles are per-conversation intents; don't leak them across switches.
  useEffect(() => {
    setCompareOn(false)
    setResearchOn(false)
    setResearchDepth('')
  }, [conversation?.id])

  const effectiveModelId = conversation?.modelId ?? effectiveProvider?.defaultModelId ?? ''
  // Preset-aware: for the 120+ preset-backed 'openai-compatible' providers
  // (empty family knownModels) the preset catalog is consulted, so
  // vision-capable preset models are recognized.
  const visionSupported = effectiveProvider
    ? modelSupportsVision(effectiveProvider, effectiveModelId)
    : false

  const isStreaming = streaming !== null
  const disabled = !conversation || isStreaming || !usable

  // -- slash-command menu -------------------------------------------------------

  const slashItems = useMemo<SlashItem[]>(() => {
    if (!conversation) return []
    const items: SlashItem[] = []
    if (conversation.mode === 'work' && conversation.projectId) {
      items.push({
        command: '/init',
        label: '/init',
        description: 'Create AGENTS.md for this project',
        takesArgs: false,
      })
    }
    items.push({
      command: '/compact',
      label: '/compact',
      description: 'Summarize older messages to free up context',
      takesArgs: false,
    })
    items.push({
      command: '/research',
      label: '/research <question>',
      description: 'Search the web and write a report with cited sources',
      takesArgs: true,
    })
    if (settings?.defaultMoaPresetId) {
      items.push({
        command: '/moa',
        label: '/moa <prompt>',
        description: 'Run one message through the default MoA preset',
        takesArgs: true,
      })
      items.push({
        command: '/compare',
        label: '/compare <prompt>',
        description: 'Ask the default MoA preset’s models side by side',
        takesArgs: true,
      })
    }
    for (const skill of skills.filter((s) => s.enabled)) {
      items.push({
        command: `/skill ${skill.name}`,
        label: `/skill ${skill.name}`,
        description: skill.description || 'Run this skill',
        takesArgs: true,
      })
    }
    return items
  }, [conversation, settings?.defaultMoaPresetId, skills])

  // The menu stays open while the first token is being typed ('/comp…') and
  // while a skill name is being chosen ('/skill ji…').
  const slashActive =
    !slashDismissed && (/^\/\S*$/.test(value) || /^\/skill\s\S*$/.test(value))
  const filteredSlash = slashActive
    ? slashItems.filter((item) => {
        const cmd = item.command.toLowerCase()
        const v = value.toLowerCase()
        if (!cmd.startsWith(v)) return false
        // Fully typed no-arg command: hide so Enter sends instead of re-picking.
        if (!item.takesArgs && cmd === v) return false
        return true
      })
    : []
  const slashVisible = filteredSlash.length > 0 && !isStreaming && !!conversation

  const pickSlash = (item: SlashItem): void => {
    setValue(item.takesArgs ? `${item.command} ` : item.command)
    setSuggestIndex(0)
    textareaRef.current?.focus()
  }

  // -- @-file mentions ----------------------------------------------------------

  const projectId = conversation?.projectId ?? null

  useEffect(() => {
    if (!mention || !projectId) {
      setMentionItems([])
      return
    }
    const token = window.setTimeout(() => {
      void window.uld.code
        .suggestFiles({ projectId, query: mention.query, limit: 8 })
        .then((res) => setMentionItems(res.ok ? res.data : []))
    }, MENTION_DEBOUNCE_MS)
    return () => window.clearTimeout(token)
  }, [mention, projectId])

  const mentionVisible = !slashVisible && mention !== null && mentionItems.length > 0

  const pickMention = (relPath: string): void => {
    const m = mention
    if (!m || !projectId) return
    setValue((cur) => `${cur.slice(0, m.start)}@${relPath} ${cur.slice(m.end)}`)
    setMention(null)
    setMentionItems([])
    setSuggestIndex(0)
    // Attach the mentioned file's content so the model actually sees it. An
    // explicit @-mention is an intentional share, so it skips the
    // warn-before-sending-files confirmation bar.
    void (async () => {
      const res = await window.uld.code.readFile({ projectId, relPath })
      if (!res.ok) {
        toast(`Could not attach ${relPath}: ${res.error.message}`, 'error')
        return
      }
      const attachment: Attachment = {
        id: crypto.randomUUID(),
        name: relPath,
        mimeType: 'text/plain',
        sizeBytes: res.data.sizeBytes,
        kind: 'text',
        textContent: res.data.truncated ? `${res.data.content}\n…[truncated]` : res.data.content,
      }
      setAttachments((prev) =>
        prev.some((a) => a.kind !== 'image' && a.name === relPath) ? prev : [...prev, attachment]
      )
    })()
    textareaRef.current?.focus()
  }

  // Reset menu selection whenever the candidate list changes.
  useEffect(() => {
    setSuggestIndex(0)
  }, [value, mentionItems.length])

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

  /**
   * '/init' — generate AGENTS.md for the granted project. Probes for an
   * existing file first (nothing to do then); otherwise sends the literal
   * '/init', which main expands to the full init prompt on the wire.
   */
  const runInitCommand = (): void => {
    const conv = conversation
    if (!conv || conv.mode !== 'work' || !conv.projectId) {
      toast('/init needs a work task with a connected folder.', 'error')
      return
    }
    if (attachments.length > 0) {
      toast('Remove the attachments before running /init.', 'error')
      return
    }
    const projectId = conv.projectId
    setValue('')
    void (async () => {
      const existing = await window.uld.code.readFile({ projectId, relPath: 'AGENTS.md' })
      if (existing.ok) {
        toast('AGENTS.md already exists in this project — nothing to create.', 'info')
        return
      }
      await send('/init')
    })()
  }

  const submit = (): void => {
    const content = value.trim()
    if (!content && attachments.length === 0) return
    if (disabled) return
    if (content === '/init') {
      runInitCommand()
      return
    }
    // Never silently drop attachments still awaiting the send-confirmation:
    // block the send and pull attention to the confirm bar instead.
    if (pendingFiles && pendingFiles.length > 0) {
      toast('Confirm or cancel the attached files before sending.', 'error')
      flashConfirm()
      return
    }
    const sentAttachments = attachments.length > 0 ? attachments : undefined
    const sendOpts = researchOn
      ? { research: researchDepth ? { depth: researchDepth } : {} }
      : compareOn && comparePreset
        ? { comparePresetId: comparePreset.id }
        : undefined
    setValue('')
    setAttachments([])
    setMention(null)
    setMentionItems([])
    void (async () => {
      await send(content, sentAttachments, sendOpts)
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

  const queueAttachments = (picked: Attachment[]): void => {
    let files = picked
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

  const handleAttach = async (): Promise<void> => {
    const res = await window.uld.app.pickFiles()
    if (!res.ok) {
      toast(res.error.message, 'error')
      return
    }
    queueAttachments(res.data.attachments)
  }

  const handlePaste = (event: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && PASTED_IMAGE_MIME_TYPES.has(item.type))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)

    if (imageFiles.length === 0) return
    event.preventDefault()

    if (!visionSupported) {
      toast('This model has no vision support — the pasted image was not attached.', 'info')
      return
    }

    void (async () => {
      const pasted: Attachment[] = []
      for (const file of imageFiles) {
        if (file.size === 0) {
          toast('The pasted image is empty.', 'error')
          continue
        }
        if (file.size > MAX_PASTED_IMAGE_BYTES) {
          toast('The pasted image exceeds the 4 MB limit.', 'error')
          continue
        }
        try {
          const dataBase64 = await fileAsBase64(file)
          const res = await window.uld.app.storePastedImage({ mimeType: file.type, dataBase64 })
          if (!res.ok) {
            toast(res.error.message, 'error')
            continue
          }
          pasted.push(res.data)
        } catch (error) {
          toast(toNormalized(error).message, 'error')
        }
      }
      if (pasted.length > 0) queueAttachments(pasted)
    })()
  }

  const placeholder = !conversation
    ? 'Select or create a conversation to start'
    : isStreaming
      ? 'Generating… press Stop to interrupt'
      : !usable
        ? 'Configure a provider to start chatting'
        : 'Send a message… (Enter to send, Shift+Enter for a new line)'

  const toggleMoa = (): void => {
    if (activePreset) {
      void updateConversation({ moaPresetId: null })
      return
    }
    const pick =
      enabledPresets.find((p) => p.id === settings?.defaultMoaPresetId) ?? enabledPresets[0]
    if (pick) void updateConversation({ moaPresetId: pick.id })
  }

  const togglePlanMode = async (): Promise<void> => {
    if (!conversation || conversation.mode !== 'work') return
    setPlanBusy(true)
    try {
      const params: ChatParams = { ...conversation.params }
      if (params.planMode === true) delete params.planMode
      else params.planMode = true
      const updated = await unwrap(
        window.uld.conversations.update({ id: conversation.id, patch: { params } })
      )
      useChatStore.setState({ conversation: updated })
    } catch (error) {
      toast(`Could not toggle plan mode: ${toNormalized(error).message}`, 'error')
    } finally {
      setPlanBusy(false)
    }
  }

  const toggleAutoAcceptEdits = async (): Promise<void> => {
    if (!conversation || conversation.mode !== 'work') return
    setAutoAcceptBusy(true)
    try {
      const params: ChatParams = { ...conversation.params }
      if (params.autoAcceptEdits === true) delete params.autoAcceptEdits
      else params.autoAcceptEdits = true
      const updated = await unwrap(
        window.uld.conversations.update({ id: conversation.id, patch: { params } })
      )
      useChatStore.setState({ conversation: updated })
    } catch (error) {
      toast(`Could not toggle auto-accept edits: ${toNormalized(error).message}`, 'error')
    } finally {
      setAutoAcceptBusy(false)
    }
  }

  return (
    <div className="composer">
      {!usable && (
        <div className="composer-banner" role="status">
          <span>
            {activePreset
              ? 'The aggregator provider for this Mixture-of-Agents preset has no API key or is disabled.'
              : providers.length === 0
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
          className="btn-icon composer-attach-button"
          aria-label="Add files or photos"
          title="Add files or photos"
          disabled={!conversation || isStreaming}
          onClick={() => void handleAttach()}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path d="m20.5 11.5-8.7 8.7a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7L9 17.4a2 2 0 0 1-2.8-2.8l8.6-8.6" />
          </svg>
        </button>
        <div className="composer-plus">
          <button
            type="button"
            className={`btn-icon composer-plus-button${plusMenuOpen ? ' open' : ''}`}
            aria-label="Open tools and modes"
            title="Choose tools and modes"
            aria-haspopup="menu"
            aria-expanded={plusMenuOpen}
            disabled={!conversation || isStreaming}
            onClick={() => setPlusMenuOpen((open) => !open)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 2.5v11M2.5 8h11" />
            </svg>
          </button>
          {plusMenuOpen ? (
            <>
              <div
                className="composer-plus-backdrop"
                aria-hidden
                onClick={() => setPlusMenuOpen(false)}
              />
              <div className="composer-plus-menu" role="menu" aria-label="Tools and modes">
                {promptTemplates.length > 0 ? (
                  <>
                    <div className="composer-plus-heading">Saved prompts</div>
                    {promptTemplates.map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        role="menuitem"
                        className="composer-plus-item composer-plus-prompt"
                        title={template.body}
                        onClick={() => insertPrompt(template.body)}
                      >
                        <span className="composer-plus-icon" aria-hidden>⚡</span>
                        <span>{template.title}</span>
                      </button>
                    ))}
                    <div className="composer-plus-separator" />
                  </>
                ) : null}
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={researchOn}
                  className="composer-plus-item"
                  onClick={() => setResearchOn((value) => {
                    if (!value) setCompareOn(false)
                    return !value
                  })}
                >
                  <span className="composer-plus-check" aria-hidden>{researchOn ? '✓' : ''}</span>
                  <span>Deep Research</span>
                </button>
                {researchOn ? (
                  <label className="composer-plus-subcontrol">
                    <span>Depth</span>
                    <select
                      value={researchDepth}
                      onChange={(e) => setResearchDepth(e.target.value as ResearchDepth | '')}
                    >
                      <option value="">{settings?.researchDefaultDepth ?? 'standard'} (default)</option>
                      <option value="quick">quick</option>
                      <option value="standard">standard</option>
                      <option value="deep">deep</option>
                    </select>
                  </label>
                ) : null}
                {enabledPresets.length > 0 ? (
                  <>
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={!!activePreset}
                      className="composer-plus-item"
                      onClick={toggleMoa}
                    >
                      <span className="composer-plus-check" aria-hidden>{activePreset ? '✓' : ''}</span>
                      <span>Mixture of Agents</span>
                    </button>
                    {activePreset && enabledPresets.length > 1 ? (
                      <label className="composer-plus-subcontrol">
                        <span>Preset</span>
                        <select
                          value={activePreset.id}
                          onChange={(e) => void updateConversation({ moaPresetId: e.target.value })}
                        >
                          {enabledPresets.map((preset) => (
                            <option key={preset.id} value={preset.id}>{preset.name}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={compareOn}
                      className="composer-plus-item"
                      disabled={!comparePreset}
                      onClick={() => setCompareOn((value) => {
                        if (!value) setResearchOn(false)
                        return !value
                      })}
                    >
                      <span className="composer-plus-check" aria-hidden>{compareOn ? '✓' : ''}</span>
                      <span>Compare models (VS)</span>
                    </button>
                  </>
                ) : null}
                {conversation?.mode === 'work' ? (
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={conversation.params.planMode === true}
                    className="composer-plus-item"
                    disabled={planBusy}
                    onClick={() => void togglePlanMode()}
                  >
                    <span className="composer-plus-check" aria-hidden>
                      {conversation.params.planMode === true ? '✓' : ''}
                    </span>
                    <span>Plan Mode</span>
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
        {conversation?.mode === 'work' ? (
          <button
            type="button"
            className={`composer-autoaccept${conversation.params.autoAcceptEdits === true ? ' active' : ''}`}
            aria-pressed={conversation.params.autoAcceptEdits === true}
            title="Apply assistant file edits without asking for each edit"
            disabled={autoAcceptBusy || isStreaming}
            onClick={() => void toggleAutoAcceptEdits()}
          >
            Auto-accept edits
          </button>
        ) : null}
        {(slashVisible || mentionVisible) && (
          <ul
            className="composer-suggest"
            role="listbox"
            aria-label={slashVisible ? 'Commands' : 'Project files'}
          >
            {slashVisible
              ? filteredSlash.map((item, i) => (
                  <li key={item.command} role="option" aria-selected={i === suggestIndex}>
                    <button
                      type="button"
                      className={`composer-suggest-item${i === suggestIndex ? ' active' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickSlash(item)}
                    >
                      <span className="composer-suggest-name mono">{item.label}</span>
                      <span className="composer-suggest-desc">{item.description}</span>
                    </button>
                  </li>
                ))
              : mentionItems.map((relPath, i) => (
                  <li key={relPath} role="option" aria-selected={i === suggestIndex}>
                    <button
                      type="button"
                      className={`composer-suggest-item${i === suggestIndex ? ' active' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickMention(relPath)}
                    >
                      <span className="composer-suggest-name mono">{relPath}</span>
                    </button>
                  </li>
                ))}
          </ul>
        )}
        <div className="composer-textarea-wrap">
          <textarea
            ref={textareaRef}
            className="textarea composer-textarea"
            rows={1}
            value={value}
            placeholder={placeholder}
            disabled={!conversation || isStreaming}
            aria-label="Message"
            onPaste={handlePaste}
            onChange={(e) => {
              setValue(e.target.value)
              setSlashDismissed(false)
              setMention(mentionTokenAt(e.target.value, e.target.selectionStart ?? 0))
            }}
            onKeyDown={(e) => {
              const menuLength = slashVisible
                ? filteredSlash.length
                : mentionVisible
                  ? mentionItems.length
                  : 0
              if (menuLength > 0 && !e.nativeEvent.isComposing) {
                const index = Math.min(suggestIndex, menuLength - 1)
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setSuggestIndex((index + 1) % menuLength)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSuggestIndex((index - 1 + menuLength) % menuLength)
                  return
                }
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                  e.preventDefault()
                  if (slashVisible) pickSlash(filteredSlash[index])
                  else pickMention(mentionItems[index])
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  if (slashVisible) setSlashDismissed(true)
                  else {
                    setMention(null)
                    setMentionItems([])
                  }
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <ModelSelector placement="composer" />
        </div>
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
