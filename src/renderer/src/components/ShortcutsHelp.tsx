import { useEffect } from 'react'
import { useUiStore } from '@/stores/ui'
import './settings/settings.css'

const isMac = /mac/i.test(navigator.platform || navigator.userAgent)
const MOD = isMac ? '⌘' : 'Ctrl'

const SHORTCUTS: { label: string; keys: string[] }[] = [
  { label: 'New chat', keys: [MOD, 'N'] },
  { label: 'Command palette', keys: [MOD, 'K'] },
  { label: 'Settings', keys: [MOD, ','] },
  { label: 'Send message', keys: ['Enter'] },
  { label: 'New line', keys: ['Shift', 'Enter'] },
  { label: 'Stop generation / close dialogs', keys: ['Esc'] },
]

export default function ShortcutsHelp() {
  const open = useUiStore((s) => s.shortcutsOpen)
  const openShortcuts = useUiStore((s) => s.openShortcuts)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        openShortcuts(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, openShortcuts])

  if (!open) return null

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) openShortcuts(false)
      }}
    >
      <div
        className="modal shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
      >
        <header className="settings-header">
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <button
            type="button"
            className="btn-icon"
            aria-label="Close keyboard shortcuts"
            onClick={() => openShortcuts(false)}
          >
            ✕
          </button>
        </header>
        <ul className="shortcuts-list">
          {SHORTCUTS.map((s) => (
            <li key={s.label} className="shortcut-row">
              <span>{s.label}</span>
              <span className="shortcut-keys">
                {s.keys.map((k, i) => (
                  <span key={i}>
                    {i > 0 ? <span className="key-plus">+</span> : null}
                    <span className="kbd">{k}</span>
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
