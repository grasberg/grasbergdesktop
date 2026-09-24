import { useEffect, useState } from 'react'
import ModelField from '../chat/ModelField'
import { navigateGuarded } from '@/hooks/useUnsavedChanges'
import type { ConversationMode, ProviderConfig } from '@shared/types'
import { errorMessage } from '@/api/uld'
import { TestResult } from '@/components/common/controls'
import { usePersistSettings } from '@/hooks/usePersistSettings'
import { useTestConnection } from '@/hooks/useTestConnection'
import { useSettingsStore } from '@/stores/settings'
import { useProvidersStore } from '@/stores/providers'
import { useConversationsStore } from '@/stores/conversations'
import { useUiStore } from '@/stores/ui'
import { ProviderAddForm } from '../settings/ProviderAddForm'
import LocalServerCard from '../settings/LocalServerCard'
import appIcon from '@/assets/icon.png'
import '../settings/settings.css'

const STEP_COUNT = 4

function Dots({ step }: { step: number }) {
  return (
    <div className="wizard-dots" aria-label={`Step ${step + 1} of ${STEP_COUNT}`}>
      {Array.from({ length: STEP_COUNT }, (_, i) => (
        <span key={i} className={`dot${i === step ? ' active' : ''}`} aria-hidden="true" />
      ))}
    </div>
  )
}

function WelcomeStep() {
  return (
    <div className="wizard-step">
      <div className="wizard-logo" aria-hidden="true">
        <img src={appIcon} width={56} height={56} alt="" draggable={false} />
      </div>
      <h1>Grasberg</h1>
      <p className="wizard-pitch">
        One fast, local-first desktop client for OpenAI, Anthropic, Google Gemini, Amazon Bedrock,
        DeepSeek, GLM, MiniMax and 120+ OpenAI-compatible providers — chat with the model you want,
        switch providers mid-project, and keep everything on your own machine.
      </p>
      <ul className="wizard-bullets">
        <li>Conversations and settings are stored locally, never on our servers.</li>
        <li>API keys are encrypted on disk and sent only when authenticating with their configured provider.</li>
        <li>Model catalogs can refresh from models.dev. Tools, downloads and connections you enable may contact other services.</li>
        <li>No telemetry.</li>
      </ul>
    </div>
  )
}

function VerifyStep({ provider }: { provider: ProviderConfig }) {
  const settings = useSettingsStore(s => s.settings)
  const updateSettings = useSettingsStore(s => s.update)
  const toast = useUiStore(s => s.toast)
  const { testing, result: testResult, run: runTest } = useTestConnection(provider.id)
  return <div className="wizard-step">
    <h1>Choose your default model</h1>
    <p className="wizard-pitch">New chats use this selection. You can change models in any conversation.</p>
    <ModelField providerId={settings?.defaultProviderId ?? provider.id}
      modelId={settings?.defaultModelId ?? provider.defaultModelId}
      allowDefault={false}
      onChange={(providerId, modelId) => { void updateSettings({ defaultProviderId: providerId, defaultModelId: modelId }).catch(e => toast(errorMessage(e), 'error')) }} />
    <div className="wizard-test-row"><button type="button" className="btn" onClick={() => void runTest()} disabled={testing}>Test provider again</button><TestResult testing={testing} result={testResult} /></div>
    <p className="field-hint">The optional connection test uses the provider's default model and may incur a small charge.</p>
  </div>
}

const MODE_CARDS: ReadonlyArray<{ id: ConversationMode; title: string; desc: string }> = [
  {
    id: 'chat',
    title: 'Chat',
    desc: 'Classic assistant conversations — fast answers, drafts and ideas with streaming, markdown and attachments.',
  },
  {
    id: 'work',
    title: 'Work',
    desc: 'Give the assistant a real task: it creates files on disk, edits code with reviewable diffs, builds clickable HTML prototypes and keeps a task list — a workspace panel appears beside the chat as it works.',
  },
]

