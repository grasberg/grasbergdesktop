import { lazy, Suspense, useEffect, useState } from 'react'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useProvidersStore } from '@/stores/providers'
import { useModalBehavior } from '@/hooks/useModalBehavior'
import './settings.css'
import { isRemoteClient } from '@/lib/client-platform'

const ProvidersTab = lazy(() => import('./ProvidersTab'))
const DefaultsTab = lazy(() => import('./DefaultsTab'))
const MoaTab = lazy(() => import('./MoaTab'))
const ToolsTab = lazy(() => import('./ToolsTab'))
const McpServersTab = lazy(() => import('./McpServersTab'))
const BridgesTab = lazy(() => import('./BridgesTab'))
const PromptsTab = lazy(() => import('./PromptsTab'))
const SkillsTab = lazy(() => import('./SkillsTab'))
const MemoryTab = lazy(() => import('./MemoryTab'))
const AppearanceTab = lazy(() => import('./AppearanceTab'))
const PrivacyTab = lazy(() => import('./PrivacyTab'))
const AboutTab = lazy(() => import('./AboutTab'))
const AgentsTab = lazy(() => import('./AgentsTab'))
const KnowledgeTab = lazy(() => import('./KnowledgeTab'))
const AgentPlatformTab = lazy(() => import('./AgentPlatformTab'))
const UsageTab = lazy(() => import('./UsageTab'))
const ActivityTab = lazy(() => import('./ActivityTab'))
const VoiceTab = lazy(() => import('./VoiceTab'))
const QuickAssistantTab = lazy(() => import('./QuickAssistantTab'))

const TABS = [
  { id: 'providers', label: 'Providers' },
  { id: 'defaults', label: 'Defaults' },
  { id: 'moa', label: 'Mixture of Agents' },
  { id: 'agents', label: 'Agents' },
  { id: 'agent-platform', label: 'Agent platform' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'tools', label: 'Tools' },
  { id: 'mcp', label: 'MCP' },
  { id: 'bridges', label: 'Bridges' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'quick', label: 'Quick assistant' },
  { id: 'skills', label: 'Skills' },
  { id: 'memory', label: 'Memory' },
  { id: 'voice', label: 'Voice' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'activity', label: 'Activity' },
  { id: 'usage', label: 'Usage' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'about', label: 'About' },
] as const

const GROUPS = [
  { label: 'Models & chat', tabs: ['providers', 'defaults', 'moa', 'voice', 'quick'], keywords: 'api key oauth chatgpt deepseek openai z.ai model speech microphone' },
  { label: 'Bots & libraries', tabs: ['agents', 'knowledge', 'prompts', 'skills', 'memory'], keywords: 'bot persona document embedding rag prompt instructions' },
  { label: 'Tools & connections', tabs: ['tools', 'mcp', 'bridges', 'agent-platform'], keywords: 'permissions approvals server remote phone telegram mobile tunnel integrations' },
  { label: 'App & data', tabs: ['appearance', 'activity', 'usage', 'privacy', 'about'], keywords: 'theme fonts history costs budget backup restore import export lock version updates' },
]

const KEYWORDS: Record<string, string> = {
  providers: 'api key oauth chatgpt deepseek openai z.ai models connection', defaults: 'model temperature system prompt failover image',
  moa: 'mixture advisors aggregator', voice: 'speech microphone whisper transcription dictation', quick: 'shortcut assistant hotkey',
  agents: 'bots persona avatar emoji', knowledge: 'documents embedding rag pdf import', prompts: 'templates prompt instructions',
  skills: 'instructions plugins import', memory: 'memories facts context', tools: 'permissions approvals shell browser',
  mcp: 'server integrations tools', bridges: 'remote phone telegram mobile tunnel webhook', 'agent-platform': 'runs schedule triggers',
  appearance: 'theme font language colors', activity: 'history tools audit', usage: 'cost budget tokens', privacy: 'backup restore import export lock private deletion', about: 'version updates license',
}

type TabId = (typeof TABS)[number]['id']

