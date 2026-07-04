import { useEffect } from 'react'
import type { ConversationMode } from '@shared/types'
import ChatView from '@/components/chat/ChatView'
import CodeView from '@/components/code/CodeView'
import CoworkView from '@/components/cowork/CoworkView'
import SettingsPanel from '@/components/settings/SettingsPanel'
import Onboarding from '@/components/onboarding/Onboarding'
import CommandPalette from '@/components/CommandPalette'
import ShortcutsHelp from '@/components/ShortcutsHelp'
import EmptyState from '@/components/EmptyState'
import Sidebar from '@/components/Sidebar'
import ToolApprovalDialog from '@/components/ToolApprovalDialog'
import Toasts from '@/components/Toasts'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useChatStore } from '@/stores/chat'
import { useConversationsStore } from '@/stores/conversations'
import { useMcpStore } from '@/stores/mcp'
import { useProvidersStore } from '@/stores/providers'
import { useSettingsStore } from '@/stores/settings'
import { useToolsStore } from '@/stores/tools'
import { useUiStore } from '@/stores/ui'

/** The active conversation's mode picks which main view renders. */
function ModeView({ mode }: { mode: ConversationMode }): React.JSX.Element {
  if (mode === 'code') return <CodeView />
  if (mode === 'cowork') return <CoworkView />
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

  useKeyboardShortcuts()

  // While onboarding is showing, the main app tree (sidebar, palette, settings)
  // isn't mounted, so the global Ctrl+N / Ctrl+K / Ctrl+, shortcuts would act on
  // nothing (or create a stray conversation). Swallow those combos in the
  // capture phase — the same phase Sidebar uses — before the global handler
  // (a window bubble listener) can run them. Escape stays free for local use.
  const onboardingActive = settingsLoaded && !!settings && !settings.onboardingCompleted
  useEffect(() => {
    if (!onboardingActive) return
    const block = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod || e.shiftKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'n' || key === 'k' || e.key === ',') {
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
    // MCP connection state changes push a fresh runtime snapshot.
    const unsubscribeMcp = window.uld.mcp.onServersChanged((runtime) => {
      useMcpStore.getState().setRuntime(runtime)
    })
    return () => {
      unsubscribeStream()
      unsubscribeApproval()
      unsubscribeSettled()
      unsubscribeMcp()
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
        <Onboarding />
        <Toasts />
      </>
    )
  }

  return (
    <>
      <div className="app-layout">
        <Sidebar />
        <main className="app-main" aria-label="Conversation">
          {activeId ? <ModeView mode={mode} /> : <EmptyState />}
        </main>
      </div>
      <SettingsPanel />
      <CommandPalette />
      <ShortcutsHelp />
      <ToolApprovalDialog />
      <Toasts />
    </>
  )
}
