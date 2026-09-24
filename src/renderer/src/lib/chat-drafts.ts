import type { ConversationDraft } from '@shared/ipc'
import { unwrap } from '@/api/uld'

// Kept outside the composer, which unmounts on Home/Workflows navigation.
const cache = new Map<string, ConversationDraft>()
const loads = new Map<string, Promise<ConversationDraft>>()
const writes = new Map<string, Promise<void>>()
let epoch = 0
export const emptyChatDraft = (): ConversationDraft => ({ text: '', attachments: [] })
export const getChatDraft = (id: string): ConversationDraft => cache.get(id) ?? emptyChatDraft()
export function loadChatDraft(id: string): Promise<ConversationDraft> {
  if (cache.has(id)) return Promise.resolve(cache.get(id)!)
  let pending = loads.get(id)
  if (!pending) {
    const started = epoch
    pending = unwrap(window.uld.conversations.getDraft(id)).then(value => {
      if (started !== epoch) return emptyChatDraft()
      if (!cache.has(id)) cache.set(id, value ?? emptyChatDraft())
      return cache.get(id)!
    }).finally(() => { if (loads.get(id) === pending) loads.delete(id) })
    loads.set(id, pending)
  }
  return pending
}
export function saveChatDraft(id: string, patch: Partial<ConversationDraft>): Promise<void> {
  const value = { ...getChatDraft(id), ...patch }
  const api = window.uld
  cache.set(id, value)
  const write = (writes.get(id) ?? Promise.resolve()).catch(() => {}).then(() => unwrap(api.conversations.saveDraft(id, value)))
  writes.set(id, write)
  void write.finally(() => { if (writes.get(id) === write) writes.delete(id) }).catch(() => {})
  return write
}
export function forgetCachedDrafts(): void { epoch++; cache.clear(); loads.clear() }