export default function SettingsPanel() {
  const open = useUiStore((s) => s.settingsOpen)
  const openSettings = useUiStore((s) => s.openSettings)

  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const loadSettings = useSettingsStore((s) => s.load)
  const providersLoaded = useProvidersStore((s) => s.loaded)
  const loadProviders = useProvidersStore((s) => s.load)

  const selectedTab = useUiStore(s => s.settingsTab)
  const tab = TABS.some(t => t.id === selectedTab) ? selectedTab as TabId : 'providers'
  const [browseSections, setBrowseSections] = useState(false)
  const setTab = (id: TabId): void => { openSettings(true, id); setBrowseSections(false) }
  const [search, setSearch] = useState('')
  const modalRef = useModalBehavior(open, () => openSettings(false))
  const visibleGroups = GROUPS.map(group => ({ ...group, items: TABS.filter(t => group.tabs.includes(t.id) && `${t.label} ${group.label} ${KEYWORDS[t.id]}`.toLowerCase().includes(search.toLowerCase().trim())) })).filter(g => g.items.length)

  useEffect(() => {
    if (!open) return
    if (!settingsLoaded) void loadSettings()
    if (!providersLoaded) void loadProviders()
  }, [open, settingsLoaded, providersLoaded, loadSettings, loadProviders])

  if (!open) return null

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) openSettings(false)
      }}
    >
      <div
        className={`modal settings-modal${browseSections ? ' settings-browse-open' : ''}`}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="settings-header">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="btn settings-browse" aria-expanded={browseSections} onClick={() => setBrowseSections(!browseSections)}>{browseSections ? 'Back' : 'Browse settings'}</button>
          <button
            type="button"
            className="btn-icon"
            aria-label="Close settings"
            onClick={() => openSettings(false)}
          >
            ✕
          </button>
        </header>
        <div className="settings-layout">
          <nav className="settings-rail" aria-label="Settings">
            <input type="search" className="input" aria-label="Search settings" placeholder="Search settings…" value={search} onChange={e => setSearch(e.target.value)} />
            {visibleGroups.length === 0 ? <p className="field-hint">No settings found.</p> : null}
            <div role="tablist" aria-label="Settings sections" aria-orientation="vertical" onKeyDown={e => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
              const tabs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
              const index = tabs.indexOf(document.activeElement as HTMLButtonElement)
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length
              e.preventDefault(); tabs[next]?.focus(); tabs[next]?.click()
            }}>
            {visibleGroups.map(group => <div key={group.label} className="settings-group">
              <div className="settings-group-label">{group.label}</div>
              {group.items.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`settings-tab-${t.id}`}
                aria-selected={tab === t.id}
                tabIndex={tab === t.id || !visibleGroups.some(g => g.items.some(item => item.id === tab)) && visibleGroups[0].items[0].id === t.id ? 0 : -1}
                aria-controls="settings-tabpanel"
                className={`settings-rail-btn${tab === t.id ? ' active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
              ))}
            </div>)}
            </div>
          </nav>
          <div
            id="settings-tabpanel"
            className="settings-content"
            role="tabpanel"
            aria-labelledby={`settings-tab-${tab}`}
          >
            <Suspense
              fallback={
                <div className="settings-tab-loading" role="status" aria-label="Loading settings" />
              }
            >
              {tab === 'providers' ? <ProvidersTab /> : null}
              {tab === 'defaults' ? <DefaultsTab /> : null}
              {tab === 'moa' ? <MoaTab /> : null}
              {tab === 'agents' ? <AgentsTab /> : null}
              {tab === 'agent-platform' ? <AgentPlatformTab /> : null}
              {tab === 'knowledge' ? <KnowledgeTab /> : null}
              {tab === 'tools' ? <ToolsTab /> : null}
              {tab === 'mcp' ? <McpServersTab /> : null}
              {tab === 'bridges' ? <BridgesTab /> : null}
              {tab === 'prompts' ? <PromptsTab /> : null}
              {tab === 'quick' ? isRemoteClient() ? <p className="callout">Quick assistant opens from a keyboard shortcut on the desktop. Configure that shortcut in desktop Settings → Quick assistant.</p> : <QuickAssistantTab /> : null}
              {tab === 'skills' ? <SkillsTab /> : null}
              {tab === 'memory' ? <MemoryTab /> : null}
              {tab === 'voice' ? <VoiceTab /> : null}
              {tab === 'appearance' ? <AppearanceTab /> : null}
              {tab === 'activity' ? <ActivityTab /> : null}
              {tab === 'usage' ? <UsageTab /> : null}
              {tab === 'privacy' ? <PrivacyTab /> : null}
              {tab === 'about' ? <AboutTab /> : null}
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  )
}
