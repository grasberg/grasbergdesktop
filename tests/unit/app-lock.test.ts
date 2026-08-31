/**
 * App lock (v45): scrypt hashing (the passphrase itself is never stored),
 * lock-on-launch, unlock paths + the brute-force damper, idle auto-lock, push
 * suppression, and the one-choke-point IPC gate in register.ts.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { scryptSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHANNELS, type ChannelName, type IpcResult } from '@shared/ipc'
import type { AppLockStatus } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { registerIpc, type RegisterIpcDeps } from '../../src/main/ipc/register'
import {
  AppLockService,
  hashPassphrase,
  verifyPassphrase,
  windowPushAllowed,
} from '../../src/main/services/app-lock'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => tmpdir() },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
  },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    },
  },
  shell: { openPath: async () => '' },
}))

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-lock-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

interface Harness {
  service: AppLockService
  broadcasts: Array<{ channel: string; payload: unknown }>
}

function makeService(opts?: { now?: () => number; getIdleSeconds?: () => number }): Harness {
  const broadcasts: Array<{ channel: string; payload: unknown }> = []
  const service = new AppLockService({
    settings: db.settings,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    ...(opts?.now ? { now: opts.now } : {}),
    ...(opts?.getIdleSeconds ? { getIdleSeconds: opts.getIdleSeconds } : {}),
  })
  return { service, broadcasts }
}

describe('hashPassphrase / verifyPassphrase', () => {
  it('verifies the right passphrase and rejects a wrong one', () => {
    const hash = hashPassphrase('correct horse')
    expect(hash.algo).toBe('scrypt')
    expect(verifyPassphrase('correct horse', hash)).toBe(true)
    expect(verifyPassphrase('wrong pony', hash)).toBe(false)
  })

  it('verifies against the STORED params (old hashes survive cost bumps)', () => {
    // A hash minted at WEAKER params than today's defaults must still verify,
    // because verifyPassphrase reads N/r/p/keyLen from the stored object.
    const salt = Buffer.from('0123456789abcdef')
    const weak = {
      algo: 'scrypt' as const,
      saltBase64: salt.toString('base64'),
      hashBase64: scryptSync('pass-123456', salt, 32, { N: 4096, r: 8, p: 1 }).toString('base64'),
      n: 4096,
      r: 8,
      p: 1,
      keyLen: 32,
    }
    expect(verifyPassphrase('pass-123456', weak)).toBe(true)
    expect(verifyPassphrase('other', weak)).toBe(false)
  })
})

describe('AppLockService', () => {
  it('setPassphrase stores a verifier — the raw passphrase appears nowhere in settings', () => {
    const { service } = makeService()
    service.setPassphrase({ next: 'super secret phrase' })

    const stored = db.settings.get().appLockHash
    expect(stored).not.toBeNull()
    expect(stored?.algo).toBe('scrypt')
    const rows = db.driver.all<{ key: string; value_json: string }>(
      'SELECT key, value_json FROM settings'
    )
    for (const row of rows) {
      expect(row.value_json).not.toContain('super secret phrase')
    }
  })

  it('starts UNLOCKED with no passphrase and LOCKED over a configured database', () => {
    expect(makeService().service.isLocked()).toBe(false)
    db.settings.update({ appLockHash: hashPassphrase('pass-123456') })
    const fresh = makeService()
    expect(fresh.service.isLocked()).toBe(true)
    expect(fresh.service.status()).toEqual({ configured: true, locked: true, idleMinutes: null })
  })

  it('unlock: wrong throws auth, right unlocks and broadcasts appLockChanged', () => {
    db.settings.update({ appLockHash: hashPassphrase('pass-123456') })
    const { service, broadcasts } = makeService()

    expect(() => service.unlock('nope')).toThrowError(/Wrong passphrase/)
    expect(service.isLocked()).toBe(true)

    const status = service.unlock('pass-123456')
    expect(status.locked).toBe(false)
    expect(service.isLocked()).toBe(false)
    expect(broadcasts).toEqual([
      { channel: CHANNELS.appLockChanged, payload: { locked: false } },
    ])
  })

  it('5 consecutive failures refuse further attempts for 30 s, then recover', () => {
    db.settings.update({ appLockHash: hashPassphrase('pass-123456') })
    let now = 1_000_000
    const { service } = makeService({ now: () => now })

    for (let i = 0; i < 5; i++) {
      expect(() => service.unlock('bad')).toThrowError(/Wrong passphrase/)
    }
    // Even the CORRECT passphrase is refused during the damper window.
    expect(() => service.unlock('pass-123456')).toThrowError(/Too many attempts/)
    now += 31_000
    expect(service.unlock('pass-123456').locked).toBe(false)
  })

  it('setPassphrase requires the current passphrase to change or remove', () => {
    const { service } = makeService()
    service.setPassphrase({ next: 'first-pass' })

    expect(() => service.setPassphrase({ next: 'second-pass' })).toThrowError(
      /current passphrase/
    )
    expect(() => service.setPassphrase({ current: 'wrong', next: null })).toThrowError(
      /current passphrase/
    )
    service.setPassphrase({ current: 'first-pass', next: 'second-pass' })
    expect(verifyPassphrase('second-pass', db.settings.get().appLockHash!)).toBe(true)

    service.setPassphrase({ current: 'second-pass', next: null })
    expect(db.settings.get().appLockHash).toBeNull()
  })

  it('checkIdle locks only when configured, enabled and past the threshold', () => {
    let idle = 0
    // Unconfigured: never locks no matter the idle time.
    idle = 10_000
    const unconfigured = makeService({ getIdleSeconds: () => idle })
    unconfigured.service.checkIdle()
    expect(unconfigured.service.isLocked()).toBe(false)

    db.settings.update({ appLockHash: hashPassphrase('pass-123456') })
    db.settings.update({ appLockIdleMinutes: 5 })
    const { service, broadcasts } = makeService({ getIdleSeconds: () => idle })
    service.unlock('pass-123456')
    broadcasts.length = 0

    idle = 4 * 60
    service.checkIdle()
    expect(service.isLocked()).toBe(false)

    idle = 5 * 60
    service.checkIdle()
    expect(service.isLocked()).toBe(true)
    expect(broadcasts).toEqual([
      { channel: CHANNELS.appLockChanged, payload: { locked: true } },
    ])
    // Already locked: no duplicate broadcast.
    service.checkIdle()
    expect(broadcasts).toHaveLength(1)
  })

  it('never auto-locks while appLockIdleMinutes is null', () => {
    db.settings.update({ appLockHash: hashPassphrase('pass-123456') })
    const { service } = makeService({ getIdleSeconds: () => 10_000 })
    service.unlock('pass-123456')
    service.checkIdle()
    expect(service.isLocked()).toBe(false)
  })
})

describe('windowPushAllowed', () => {
  it('lets only push:appLockChanged through while locked', () => {
    expect(windowPushAllowed(true, CHANNELS.appLockChanged)).toBe(true)
    expect(windowPushAllowed(true, CHANNELS.streamEvent)).toBe(false)
    expect(windowPushAllowed(true, CHANNELS.toolApprovalRequest)).toBe(false)
    expect(windowPushAllowed(true, CHANNELS.mainNotice)).toBe(false)
    expect(windowPushAllowed(false, CHANNELS.streamEvent)).toBe(true)
  })
})

describe('the IPC lock gate', () => {
  async function invoke<T>(channel: ChannelName, ...args: unknown[]): Promise<IpcResult<T>> {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`No handler registered for ${channel}`)
    return (await handler(null, ...args)) as IpcResult<T>
  }

  function registerHarness(service: AppLockService): void {
    handlers.clear()
    registerIpc({
      db,
      chatService: { stopConversation: () => undefined },
      imBridgeManager: {},
      workspaceRoots: { withAutoFlag: (p: unknown) => p, deleteIfAutoRegistered: () => undefined },
      getWindows: () => [],
      appLock: service,
    } as unknown as RegisterIpcDeps)
  }

  it('while locked, everything but lock:status/lock:unlock is refused as auth', async () => {
    db.settings.update({ appLockHash: hashPassphrase('pass-123456') })
    const { service } = makeService()
    registerHarness(service)
    expect(service.isLocked()).toBe(true)

    for (const channel of [CHANNELS.convList, CHANNELS.settingsGet, CHANNELS.spacesList]) {
      const refused = await invoke(channel)
      expect(refused.ok, channel).toBe(false)
      if (!refused.ok) {
        expect(refused.error.code).toBe('auth')
        expect(refused.error.message).toContain('locked')
      }
    }

    const status = await invoke<AppLockStatus>(CHANNELS.lockStatus)
    expect(status.ok).toBe(true)
    if (status.ok) expect(status.data).toMatchObject({ configured: true, locked: true })

    const wrong = await invoke(CHANNELS.lockUnlock, { passphrase: 'bad' })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.error.code).toBe('auth')

    const unlocked = await invoke<AppLockStatus>(CHANNELS.lockUnlock, {
      passphrase: 'pass-123456',
    })
    expect(unlocked.ok).toBe(true)
    if (unlocked.ok) expect(unlocked.data.locked).toBe(false)

    // Post-unlock, the same channel serves normally again.
    expect((await invoke(CHANNELS.convList)).ok).toBe(true)
  })

  it('lock:lockNow locks immediately and gates the next request', async () => {
    db.settings.update({ appLockHash: hashPassphrase('pass-123456') })
    const { service } = makeService()
    service.unlock('pass-123456')
    registerHarness(service)

    const locked = await invoke<AppLockStatus>(CHANNELS.lockNow)
    expect(locked.ok).toBe(true)
    if (locked.ok) expect(locked.data.locked).toBe(true)
    expect((await invoke(CHANNELS.convList)).ok).toBe(false)
  })

  it('settings:update cannot smuggle an appLockHash (strict patch schema)', async () => {
    const { service } = makeService()
    service.setPassphrase({ next: 'pass-123456' })
    const stored = db.settings.get().appLockHash
    registerHarness(service)

    const smuggled = await invoke(CHANNELS.settingsUpdate, {
      appLockHash: { algo: 'scrypt', saltBase64: 'x', hashBase64: 'x', n: 2, r: 1, p: 1, keyLen: 32 },
    })
    expect(smuggled.ok).toBe(false)
    expect(db.settings.get().appLockHash).toEqual(stored)
  })

  it('lock channels answer harmlessly when no appLock dep is wired (partial-deps registrations)', async () => {
    handlers.clear()
    registerIpc({
      db,
      chatService: { stopConversation: () => undefined },
      imBridgeManager: {},
      workspaceRoots: { withAutoFlag: (p: unknown) => p, deleteIfAutoRegistered: () => undefined },
      getWindows: () => [],
    } as unknown as RegisterIpcDeps)

    const status = await invoke<AppLockStatus>(CHANNELS.lockStatus)
    expect(status.ok).toBe(true)
    if (status.ok) expect(status.data).toEqual({ configured: false, locked: false, idleMinutes: null })
    expect((await invoke(CHANNELS.lockUnlock, { passphrase: 'x' })).ok).toBe(false)
  })
})