export default function Onboarding() {
  const settings = useSettingsStore((s) => s.settings)
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const loadSettings = useSettingsStore((s) => s.load)
  const updateSettings = useSettingsStore((s) => s.update)
  const providers = useProvidersStore((s) => s.providers)
  const providersLoaded = useProvidersStore((s) => s.loaded)
  const loadProviders = useProvidersStore((s) => s.load)
  const createConversation = useConversationsStore((s) => s.create)
  const toast = useUiStore((s) => s.toast)
  const persist = usePersistSettings()

  const [step, setStep] = useState(0)
  const [createdProviderId, setCreatedProviderId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    if (!settingsLoaded) void loadSettings()
  }, [settingsLoaded, loadSettings])
  useEffect(() => {
    if (!providersLoaded) void loadProviders()
  }, [providersLoaded, loadProviders])

  if (!settingsLoaded || !settings || settings.onboardingCompleted) return null

  const verifyProvider =
    providers.find((p) => p.id === createdProviderId) ??
    providers.find((p) => p.enabled) ??
    providers[0] ??
    null

  function skip() {
    navigateGuarded(() => { void persist({ onboardingCompleted: true }) }, 'settings')
  }

  async function startSession(mode: ConversationMode) {
    setStarting(true)
    try {
      await updateSettings({ onboardingCompleted: true })
      await createConversation(mode)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="wizard" role="dialog" aria-modal="true" aria-label="Welcome setup">
      <header className="wizard-top">
        <Dots step={step} />
        <button type="button" className="btn btn-ghost" onClick={skip}>
          Skip setup
        </button>
      </header>

      <div className="wizard-body">
        {step === 0 ? <WelcomeStep /> : null}

        {step === 1 ? (
          <div className="wizard-step">
            <h1>Add a provider</h1>
            <p className="wizard-pitch">
              Pick a provider family and paste an API key. You can add more providers any time in
              Settings.
            </p>
            <LocalServerCard
              showFallback
              onCreated={(p) => {
                setCreatedProviderId(p.id)
                setStep(2)
              }}
            />
            <ProviderAddForm
              submitLabel="Create provider & continue"
              onCreated={(p) => {
                setCreatedProviderId(p.id)
                setStep(2)
              }}
            />
            <button type="button" className="btn btn-ghost wizard-later" onClick={() => navigateGuarded(() => setStep(3), 'settings')}>
              I&rsquo;ll do this later
            </button>
          </div>
        ) : null}

        {step === 2 ? (
          verifyProvider ? (
            <VerifyStep provider={verifyProvider} />
          ) : (
            <div className="wizard-step">
              <h1>Verify &amp; choose a model</h1>
              <p className="field-hint">No provider configured yet — go back to add one, or skip ahead.</p>
            </div>
          )
        ) : null}

        {step === 3 ? (
          <div className="wizard-step">
            <h1>You&rsquo;re all set</h1>
            <p className="wizard-pitch">Two ways to start — pick one to begin.</p>
            <div className="mode-cards">
              {MODE_CARDS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="mode-card card"
                  disabled={starting}
                  onClick={() => void startSession(m.id)}
                >
                  <div className="mode-card-head">
                    <strong>{m.title}</strong>
                  </div>
                  <p>{m.desc}</p>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <footer className="wizard-footer">
        {step > 0 ? (
          <button type="button" className="btn btn-ghost" onClick={() => navigateGuarded(() => setStep(step - 1), 'settings')}>
            Back
          </button>
        ) : (
          <span />
        )}
        {step === 0 ? (
          <button type="button" className="btn btn-primary" onClick={() => setStep(1)}>
            Get started
          </button>
        ) : null}
        {step === 2 ? (
          <button type="button" className="btn btn-primary" onClick={() => setStep(3)}>
            Next
          </button>
        ) : null}
        {step === 3 ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={starting}
            onClick={() => void startSession('chat')}
          >
            {starting ? <span className="spinner" aria-hidden="true" /> : null}
            Start chatting
          </button>
        ) : null}
      </footer>
    </div>
  )
}
