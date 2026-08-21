import { lazy, Suspense, useEffect, useState } from 'react'
import type { ConversationMode } from '@shared/types'
import HomeView from '@/components/home/HomeView'
import Sidebar from '@/components/Sidebar'
import ToolApprovalDialog from '@/components/ToolApprovalDialog'
import UserQuestionDialog from '@/components/UserQuestionDialog'
import ArtifactPanel from '@/components/chat/ArtifactPanel'
import Toasts from '@/components/Toasts'
import { GLOBAL_SHORTCUT_KEYS, useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useChatStore } from '@/stores/chat'
import { useConversationsStore } from '@/stores/conversations'
import { useMcpStore } from '@/stores/mcp'
import { useProvidersStore } from '@/stores/providers'
import { useSettingsStore } from '@/stores/settings'
import { useToolsStore } from '@/stores/tools'
import { useUiStore } from '@/stores/ui'
import { useWorkflowsStore } from '@/stores/workflows'
import { useScheduledTasksStore } from '@/stores/scheduled-tasks'

const ChatView = lazy(() => import('@/components/chat/ChatView'))
const WorkView = lazy(() => import('@/components/work/WorkView'))
const WorkflowsView = lazy(() => import('@/components/workflows/WorkflowsView'))
const SettingsPanel = lazy(() => import('@/components/settings/SettingsPanel'))
const Onboarding = lazy(() => import('@/components/onboarding/Onboarding'))
const CommandPalette = lazy(() => import('@/components/CommandPalette'))
const ShortcutsHelp = lazy(() => import('@/components/ShortcutsHelp'))

function ViewFallback(): React.JSX.Element {
  return <div className="app-view-loading" role="status" aria-label="Loading view" />
}

/** The active conversation's mode picks which main view renders. */
function ModeView({ mode }: { mode: ConversationMode }): React.JSX.Element {
  if (mode === 'work') return <WorkView />
  return <ChatView />
}

