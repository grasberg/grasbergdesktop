import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type ReactElement,
} from 'react'
import type { Attachment, ChatParams, ResearchDepth, SandboxLevel } from '@shared/types'
import { modelSupportsVision } from '@shared/catalog'
import { formatBytes } from '@/lib/format'
import { providerUsable as isProviderUsable } from '@/lib/providers'
import { useChatStore } from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'
import { useProvidersStore } from '@/stores/providers'
import { usePromptsStore } from '@/stores/prompts'
import { useSkillsStore } from '@/stores/skills'
import { useUiStore } from '@/stores/ui'
import { sttReady, useVoiceStore } from '@/stores/voice'
import { MicDeniedError, VoiceRecorder } from '@/lib/recorder'
import { toNormalized, unwrap } from '@/api/uld'
import ModelSelector from './ModelSelector'
import './chat.css'

const MAX_TEXTAREA_HEIGHT = 240 // ~10 lines
const CHAR_COUNT_THRESHOLD = 2000
const MENTION_DEBOUNCE_MS = 150
const MAX_PASTED_IMAGE_BYTES = 4 * 1024 * 1024
// Mirrors the authoritative main-side cap (src/main/ipc/attachments.ts).
const MAX_RAW_ATTACH_BYTES = Math.floor(4.5 * 1024 * 1024)
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
  // Attachment ids with a text-extraction/OCR call in flight.
  const [extractingIds, setExtractingIds] = useState<Set<string>>(new Set())
  const [confirmFlash, setConfirmFlash] = useState(false)
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  // Slash-command / @-mention autocomplete state.
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null)
  const [mentionItems, setMentionItems] = useState<string[]>([])
  const [suggestIndex, setSuggestIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const confirmRef = useRef<HTMLDivElement>(null)

  // Push-to-talk (offline whisper.cpp).
  const voiceStatus = useVoiceStore((s) => s.status)
  const [recState, setRecState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [recSeconds, setRecSeconds] = useState(0)
  const recorderRef = useRef<VoiceRecorder | null>(null)

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

  // Starter-prompt cards (ChatView's empty state) seed the draft through the
  // ui store; consume the one-shot value and focus so the user can edit/send.
  const composerSeed = useUiStore((s) => s.composerSeed)
  useEffect(() => {
    if (composerSeed === null) return
    setValue((cur) => (cur.trim().length > 0 ? `${cur}\n\n${composerSeed}` : composerSeed))
    useUiStore.getState().clearComposerSeed()
    textareaRef.current?.focus()
  }, [composerSeed])

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

  // Everything staged in the composer belongs to the open conversation, and the
  // composer is one persistent instance for all of them: toggles, draft text,
  // attachments and files still awaiting the send confirmation must never be
  // carried into the next conversation (a file confirmed against this
  // provider would otherwise be sent to another one's). Drafts are the one
  // exception — they are kept per conversation and restored on the way back.
  const drafts = useRef(new Map<string, string>())
  const valueRef = useRef(value)
  valueRef.current = value

  useEffect(() => {
    const id = conversation?.id
    setCompareOn(false)
    setResearchOn(false)
    setResearchDepth('')
    setValue(id ? (drafts.current.get(id) ?? '') : '')
    setAttachments([])
    setPendingFiles(null)
    setExtractingIds(new Set())
    setMention(null)
    setMentionItems([])
    setSlashDismissed(false)
    // A recording belongs to the conversation it was started in.
    const recorder = recorderRef.current
    if (recorder) {
      recorderRef.current = null
      void recorder.cancel()
    }
    setRecState('idle')
    return () => {
      if (id) drafts.current.set(id, valueRef.current)
    }
  }, [conversation?.id])

  // Unmount (Home/Workflows navigation, lock screen): release the mic —
  // otherwise the getUserMedia stream and worklet keep running for up to the
  // 10-minute cap with the OS mic indicator lit.
  useEffect(
    () => () => {
      const recorder = recorderRef.current
      recorderRef.current = null
      void recorder?.cancel()
    },
    []
  )

  // Recording elapsed-time ticker + Escape-to-cancel.
  useEffect(() => {
    if (recState !== 'recording') {
      setRecSeconds(0)
      return
    }
    const started = Date.now()
    const ticker = window.setInterval(
      () => setRecSeconds(Math.floor((Date.now() - started) / 1000)),
      500
    )
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      const recorder = recorderRef.current
      recorderRef.current = null
      void recorder?.cancel()
      setRecState('idle')
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.clearInterval(ticker)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [recState])

  const effectiveModelId = conversation?.modelId ?? effectiveProvider?.defaultModelId ?? ''
  // Preset-aware: for the 120+ preset-backed 'openai-compatible' providers
  // (empty family knownModels) the preset catalog is consulted, so
  // vision-capable preset models are recognized.
  const visionSupported = effectiveProvider
    ? modelSupportsVision(effectiveProvider, effectiveModelId)
    : false

  const isStreaming = streaming !== null
  // Typing stays enabled during a stream (v47): a send while busy queues
  // main-side and runs as one coalesced turn after the response completes.
  const disabled = !conversation || !usable

  // Hidden until the whisper binary + active model are downloaded (charter:
  // voice surfaces appear only once the model exists locally).
  const voiceReady = sttReady(voiceStatus)
  const micAvailable = settings?.voiceInputEnabled === true && voiceReady

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

  // -- @-mentions (project files; teammate bots inside a bot chat) --------------

  const projectId = conversation?.projectId ?? null
  // Bot chat (v46): @ suggests teammate handles instead of files — picking one
  // inserts the handle so the bot brings that teammate in via message_agent.
  const botChatAgentId = conversation?.agentId ?? null

  useEffect(() => {
    if (!mention || (!projectId && !botChatAgentId)) {
      setMentionItems([])
      return
    }
    if (botChatAgentId) {
      const query = mention.query.toLowerCase()
      void window.uld.agents.list().then((res) => {
        if (!res.ok) return setMentionItems([])
        const handles = res.data
          .filter((agent) => agent.enabled && agent.id !== botChatAgentId)
          .map((agent) => agent.name.trim().toLowerCase().replace(/\s+/g, '-'))
          .filter((slug) => slug && slug.includes(query))
        setMentionItems(handles.slice(0, 8))
      })
      return
    }
    const pid = projectId
    if (!pid) return
    const token = window.setTimeout(() => {
      void window.uld.code
        .suggestFiles({ projectId: pid, query: mention.query, limit: 8 })
        .then((res) => setMentionItems(res.ok ? res.data : []))
    }, MENTION_DEBOUNCE_MS)
    return () => window.clearTimeout(token)
  }, [mention, projectId, botChatAgentId])

  const mentionVisible = !slashVisible && mention !== null && mentionItems.length > 0

  const pickMention = (relPath: string): void => {
    const m = mention
    if (!m || (!projectId && !botChatAgentId)) return
    setValue((cur) => `${cur.slice(0, m.start)}@${relPath} ${cur.slice(m.end)}`)
    setMention(null)
    setMentionItems([])
    setSuggestIndex(0)
    // A bot handle is just text — no file to attach.
    if (botChatAgentId || !projectId) {
      textareaRef.current?.focus()
      return
    }
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
    // While a response streams, only PLAIN messages may queue: commands and
    // one-shot overrides (/compact, /research, compare) need an idle turn.
    if (isStreaming && (content.startsWith('/') || researchOn || (compareOn && comparePreset))) {
      toast('Wait for the current response before running commands or one-shots.', 'error')
      return
    }
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
    // Never send an attachment half-extracted — wait or remove it.
    if (extractingIds.size > 0) {
      toast('Wait for text extraction to finish, or remove the attachment.', 'error')
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

  // An attachment may sit in either list (still in the confirm bar or already
  // staged) when an extraction lands, so patch both; unknown ids no-op.
  const patchAttachment = (id: string, patch: Partial<Attachment>): void => {
    const apply = (list: Attachment[]): Attachment[] =>
      list.map((a) => (a.id === id ? { ...a, ...patch } : a))
    setAttachments(apply)
    setPendingFiles((prev) => (prev ? apply(prev) : prev))
  }

  const setExtracting = (id: string, on: boolean): void => {
    setExtractingIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const runExtraction = (a: Attachment, method: 'text' | 'ocr'): void => {
    if (!a.storageKey) return
    setExtracting(a.id, true)
    void window.uld.app
      .extractAttachmentText({ storageKey: a.storageKey, method })
      .then((res) => {
        if (res.ok) {
          if (!res.data.extractedText.trim()) {
            // Nothing recognized: keep the chip honest — a PDF stays at
            // 'none' so the OCR retry affordance survives, instead of
            // claiming "OCR text extracted" over an empty result.
            patchAttachment(a.id, {
              extractedText: undefined,
              extraction: a.kind === 'pdf' ? 'none' : a.extraction,
            })
            toast(`No text was recognized in ${a.name}.`, 'info')
            return
          }
          patchAttachment(a.id, {
            extractedText: res.data.extractedText,
            extraction: res.data.extraction,
          })
        } else {
          if (method === 'text') patchAttachment(a.id, { extraction: 'none' })
          toast(`Could not extract text from ${a.name}: ${res.error.message}`, 'error')
        }
      })
      .catch((error) => {
        if (method === 'text') patchAttachment(a.id, { extraction: 'none' })
        toast(`Could not extract text from ${a.name}: ${toNormalized(error).message}`, 'error')
      })
      .finally(() => setExtracting(a.id, false))
  }

  // Staged audio: transcribe with the local whisper model (renderer-side patch
  // only — the attachment is persisted with the message on send).
  const runAudioTranscription = (a: Attachment): void => {
    if (!a.storageKey) return
    setExtracting(a.id, true)
    void window.uld.voice
      .transcribeAttachment({ storageKey: a.storageKey })
      .then((res) => {
        if (res.ok) {
          patchAttachment(a.id, {
            extractedText: res.data.text.trim() ? res.data.text : undefined,
            extraction: 'transcript',
          })
          if (!res.data.text.trim()) toast(`No speech was detected in ${a.name}.`, 'info')
        } else {
          toast(`Could not transcribe ${a.name}: ${res.error.message}`, 'error')
        }
      })
      .catch((error) => {
        toast(`Could not transcribe ${a.name}: ${toNormalized(error).message}`, 'error')
      })
      .finally(() => setExtracting(a.id, false))
  }

  const insertAtCaret = (text: string): void => {
    const el = textareaRef.current
    setValue((cur) => {
      if (!el) return cur.trim().length > 0 ? `${cur} ${text}` : text
      const start = el.selectionStart ?? cur.length
      const end = el.selectionEnd ?? start
      return `${cur.slice(0, start)}${text}${cur.slice(end)}`
    })
    textareaRef.current?.focus()
  }

  const stopRecording = async (): Promise<void> => {
    const recorder = recorderRef.current
    if (!recorder) return
    recorderRef.current = null
    setRecState('transcribing')
    try {
      const wav = await recorder.stop()
      const text = await useVoiceStore.getState().sendRecording(wav)
      if (text.trim()) insertAtCaret(text.trim())
      else toast('No speech was detected.', 'info')
    } catch (error) {
      toast(`Transcription failed: ${toNormalized(error).message}`, 'error')
    } finally {
      setRecState('idle')
      textareaRef.current?.focus()
    }
  }

  const toggleRecording = async (): Promise<void> => {
    if (recState === 'transcribing') return
    if (recState === 'recording') {
      await stopRecording()
      return
    }
    const recorder = new VoiceRecorder()
    recorder.onAutoStop = () => void stopRecording()
    try {
      await recorder.start()
    } catch (error) {
      if (error instanceof MicDeniedError) {
        toast('Microphone access was denied — allow it in your OS privacy settings.', 'error')
      } else {
        toast(`Could not start recording: ${toNormalized(error).message}`, 'error')
      }
      return
    }
    recorderRef.current = recorder
    setRecState('recording')
  }

  const removeStagedAttachment = (id: string): void => {
    setAttachments((prev) => prev.filter((x) => x.id !== id))
    // Late extraction results then no-op via patchAttachment.
    setExtracting(id, false)
  }

  const cancelPendingFiles = (): void => {
    setExtractingIds((prev) => {
      if (!pendingFiles || prev.size === 0) return prev
      const next = new Set(prev)
      for (const file of pendingFiles) next.delete(file.id)
      return next
    })
    setPendingFiles(null)
  }

  const queueAttachments = (picked: Attachment[]): void => {
    let files = picked
    // Drop images the effective model can't see, rather than sending them to a
    // text-only endpoint that would reject or ignore them. PDFs stay: their
    // extracted text works on any model.
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
    // Freshly stored PDFs get their text layer extracted right away.
    for (const file of files) {
      if (file.kind === 'pdf' && file.storageKey && file.extraction === undefined) {
        runExtraction(file, 'text')
      }
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
      ? 'Generating… a message sent now queues and runs next'
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

  const setSandboxLevel = async (level: SandboxLevel): Promise<void> => {
    if (!conversation || conversation.mode !== 'work') return
    try {
      const params: ChatParams = { ...conversation.params }
      // 'workspace-write' is the default — store it as absence, like planMode.
      if (level === 'workspace-write') delete params.sandboxLevel
      else params.sandboxLevel = level
      const updated = await unwrap(
        window.uld.conversations.update({ id: conversation.id, patch: { params } })
      )
      useChatStore.setState({ conversation: updated })
    } catch (error) {
      toast(`Could not set the sandbox level: ${toNormalized(error).message}`, 'error')
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
              cancelPendingFiles()
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
            <button type="button" className="btn btn-ghost" onClick={cancelPendingFiles}>
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
              {a.kind === 'pdf' ? (
                extractingIds.has(a.id) ? (
                  <span className="composer-attachment-status">Extracting…</span>
                ) : a.extraction === 'text' ? (
                  <span className="composer-attachment-status">Text extracted</span>
                ) : a.extraction === 'ocr' ? (
                  <span className="composer-attachment-status">OCR text extracted</span>
                ) : a.extraction === 'none' ? (
                  <button
                    type="button"
                    className="composer-attachment-ocr"
                    title="No text layer was found — run OCR (first use downloads language data)"
                    onClick={() => runExtraction(a, 'ocr')}
                  >
                    Extract text (OCR)
                  </button>
                ) : null
              ) : null}
              {a.kind === 'pdf' && a.sizeBytes <= MAX_RAW_ATTACH_BYTES ? (
                <label
                  className="composer-attachment-raw"
                  title="Send the original PDF to providers that support documents (Anthropic, Google); others receive the extracted text"
                >
                  <input
                    type="checkbox"
                    checked={a.rawAttach === true}
                    onChange={() => patchAttachment(a.id, { rawAttach: !a.rawAttach })}
                  />
                  Send original PDF
                </label>
              ) : null}
              {a.kind === 'image' ? (
                extractingIds.has(a.id) ? (
                  <span className="composer-attachment-status">Running OCR…</span>
                ) : a.extractedText ? (
                  <span className="composer-attachment-status">OCR text extracted</span>
                ) : (
                  <button
                    type="button"
                    className="composer-attachment-ocr"
                    title="Extract text from this image with OCR (first use downloads language data)"
                    onClick={() => runExtraction(a, 'ocr')}
                  >
                    Extract text (OCR)
                  </button>
                )
              ) : null}
              {a.kind === 'audio' ? (
                extractingIds.has(a.id) ? (
                  <span className="composer-attachment-status">Transcribing…</span>
                ) : a.extractedText ? (
                  <span className="composer-attachment-status">Transcribed</span>
                ) : voiceReady ? (
                  <button
                    type="button"
                    className="composer-attachment-ocr"
                    title="Transcribe this audio with the local whisper model"
                    onClick={() => runAudioTranscription(a)}
                  >
                    Transcribe
                  </button>
                ) : (
                  <span className="composer-attachment-status">Not transcribed</span>
                )
              ) : null}
              <button
                type="button"
                className="composer-attachment-remove"
                aria-label={`Remove attachment ${a.name}`}
                onClick={() => removeStagedAttachment(a.id)}
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
                {conversation?.mode === 'work' ? (
                  <label
                    className="composer-plus-subcontrol"
                    title={
                      'read-only: the assistant may only investigate — every mutating tool is refused. ' +
                      'workspace-write: audited file tools may write only inside the granted folder (default); shell is off. ' +
                      'full: enables an unrestricted host shell (each call still asks).'
                    }
                  >
                    <span>Sandbox</span>
                    <select
                      value={conversation.params.sandboxLevel ?? 'workspace-write'}
                      onChange={(e) => void setSandboxLevel(e.target.value as SandboxLevel)}
                    >
                      <option value="read-only">read-only</option>
                      <option value="workspace-write">workspace-write</option>
                      <option value="full">full</option>
                    </select>
                  </label>
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
            disabled={!conversation}
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
        {micAvailable ? (
          <button
            type="button"
            className={`btn-icon composer-mic${recState === 'recording' ? ' recording' : ''}`}
            aria-label={
              recState === 'recording'
                ? 'Stop recording and transcribe'
                : recState === 'transcribing'
                  ? 'Transcribing'
                  : 'Dictate a message'
            }
            title={
              recState === 'recording'
                ? 'Stop recording and transcribe (Esc cancels)'
                : recState === 'transcribing'
                  ? 'Transcribing…'
                  : 'Dictate a message (offline)'
            }
            disabled={!conversation || isStreaming || recState === 'transcribing'}
            onClick={() => void toggleRecording()}
          >
            {recState === 'transcribing' ? (
              <span className="composer-mic-busy" aria-hidden>
                …
              </span>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z" />
                <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" />
              </svg>
            )}
            {recState === 'recording' ? (
              <span className="composer-mic-time">
                {Math.floor(recSeconds / 60)}:{String(recSeconds % 60).padStart(2, '0')}
              </span>
            ) : null}
          </button>
        ) : null}
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
