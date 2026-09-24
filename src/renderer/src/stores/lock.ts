import { create } from 'zustand'
import { toNormalized, unwrap } from '@/api/uld'
import type { LockStoreState } from './contracts'
import { toastError } from './ui'
import { forgetCachedDrafts } from '@/lib/chat-drafts'

/**
 * App lock (v45). While `status.locked` the App renders only the LockScreen;
 * a wrong passphrase keeps its message here (the lock screen's inline error)
 * instead of toasting.
 */
export const useLockStore = create<LockStoreState>()((set, get) => ({
  status: null,
  unlockError: null,

  async load() {
    try {
      const status = await unwrap(window.uld.lock.status())
      if (status.locked) forgetCachedDrafts()
      set({ status })
    } catch {
      // lock:status is lock-gate-exempt; a failure here means IPC itself is
      // broken — leave status null and let the boot fallback render.
    }
  },

  async unlock(passphrase) {
    try {
      const status = await unwrap(window.uld.lock.unlock(passphrase))
      set({ status, unlockError: null })
      return true
    } catch (e) {
      set({ unlockError: toNormalized(e).message })
      return false
    }
  },

  async lockNow() {
    try {
      const status = await unwrap(window.uld.lock.lockNow())
      if (status.locked) forgetCachedDrafts()
      set({ status })
    } catch (e) {
      toastError('Could not lock', e)
    }
  },

  async setPassphrase(input) {
    // Errors (wrong current passphrase) propagate to the Settings form.
    const status = await unwrap(window.uld.lock.setPassphrase(input))
    set({ status })
  },

  handleChanged(evt) {
    if (evt.locked) forgetCachedDrafts()
    const current = get().status
    set({
      status: current
        ? { ...current, locked: evt.locked }
        : { configured: true, locked: evt.locked, idleMinutes: null },
      ...(evt.locked ? { unlockError: null } : {}),
    })
  },
}))
