import { useEffect, useMemo, useState } from 'react'
import App from '@/App'
import { useUiStore } from '@/stores/ui'
import { useConversationsStore } from '@/stores/conversations'
import { useChatStore } from '@/stores/chat'
import { useProvidersStore } from '@/stores/providers'
import { useSettingsStore } from '@/stores/settings'
import { useToolsStore } from '@/stores/tools'
import { useBotsStore } from '@/stores/bots'
import { useWorkflowsStore } from '@/stores/workflows'
import { useScheduledTasksStore } from '@/stores/scheduled-tasks'
import { useMemoriesStore } from '@/stores/memories'
import { useSkillsStore } from '@/stores/skills'
import { usePromptsStore } from '@/stores/prompts'
import { useMcpStore } from '@/stores/mcp'
import { useDocumentsStore } from '@/stores/documents'
import { remoteApi, type RemoteHost } from './remote-api'
import RemoteFilesDialog from './RemoteFilesDialog'
import { navigateGuarded } from '@/hooks/useUnsavedChanges'
import '@/styles/theme.css'
import '@/styles/app.css'
import './responsive.css'

export default function FullApp({ host, online, onLeave }: { host: RemoteHost; online: boolean; onLeave: () => void }) {
  const [drawer, setDrawer] = useState(false)
  const view = useUiStore(s => s.view)
  const activeId = useConversationsStore(s => s.activeId)
  useMemo(() => { window.uld = remoteApi(host); document.documentElement.dataset.remoteClient = 'true' }, [host])
  useEffect(() => {
    document.documentElement.dataset.remoteClient = 'true'
    return () => { delete document.documentElement.dataset.remoteClient }
  }, [])
  useEffect(() => { setDrawer(false) }, [activeId, view])
  useEffect(() => {
    if (!online) return
    // Reconcile every library after a tunnel reconnect while retaining open forms.
    void Promise.allSettled([
      useProvidersStore.getState().load(), useSettingsStore.getState().load(),
      useConversationsStore.getState().load(), useToolsStore.getState().recoverPending(),
      useBotsStore.getState().load(), useWorkflowsStore.getState().load(), useScheduledTasksStore.getState().load(),
      useMemoriesStore.getState().load(), useSkillsStore.getState().load(), usePromptsStore.getState().load(), useMcpStore.getState().load(),
      useDocumentsStore.getState().load(),
    ])
    const id = useChatStore.getState().conversation?.id
    if (id) void useChatStore.getState().openConversation(id)
  }, [online])
  return <div className={`full-remote-app${drawer ? ' drawer-open' : ''}`}>
    <header className="remote-topbar"><button className="btn" aria-label={drawer ? 'Close conversations' : 'Open conversations'} aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>☰</button><strong>Grasberg</strong><span role="status">{online ? 'Connected to desktop' : 'Offline · drafts stay on this device'}</span><button className="btn" onClick={() => navigateGuarded(onLeave)}>Device</button></header>
    {drawer && <button className="remote-drawer-backdrop" aria-label="Close conversations" onClick={() => setDrawer(false)} />}
    <div className="remote-content"><App /></div>
    <RemoteFilesDialog />
    <nav className="remote-navigation" aria-label="Main navigation"><button className="btn" aria-current={view === 'home' ? 'page' : undefined} onClick={() => useUiStore.getState().setView('home')}>Home</button><button className="btn" aria-current={view === 'bots' ? 'page' : undefined} onClick={() => useUiStore.getState().setView('bots')}>Bots</button><button className="btn" onClick={() => setDrawer(true)}>Chats</button><button className="btn" aria-current={view === 'automation' ? 'page' : undefined} onClick={() => useUiStore.getState().setView('automation')}>Automation</button><button className="btn" onClick={() => useUiStore.getState().openSettings(true)}>Settings</button></nav>
  </div>
}
