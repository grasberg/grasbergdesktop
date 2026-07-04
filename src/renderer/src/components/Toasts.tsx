import { useEffect } from 'react'
import type { Toast } from '@/stores/contracts'
import { useUiStore } from '@/stores/ui'

const AUTO_DISMISS_MS = 5000

function ToastItem({ toast }: { toast: Toast }): React.JSX.Element {
  useEffect(() => {
    const timer = setTimeout(() => useUiStore.getState().dismissToast(toast.id), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [toast.id])

  return (
    <div className={`toast toast-${toast.kind}`} role="status">
      <span className="toast-message">{toast.message}</span>
      <button
        type="button"
        className="btn-icon toast-close"
        aria-label="Dismiss notification"
        onClick={() => useUiStore.getState().dismissToast(toast.id)}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}

export default function Toasts(): React.JSX.Element {
  const toasts = useUiStore((s) => s.toasts)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  )
}
