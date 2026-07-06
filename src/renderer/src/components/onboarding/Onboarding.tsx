import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
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
        One fast, local-first desktop client for DeepSeek, GLM, MiniMax and any OpenAI-compatible
        endpoint — chat with the model you want, switch providers mid-project, and keep everything
        on your own machine.
      </p>
      <ul className="wizard-bullets">
        <li>Conversations and settings are stored locally, never on our servers.</li>
        <li>API keys are encrypted with your OS keychain and never leave this device.</li>
        <li>The only network traffic goes to the LLM providers you configure.</li>
        <li>No telemetry.</li>
      </ul>
    </div>
  )
}

function VerifyStep({ provider }: { provider: ProviderConfig }) {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.update)
  const modelsByProvider = useProvidersStore((s) => s.modelsByProvider)
  const loadModels = useProvidersStore((s) => s.loadModels)
  const toast = useUiStore((s) => s.toast)

  const { testing, result: testResult, run: runTest } = useTestConnection(provider.id)
  const [custom, setCustom] = useState('')

  const models = modelsByProvider[provider.id] ?? []
  const selectedModel =
    settings && settings.defaultProviderId === provider.id ? settings.defaultModelId : null

  useEffect(() => {
    if (!modelsByProvider[provider.id]) {
      void loadModels(provider.id).catch(() => {
        // Best-effort; the custom model input below still works.
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id])

  async function choose(modelId: string) {
    try {
      await updateSettings({ defaultProviderId: provider.id, defaultModelId: modelId })
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  return (
    <div className="wizard-step">
      <h1>Verify &amp; choose a model</h1>
      <p className="wizard-pitch">
        Check that <strong>{provider.label}</strong> is reachable, then pick the model new chats
        should use.
      </p>

      <div className="wizard-test-row">
        <button type="button" className="btn" onClick={() => void runTest()} disabled={testing}>
          Test connection
        </button>
        <TestResult testing={testing} result={testResult} />
      </div>

      {models.length > 0 ? (
        <div className="wizard-model-list" role="radiogroup" aria-label="Default model">
          {models.map((m) => (
            <label key={m.id} className={`wizard-model${selectedModel === m.id ? ' selected' : ''}`}>
              <input
                type="radio"
                name="onb-model"
                value={m.id}
                checked={selectedModel === m.id}
                onChange={() => void choose(m.id)}
              />
              <span className="wizard-model-label">{m.label ?? m.id}</span>
              {m.contextLength ? (
                <span className="badge">{Math.round(m.contextLength / 1000)}k ctx</span>
              ) : null}
              {m.capabilities.reasoning ? <span className="badge">reasoning</span> : null}
              {m.capabilities.vision ? <span className="badge">vision</span> : null}
            </label>
          ))}
        </div>
      ) : (
        <p className="field-hint">No model list available — enter a model id below.</p>
      )}

      <div className="wizard-custom-model">
        <input
          className="input mono"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Or type a custom model id…"
          aria-label="Custom model id"
          spellCheck={false}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter' && custom.trim()) {
              e.preventDefault()
              void choose(custom.trim())
            }
          }}
        />
        <button
          type="button"
          className="btn"
          disabled={!custom.trim()}
          onClick={() => void choose(custom.trim())}
        >
          Use this model
        </button>
      </div>

      {selectedModel ? (
        <p className="field-hint" role="status">
          Default model set to <span className="mono">{selectedModel}</span>.
        </p>
      ) : null}
    </div>
  )
}

const MODE_CARDS: ReadonlyArray<{ id: ConversationMode; title: string; desc: string }> = [
  {
    id: 'chat',
    title: 'Chat',
    desc: 'Classic assistant conversations with streaming, markdown and attachments.',
  },
  {
    id: 'cowork',
    title: 'Cowork',
    desc: 'Plan projects together — shared notes, checklists and tasks.',
  },
  {
    id: 'code',
    title: 'Code',
    desc: 'Point at a folder and review AI-proposed changes before they touch disk.',
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
    void persist({ onboardingCompleted: true })
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
            <ProviderAddForm
              submitLabel="Create provider & continue"
              onCreated={(p) => {
                setCreatedProviderId(p.id)
                setStep(2)
              }}
            />
            <button type="button" className="btn btn-ghost wizard-later" onClick={() => setStep(3)}>
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
            <p className="wizard-pitch">Three ways to work — pick one to begin.</p>
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
          <button type="button" className="btn btn-ghost" onClick={() => setStep(step - 1)}>
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
