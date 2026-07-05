import { useEffect, useRef } from 'react'
import { useChatStore } from '@/stores/chat'

/**
 * Runs the callback each time a generation settles, i.e. the chat store's
 * `streaming` pointer edge-transitions non-null -> null (done, error or
 * stopped). Views use this to refresh derived data the assistant may have
 * produced (proposed code changes, workspace items, ...).
 *
 * The callback is kept in a ref so an inline closure never re-arms the effect;
 * only the streaming transition triggers it.
 */
export function useOnGenerationSettled(onSettled: () => void): void {
  const streaming = useChatStore((s) => s.streaming)
  const prevStreaming = useRef(streaming)
  const callback = useRef(onSettled)
  callback.current = onSettled
  useEffect(() => {
    const finished = prevStreaming.current !== null && streaming === null
    prevStreaming.current = streaming
    if (finished) callback.current()
  }, [streaming])
}
