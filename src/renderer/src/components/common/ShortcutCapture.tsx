import { useState, type KeyboardEvent } from 'react'

/** Capture an Electron accelerator without requiring users to know its syntax. */
export default function ShortcutCapture({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [recording, setRecording] = useState(false)
  const [message, setMessage] = useState('')
  const capture = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording || event.key === 'Tab') return
    event.preventDefault(); event.stopPropagation()
    if (event.key === 'Escape') { setRecording(false); return }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return
    if (!event.ctrlKey && !event.altKey && !event.metaKey) { setMessage('Include Ctrl, Alt or Command.'); return }
    const key = event.code === 'Space' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key
    onChange([event.ctrlKey && 'Control', event.metaKey && 'Super', event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join('+'))
    setRecording(false); setMessage('Captured. Save to apply this shortcut.')
  }
  return <div><button type="button" className="btn" aria-pressed={recording} onClick={() => { setRecording(true); setMessage('Press a key combination. Escape cancels.') }} onBlur={() => setRecording(false)} onKeyDown={capture}>{recording ? 'Press shortcut…' : value || 'Record shortcut'}</button> <button type="button" className="btn btn-ghost" onClick={() => { onChange(''); setMessage('Shortcut disabled after saving.') }}>Clear</button><span className="field-hint" role="status">{message}</span></div>
}
