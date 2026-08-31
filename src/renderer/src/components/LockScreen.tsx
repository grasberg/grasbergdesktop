import { useState } from 'react'
import { useLockStore } from '@/stores/lock'

/**
 * Full-window lock overlay (v45). Rendered instead of the app tree while
 * locked; deliberately depends on NOTHING loaded over IPC (settings:get is
 * refused while locked) — existing CSS tokens only.
 */
export default function LockScreen(): React.JSX.Element {
  const unlockError = useLockStore((s) => s.unlockError)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (!passphrase || busy) return
    setBusy(true)
    try {
      const unlocked = await useLockStore.getState().unlock(passphrase)
      if (unlocked) setPassphrase('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lock-screen" role="dialog" aria-label="Grasberg is locked">
      <form
        className="lock-card"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h2 className="lock-title">Grasberg is locked</h2>
        <p className="lock-hint">Enter your passphrase to continue.</p>
        <input
          type="password"
          className="input lock-input"
          aria-label="Passphrase"
          placeholder="Passphrase"
          autoFocus
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
        />
        {unlockError ? (
          <p className="lock-error" role="alert">
            {unlockError}
          </p>
        ) : null}
        <button type="submit" className="btn btn-primary lock-unlock" disabled={busy || !passphrase}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
    </div>
  )
}
