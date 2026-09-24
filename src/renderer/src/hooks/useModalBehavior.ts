import { useEffect, useRef } from 'react'

function topDialog(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
    .filter(el => el.getClientRects().length > 0)
    .sort((a, b) => {
      const z = (el: HTMLElement): number => Math.max(0, ...[el, ...ancestors(el)].map(e => Number.parseInt(getComputedStyle(e).zIndex) || 0))
      return z(a) - z(b)
    }).at(-1)
}
function ancestors(el: HTMLElement): HTMLElement[] {
  const result: HTMLElement[] = []
  for (let parent = el.parentElement; parent; parent = parent.parentElement) result.push(parent)
  return result
}

/** Keyboard focus stays in the frontmost dialog and returns to its trigger. */
export function useModalBehavior(open: boolean, onClose?: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const dialog = ref.current
    if (!open || !dialog) return
    const previous = document.activeElement as HTMLElement | null
    const focusables = (): HTMLElement[] => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')].filter(e => e.getClientRects().length > 0)
    dialog.tabIndex = -1
    if (!dialog.contains(document.activeElement)) (dialog.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? dialog).focus()
    const keydown = (e: KeyboardEvent): void => {
      if (topDialog() !== dialog) return
      if (e.key === 'Escape' && close.current) {
        e.preventDefault(); e.stopImmediatePropagation(); close.current(); return
      }
      if (e.key !== 'Tab') return
      const list = focusables()
      const first = list[0] ?? dialog
      const last = list.at(-1) ?? dialog
      if (!dialog.contains(document.activeElement) || (e.shiftKey && document.activeElement === first) || (!e.shiftKey && document.activeElement === last)) {
        e.preventDefault(); (e.shiftKey ? last : first).focus()
      }
    }
    const focusin = (e: FocusEvent): void => {
      if (topDialog() === dialog && !dialog.contains(e.target as Node)) (focusables()[0] ?? dialog).focus()
    }
    window.addEventListener('keydown', keydown, true)
    document.addEventListener('focusin', focusin)
    return () => {
      window.removeEventListener('keydown', keydown, true)
      document.removeEventListener('focusin', focusin)
      if (previous?.isConnected) previous.focus()
    }
  }, [open])
  return ref
}
