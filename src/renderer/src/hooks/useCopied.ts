import { useEffect, useRef, useState } from 'react'

/**
 * Clipboard-copy helper for copy buttons: `copy(text)` writes to the clipboard
 * and flips `copied` true for 1.5s (re-copying restarts the timer). The
 * pending timer is cleared on unmount.
 */
export function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1500)
    })
  }
  return [copied, copy]
}
