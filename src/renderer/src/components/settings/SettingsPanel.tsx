import { useEffect, useState } from 'react'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useProvidersStore } from '@/stores/providers'
import ProvidersTab from './ProvidersTab'
import DefaultsTab from './DefaultsTab'
import MoaTab from './MoaTab'
import ToolsTab from './ToolsTab'
import McpServersTab from './McpServersTab'
import BridgesTab from './BridgesTab'
import PromptsTab from './PromptsTab'
import SkillsTab from './SkillsTab'
import MemoryTab from './MemoryTab'
import AppearanceTab from './AppearanceTab'
import PrivacyTab from './PrivacyTab'
import AboutTab from './AboutTab'
import AgentsTab from './AgentsTab'
import KnowledgeTab from './KnowledgeTab'
import AgentPlatformTab from './AgentPlatformTab'
import './settings.css'

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
  { id: 'skills', label: 'Skills' },
  { id: 'memory', label: 'Memory' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'about', label: 'About' },
] as const

type TabId = (typeof TABS)[number]['id']

export default function SettingsPanel() {
  const open = useUiStore((s) => s.settingsOpen)
  const paletteOpen = useUiStore((s) => s.paletteOpen)
  const shortcutsOpen = useUiStore((s) => s.shortcutsOpen)
  const openSettings = useUiStore((s) => s.openSettings)

  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const loadSettings = useSettingsStore((s) => s.load)
  const providersLoaded = useProvidersStore((s) => s.loaded)
  const loadProviders = useProvidersStore((s) => s.load)

  const [tab, setTab] = useState<TabId>('providers')

  useEffect(() => {
    if (!open) return
    if (!settingsLoaded) void loadSettings()
    if (!providersLoaded) void loadProviders()
  }, [open, settingsLoaded, providersLoaded, loadSettings, loadProviders])

  // Esc closes settings — unless a palette/shortcuts overlay is stacked on top
  // (those handle their own Esc).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !paletteOpen && !shortcutsOpen) {
        openSettings(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, paletteOpen, shortcutsOpen, openSettings])

  if (!open) return null

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) openSettings(false)
      }}
    >
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="settings-header">
          <h2 id="settings-title">Settings</h2>
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
          <nav className="settings-rail" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`settings-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="settings-tabpanel"
                className={`settings-rail-btn${tab === t.id ? ' active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div
            id="settings-tabpanel"
            className="settings-content"
            role="tabpanel"
            aria-labelledby={`settings-tab-${tab}`}
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
            {tab === 'skills' ? <SkillsTab /> : null}
            {tab === 'memory' ? <MemoryTab /> : null}
            {tab === 'appearance' ? <AppearanceTab /> : null}
            {tab === 'privacy' ? <PrivacyTab /> : null}
            {tab === 'about' ? <AboutTab /> : null}
          </div>
        </div>
      </div>
    </div>
  )
}
