import { useEffect, useState } from 'react'

/**
 * The current epoch ms, re-rendering every `intervalMs` (default 30s). Drives
 * relative labels like "in 25m" / "2h ago" so they stay fresh while a surface
 * sits open (and self-correct after OS sleep).
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
