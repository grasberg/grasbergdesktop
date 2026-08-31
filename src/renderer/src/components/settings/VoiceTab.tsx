import { useEffect } from 'react'
import type { VoiceModelId } from '@shared/types'
import { usePersistSettings } from '@/hooks/usePersistSettings'
import { useSettingsStore } from '@/stores/settings'
import { useVoiceStore } from '@/stores/voice'
import { formatBytes } from '@/lib/format'

const MODEL_LABELS: Record<VoiceModelId, string> = {
  tiny: 'Tiny — fastest, least accurate',
  base: 'Base — recommended',
}

export default function VoiceTab() {
  const settings = useSettingsStore((s) => s.settings)
  const persist = usePersistSettings()
  const status = useVoiceStore((s) => s.status)
  const loaded = useVoiceStore((s) => s.loaded)
  const progress = useVoiceStore((s) => s.downloadProgress)

  useEffect(() => {
    if (!loaded) void useVoiceStore.getState().load()
  }, [loaded])

  if (!settings) {
    return <p className="field-hint">Loading settings…</p>
  }

  const downloading = status?.downloading === true
  const activeDownloaded =
    status?.models.some((m) => m.id === status.activeModelId && m.downloaded) === true

  return (
    <section aria-label="Voice">
      <header className="tab-header">
        <div>
          <h3>Voice</h3>
          <p className="field-hint">
            Everything runs on this computer: dictation uses a locally downloaded whisper.cpp
            model, read-aloud uses the system voice. Nothing is sent to any speech service.
          </p>
        </div>
      </header>

      <label className="field-checkbox">
        <input
          type="checkbox"
          checked={settings.voiceInputEnabled}
          onChange={(e) => void persist({ voiceInputEnabled: e.target.checked })}
        />
        <span>
          Voice input (push-to-talk)
          <span className="field-hint">
            Adds a microphone button to the composer. The microphone permission is granted to the
            app&apos;s own window only, and only while this is on.
            {!status?.binaryReady || !activeDownloaded
              ? ' The button appears once the model below is downloaded.'
              : ''}
          </span>
        </span>
      </label>

      <label className="field-checkbox">
        <input
          type="checkbox"
          checked={settings.voiceReadAloudEnabled}
          onChange={(e) => void persist({ voiceReadAloudEnabled: e.target.checked })}
        />
        <span>
          Read replies aloud
          <span className="field-hint">
            Adds a read-aloud button to assistant messages (system voices, offline; no model
            download needed).
          </span>
        </span>
      </label>

      <h4 className="section-subhead">Speech-to-text model</h4>
      {status === null ? (
        <p className="field-hint">Loading voice status…</p>
      ) : (
        <>
          {(status.models ?? []).map((model) => (
            <div key={model.id} className="voice-model-row">
              <label className="field-checkbox voice-model-pick">
                <input
                  type="radio"
                  name="uld-voice-model"
                  checked={settings.voiceModelId === model.id}
                  onChange={() => void persist({ voiceModelId: model.id })}
                />
                <span>
                  {MODEL_LABELS[model.id]}
                  <span className="field-hint">
                    {formatBytes(model.sizeBytes)}
                    {model.downloaded ? ' · downloaded' : ' · not downloaded'}
                  </span>
                </span>
              </label>
              {model.downloaded ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void useVoiceStore.getState().remove(model.id)}
                >
                  Remove
                </button>
              ) : downloading ? null : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void useVoiceStore.getState().download(model.id)}
                >
                  Download
                </button>
              )}
            </div>
          ))}

          {downloading && (
            <div className="voice-progress">
              <span>
                {progress?.status === 'verifying'
                  ? 'Verifying checksum…'
                  : progress?.status === 'extracting'
                    ? 'Extracting…'
                    : progress
                      ? `Downloading ${progress.item === 'binary' ? 'whisper binary' : 'model'}: ${formatBytes(progress.receivedBytes)}${progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ''}`
                      : 'Starting download…'}
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void useVoiceStore.getState().cancelDownload()}
              >
                Cancel
              </button>
            </div>
          )}
          {progress?.status === 'error' && (
            <p className="form-error">Download failed: {progress.error ?? 'unknown error'}</p>
          )}

          <h4 className="section-subhead">Engine</h4>
          <p className="field-hint">
            {status.binaryReady
              ? `Whisper binary: ready (${status.binarySource === 'custom' ? 'custom path' : 'downloaded'}).`
              : status.platformDownloadSupported
                ? 'Whisper binary: downloaded together with the first model.'
                : 'Automatic download is not available on this OS — pick a locally built whisper-cli binary below.'}
          </p>
          <div className="voice-model-row">
            <span className="field-hint">
              {status.platformDownloadSupported
                ? 'Advanced: use a custom whisper-cli binary instead of the downloaded one.'
                : 'Pick your locally built whisper-cli binary.'}
            </span>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void useVoiceStore.getState().pickBinary(false)}
            >
              Pick…
            </button>
            {status.binarySource === 'custom' && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void useVoiceStore.getState().pickBinary(true)}
              >
                Clear
              </button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
