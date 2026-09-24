import { create } from 'zustand'
import { useModalBehavior } from '@/hooks/useModalBehavior'

interface Confirmation { title: string; message: string; accept: string; resolve: (value: boolean) => void }
const useConfirmation = create<{ request: Confirmation | null }>(() => ({ request: null }))
export function confirmAction(title: string, message: string, accept = 'Continue'): Promise<boolean> {
  // A second click must not replace the first dialog's unresolved promise.
  if (useConfirmation.getState().request) return Promise.resolve(false)
  return new Promise(resolve => useConfirmation.setState({ request: { title, message, accept, resolve } }))
}
export default function ConfirmDialog() {
  const request = useConfirmation(s => s.request)
  const answer = (ok: boolean): void => { useConfirmation.setState({ request: null }); request?.resolve(ok) }
  const ref = useModalBehavior(!!request, () => answer(false))
  if (!request) return null
  return <div className="modal-backdrop" style={{ zIndex: 10000 }}>
    <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message" style={{ maxWidth: 480, padding: 24 }}>
      <h2 id="confirm-title">{request.title}</h2><p id="confirm-message">{request.message}</p>
      <div className="form-actions"><button type="button" className="btn" data-autofocus onClick={() => answer(false)}>Cancel</button><button type="button" className="btn btn-primary" onClick={() => answer(true)}>{request.accept}</button></div>
    </div>
  </div>
}