export default function App(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const activeId = useConversationsStore((s) => s.activeId)
  // Mode of the active conversation: the sidebar summary knows it immediately
  // on select; the chat store's copy (once loaded) is authoritative.
  const summaryMode = useConversationsStore((s) =>
    s.activeId ? s.summaries.find((x) => x.id === s.activeId)?.mode : undefined
  )
  const openMode = useChatStore((s) =>
    s.conversation && s.conversation.id === activeId ? s.conversation.mode : undefined
  )
  const mode: ConversationMode = openMode ?? summaryMode ?? 'chat'
  const view = useUiStore((s) => s.view)
  const settingsOpen = useUiStore((s) => s.settingsOpen)
  const paletteOpen = useUiStore((s) => s.paletteOpen)
  const shortcutsOpen = useUiStore((s) => s.shortcutsOpen)
  // Load overlays only on first use, then keep them mounted so their local
  // selection/query state survives close + reopen exactly as before.
  const [loadedOverlays, setLoadedOverlays] = useState({
    settings: false,
    palette: false,
    shortcuts: false,
  })

  useKeyboardShortcuts()

  // While onboarding is showing, the main app tree (sidebar, palette, settings)
  // isn't mounted, so the global Ctrl+N / Ctrl+K / Ctrl+, shortcuts would act on
  // nothing (or create a stray conversation). Swallow those combos in the
  // capture phase — the same phase Sidebar uses — before the global handler
  // (a window bubble listener) can run them. Escape stays free for local use.
  const onboardingActive = settingsLoaded && !!settings && !settings.onboardingCompleted
  useEffect(() => {
    if (!settingsOpen && !paletteOpen && !shortcutsOpen) return
    setLoadedOverlays((current) => ({
      settings: current.settings || settingsOpen,
      palette: current.palette || paletteOpen,
      shortcuts: current.shortcuts || shortcutsOpen,
    }))
  }, [settingsOpen, paletteOpen, shortcutsOpen])
  useEffect(() => {
    if (!onboardingActive) return
    const block = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod || e.shiftKey || e.altKey) return
      if (GLOBAL_SHORTCUT_KEYS.includes(e.key.toLowerCase())) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    document.addEventListener('keydown', block, true)
    return () => document.removeEventListener('keydown', block, true)
  }, [onboardingActive])

  // Initial data load + stream/approval subscriptions (once per app lifetime;
  // effect is idempotent under StrictMode double-invoke since the loads just
  // refresh state and the subscriptions are torn down in cleanup).
  useEffect(() => {
    void useSettingsStore.getState().load()
    void useProvidersStore.getState().load()
    void useConversationsStore.getState().load()
    // Loaded at boot (not just when Home mounts) so the sidebar's Scheduled
    // section and failure dot work from the first paint.
    void useWorkflowsStore.getState().load()
    void useScheduledTasksStore.getState().load()
    const unsubscribeStream = window.uld.chat.onStreamEvent((envelope) => {
      useChatStore.getState().handleStreamEvent(envelope)
    })
    const unsubscribeApproval = window.uld.tools.onApprovalRequest((req) => {
      useToolsStore.getState().setPendingApproval(req)
    })
    // Auto-dismiss a queued/active approval that main settled on its own
    // (timeout, abort, stopAll) so the dialog doesn't linger on a dead request.
    const unsubscribeSettled = window.uld.tools.onApprovalSettled((requestId) => {
      useToolsStore.getState().settleApproval(requestId)
    })
    // ask_user_question dialogs, mirroring the approval flow.
    const unsubscribeQuestion = window.uld.tools.onQuestionRequest((req) => {
      useToolsStore.getState().setPendingQuestion(req)
    })
    const unsubscribeQuestionSettled = window.uld.tools.onQuestionSettled((requestId) => {
      useToolsStore.getState().settleQuestion(requestId)
    })
    // MCP connection state changes push a fresh runtime snapshot.
    const unsubscribeMcp = window.uld.mcp.onServersChanged((runtime) => {
      useMcpStore.getState().setRuntime(runtime)
    })
    // Workflow runs (manual or scheduled) push their result the moment they
    // are persisted — keeps Home + the sidebar Scheduled section live.
    const unsubscribeRuns = window.uld.workflows.onRunFinished((evt) => {
      useWorkflowsStore.getState().handleRunFinished(evt)
    })
    const unsubscribeScheduledTasks = window.uld.scheduledTasks.onChanged((event) => {
      useScheduledTasksStore.getState().handleChanged(event)
    })
    // Standing approval rules can be created from an approval dialog in this
    // window or another one; keep Settings -> Tools in step either way.
    const unsubscribeToolRules = window.uld.tools.onRulesChanged(() => {
      void useToolsStore.getState().loadRules()
    })
    // Notices main raises with no request in flight (e.g. the trigger endpoint
    // could not bind its port) — otherwise the failure would be invisible.
    const unsubscribeNotices = window.uld.notices.onNotice((notice) => {
      useUiStore.getState().toast(notice.message, notice.level)
    })
    return () => {
      unsubscribeStream()
      unsubscribeApproval()
      unsubscribeSettled()
      unsubscribeQuestion()
      unsubscribeQuestionSettled()
      unsubscribeMcp()
      unsubscribeRuns()
      unsubscribeScheduledTasks()
      unsubscribeToolRules()
      unsubscribeNotices()
    }
  }, [])

  // Theme resolution -> <html data-theme> + ui.resolvedTheme.
  const theme = settings?.theme ?? 'system'
  useEffect(() => {
    const apply = (resolved: 'light' | 'dark'): void => {
      document.documentElement.dataset.theme = resolved
      useUiStore.getState().setResolvedTheme(resolved)
    }
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const onChange = (): void => apply(mq.matches ? 'dark' : 'light')
      onChange()
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
    apply(theme)
    return undefined
  }, [theme])

  // Font-size scaling -> <html data-font-size>.
  const fontSize = settings?.fontSize ?? 'medium'
  useEffect(() => {
    document.documentElement.dataset.fontSize = fontSize
  }, [fontSize])

  if (settingsLoaded && settings && !settings.onboardingCompleted) {
    return (
      <>
        <Suspense fallback={<ViewFallback />}>
          <Onboarding />
        </Suspense>
        <Toasts />
      </>
    )
  }

  return (
    <>
      <div
        className={`app-layout${view === 'conversation' && activeId ? ` app-mode-${mode}` : ''}`}
      >
        <Sidebar />
        <main
          className="app-main"
          aria-label={
            view === 'workflows'
              ? 'Workflows'
              : view === 'conversation' && activeId
                ? 'Conversation'
                : 'Home overview'
          }
        >
          <Suspense fallback={<ViewFallback />}>
            {view === 'workflows' ? (
              <WorkflowsView />
            ) : view === 'conversation' && activeId ? (
              <ModeView mode={mode} />
            ) : (
              // 'home', plus the fallback while 'conversation' has no selection.
              <HomeView />
            )}
          </Suspense>
        </main>
      </div>
      <Suspense fallback={null}>
        {loadedOverlays.settings ? <SettingsPanel /> : null}
        {loadedOverlays.palette ? <CommandPalette /> : null}
        {loadedOverlays.shortcuts ? <ShortcutsHelp /> : null}
      </Suspense>
      <ToolApprovalDialog />
      <UserQuestionDialog />
      <ArtifactPanel />
      <Toasts />
    </>
  )
}
