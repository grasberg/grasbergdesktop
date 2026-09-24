import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import type { BotAvatar } from '@shared/types'
import { BotAvatarBadge } from '@/components/bots/BotAvatarBadge'
import { prepareBotAvatar } from '@/lib/bot-avatar-image'

const EMOJIS = [
  ['🤖', 'Robot'], ['🔎', 'Research'], ['🧠', 'Brain'], ['💡', 'Idea'], ['💻', 'Computer'], ['🛠️', 'Tools'],
  ['🎨', 'Art'], ['✍️', 'Writing'], ['📚', 'Books'], ['📊', 'Chart'], ['🧮', 'Calculator'], ['🌍', 'World'],
  ['🚀', 'Rocket'], ['⭐', 'Star'], ['⚡', 'Lightning'], ['🎯', 'Target'], ['🧭', 'Compass'], ['🛡️', 'Shield'],
  ['🦊', 'Fox'], ['🐼', 'Panda'], ['🐱', 'Cat'], ['🐶', 'Dog'], ['🦉', 'Owl'], ['🐙', 'Octopus'],
  ['🌱', 'Seedling'], ['🌻', 'Sunflower'], ['🌈', 'Rainbow'], ['☀️', 'Sun'], ['🌙', 'Moon'], ['🔥', 'Fire'],
  ['🎵', 'Music'], ['🎬', 'Film'], ['🎮', 'Game'], ['💼', 'Briefcase'], ['🤝', 'Handshake'], ['❤️', 'Heart'],
] as const

export default function BotAvatarPicker({ name, avatar, disabled, onChange, onBusyChange }: {
  name: string
  avatar: BotAvatar
  disabled: boolean
  onChange: (patch: Partial<BotAvatar>) => void
  onBusyChange: (busy: boolean) => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const emojiButton = useRef<HTMLButtonElement>(null)
  const request = useRef(0)
  const pickerId = useId()
  useEffect(() => () => { request.current++ }, [])

  const upload = async (file: File): Promise<void> => {
    const current = ++request.current
    setBusy(true); onBusyChange(true); setError('')
    try {
      const imageDataUrl = await prepareBotAvatar(file)
      if (current === request.current) onChange({ imageDataUrl })
    } catch (e) {
      if (current === request.current) setError(e instanceof Error ? e.message : 'Could not load this image.')
    } finally {
      if (current === request.current) { setBusy(false); onBusyChange(false) }
    }
  }

  return (
    <div className="bot-avatar-picker">
      <span className="bot-avatar-label">Bot avatar</span>
      <div className="bot-avatar-controls">
        <BotAvatarBadge agent={{ name: name || 'Bot', avatar }} size={64} />
        <div className="bot-avatar-options">
          <div className="bot-avatar-buttons">
            <button type="button" ref={emojiButton} aria-expanded={open} aria-controls={pickerId}
              disabled={disabled || busy} onClick={() => setOpen(!open)}>Choose emoji</button>
            <button type="button" disabled={disabled || busy} onClick={() => inputRef.current?.click()}>
              {busy ? 'Preparing image…' : avatar.imageDataUrl ? 'Change profile image' : 'Add profile image'}
            </button>
            {avatar.imageDataUrl && <button type="button" disabled={disabled || busy}
              onClick={() => { onChange({ imageDataUrl: null }); setError('') }}>Remove image</button>}
          </div>
          <label className="bot-avatar-custom">Emoji (or paste your own)
            <input value={avatar.emoji ?? ''} maxLength={16} placeholder="🤖" disabled={disabled || busy}
              onChange={(e) => onChange({ emoji: e.target.value, imageDataUrl: null })} />
          </label>
          <span className="bot-form-hint">PNG, JPEG or WebP, up to 10 MB. Stored with the bot profile on your desktop.</span>
        </div>
      </div>
      <input ref={inputRef} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="Bot profile image"
        onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void upload(file) }} />
      {open && <div id={pickerId} className="bot-emoji-picker" role="group" aria-label="Choose a bot emoji"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); emojiButton.current?.focus() } }}>
        {EMOJIS.map(([emoji, label]) => <button key={emoji} type="button" title={label}
          aria-label={`${label} emoji`} aria-pressed={avatar.emoji === emoji && !avatar.imageDataUrl}
          disabled={disabled || busy} onClick={() => {
            onChange({ emoji, imageDataUrl: null }); setOpen(false); emojiButton.current?.focus()
          }}>{emoji}</button>)}
      </div>}
      {error && <p className="bot-avatar-error" role="alert">{error}</p>}
    </div>
  )
}
