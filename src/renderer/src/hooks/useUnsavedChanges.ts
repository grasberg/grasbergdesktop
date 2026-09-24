import { useEffect, useId } from 'react'
import { confirmAction } from '@/components/common/ConfirmDialog'

type Scope = 'settings' | 'page'
const dirtyForms = new Map<string, Scope>()
export function navigateGuarded(action: () => void, scope?: Scope): void {
  if (![...dirtyForms.values()].some(s => !scope || scope === s)) { action(); return }
  void canLeave(scope).then(ok => { if (ok) { for (const [id, s] of dirtyForms) if (!scope || scope === s) dirtyForms.delete(id); action() } })
}
export async function canLeave(scope?: Scope): Promise<boolean> {
  if (![...dirtyForms.values()].some(s => !scope || s === scope)) return true
  return confirmAction('Discard unsaved changes?', 'Your saved version will be kept. Changes in the open form will be lost.', 'Discard changes')
}
export function useUnsavedChanges(dirty: boolean, scope: Scope = 'page') {
  const id = useId()
  useEffect(() => {
    if (dirty) dirtyForms.set(id, scope)
    else dirtyForms.delete(id)
    const unload = (e: BeforeUnloadEvent): void => { if (dirtyForms.has(id)) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', unload)
    return () => { dirtyForms.delete(id); window.removeEventListener('beforeunload', unload) }
  }, [id, dirty, scope])
  return {
    markSaved: () => dirtyForms.delete(id),
    discard: (action: () => void) => {
      if (!dirtyForms.has(id)) { action(); return }
      void confirmAction('Discard unsaved changes?', 'Changes in this form will be lost.', 'Discard changes').then(ok => {
        if (ok) { dirtyForms.delete(id); action() }
      })
    },
  }
}
