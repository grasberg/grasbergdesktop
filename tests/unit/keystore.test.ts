/**
 * Keystore over a real temp db with a faked safeStorage (the real one needs
 * Electron): the startup upgrade pass must lift EVERY secret out of the
 * insecure fallback form — provider keys, OAuth tokens and the tool_secrets
 * rows behind MCP headers, IM bot tokens and custom-tool secret headers.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'

const safeStorage = {
  available: true,
  backend: 'gnome_libsecret' as
    | 'basic_text'
    | 'gnome_libsecret'
    | 'kwallet'
    | 'kwallet5'
    | 'kwallet6'
    | 'unknown',
  isEncryptionAvailable: (): boolean => safeStorage.available,
  getSelectedStorageBackend: () => safeStorage.backend,
  encryptString: (plain: string): Buffer => Buffer.from(`os:${plain}`, 'utf8'),
  decryptString: (buf: Buffer): string => buf.toString('utf8').slice(3),
}

vi.mock('electron', () => ({ safeStorage }))

const { hasSecureStorageBackend, reencryptInsecureKeys } = await import(
  '../../src/main/keys/keystore'
)

const insecure = (plain: string): string =>
  `insecure:${Buffer.from(plain, 'utf8').toString('base64')}`

/** Ciphertext is stored as base64 of what safeStorage produced. */
const stored = (cipher: string): string => Buffer.from(cipher, 'base64').toString('utf8')

let dir: string
let db: AppDatabase

beforeEach(() => {
  safeStorage.available = true
  safeStorage.backend = 'gnome_libsecret'
  dir = mkdtempSync(join(tmpdir(), 'uld-keystore-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function seedInsecureSecrets(): void {
  db.providers.create({
    id: 'p1',
    type: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModelId: 'deepseek-chat',
  })
  db.providers.setKeyRow('p1', insecure('sk-provider-key'), '…key')
  db.providers.setOAuthRow({
    providerId: 'p1',
    encryptedAccess: insecure('access-token'),
    encryptedRefresh: insecure('refresh-token'),
    accountId: null,
    accountLabel: null,
    expiresAt: null,
  })
  db.secrets.set('im_bridge', 'telegram', 'token', insecure('bot-token'), '…oken')
  db.secrets.set('mcp_server', 'srv1', 'Authorization', insecure('mcp-header'), '…ader')
  db.secrets.set('custom_tool', 'tool1', 'X-Api-Key', insecure('tool-secret'), '…cret')
}

describe('reencryptInsecureKeys', () => {
  it('rejects Linux basic_text and unknown backends despite reported availability', () => {
    safeStorage.backend = 'basic_text'
    expect(hasSecureStorageBackend(safeStorage, 'linux')).toBe(false)
    safeStorage.backend = 'unknown'
    expect(hasSecureStorageBackend(safeStorage, 'linux')).toBe(false)
    safeStorage.backend = 'kwallet6'
    expect(hasSecureStorageBackend(safeStorage, 'linux')).toBe(true)
    safeStorage.backend = 'basic_text'
    expect(hasSecureStorageBackend(safeStorage, 'win32')).toBe(true)
  })

  it('upgrades every insecure secret, not just provider keys', () => {
    seedInsecureSecrets()

    expect(reencryptInsecureKeys(db)).toBe(6)

    expect(stored(db.providers.getEncryptedKey('p1')!)).toBe('os:sk-provider-key')
    const oauth = db.providers.getOAuthRow('p1')!
    expect(stored(oauth.encryptedAccess)).toBe('os:access-token')
    expect(stored(oauth.encryptedRefresh!)).toBe('os:refresh-token')
    for (const [scope, owner, plain] of [
      ['im_bridge', 'telegram', 'bot-token'],
      ['mcp_server', 'srv1', 'mcp-header'],
      ['custom_tool', 'tool1', 'tool-secret'],
    ] as const) {
      const [cipher] = db.secrets.listCiphers(scope, owner)
      expect(cipher.encryptedValue).not.toMatch(/^insecure:/)
      expect(stored(cipher.encryptedValue)).toBe(`os:${plain}`)
    }
    // Nothing insecure is left behind anywhere.
    expect(reencryptInsecureKeys(db)).toBe(0)
  })

  it('leaves rows untouched and reports insecurely stored secrets when the OS backend is gone', async () => {
    seedInsecureSecrets()
    db.providers.setKeyRow('p1', 'os:sk-provider-key', '…key') // only tool secrets stay insecure
    safeStorage.available = false

    expect(reencryptInsecureKeys(db)).toBe(0)
    expect(db.secrets.listCiphers('im_bridge', 'telegram')[0].encryptedValue).toMatch(
      /^insecure:/
    )
    // Honest reporting: an insecure secret anywhere means encryption is not
    // fully in effect this session, even with every provider key encrypted.
    const { encryptionAvailable } = await import('../../src/main/keys/keystore')
    safeStorage.available = true
    expect(encryptionAvailable()).toBe(false)
  })
})
