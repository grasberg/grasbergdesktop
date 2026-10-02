/**
 * Remote connectors (v53): OAuth state persistence, the one-shot loopback
 * callback (state check, error redirects), the manager's needs-auth status
 * and interactive sign-in, and the connector catalog's integrity.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import { McpManager } from '../../../src/main/tools/mcp/manager'
import { UnauthorizedError, type McpConnector } from '../../../src/main/tools/mcp/transports'
import {
  awaitOAuthCallback,
  McpOAuthProvider,
  McpOAuthStore,
  OAUTH_REDIRECT_URL,
} from '../../../src/main/tools/mcp/oauth'
import {
  CONNECTOR_CATALOG,
  CONNECTOR_CATEGORIES,
  connectorToServerInput,
} from '../../../src/shared/connectors'
import { mcpServerInputSchema } from '../../../src/shared/schemas'

let dir: string
let db: AppDatabase

const keystore = {
  encryptKey: (v: string) => ({ encryptedBase64: `x:${Buffer.from(v).toString('base64')}`, preview: '…' }),
  decryptKey: (s: string) => Buffer.from(s.slice(2), 'base64').toString('utf8'),
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-mcp-oauth-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const freePort = (): number => 34000 + Math.floor(Math.random() * 2000)

describe('OAuth store + provider', () => {
  it('persists client info and tokens encrypted per server; the verifier stays on its sign-in', () => {
    const store = new McpOAuthStore(db, keystore)
    const provider = new McpOAuthProvider('srv-1', store, () => undefined)
    expect(provider.redirectUrl).toBe(OAUTH_REDIRECT_URL)
    expect(provider.clientMetadata.redirect_uris).toEqual([OAUTH_REDIRECT_URL])
    expect(provider.tokens()).toBeUndefined()
    provider.saveClientInformation({ client_id: 'abc' })
    provider.saveTokens({ access_token: 'at-secret', token_type: 'Bearer' })
    provider.saveCodeVerifier('verifier-1')
    expect(provider.clientInformation()).toEqual({ client_id: 'abc' })
    expect(provider.tokens()?.access_token).toBe('at-secret')
    expect(provider.codeVerifier()).toBe('verifier-1')
    // A background reconnect (its own provider) can neither read nor
    // overwrite the verifier of the sign-in in progress.
    const background = new McpOAuthProvider('srv-1', store, () => undefined)
    expect(() => background.codeVerifier()).toThrow(/No PKCE verifier/)
    background.saveCodeVerifier('verifier-2')
    expect(provider.codeVerifier()).toBe('verifier-1')
    expect(store.hasTokens('srv-1')).toBe(true)
    // Ciphertext only in the table.
    const raw = db.driver.all<{ encrypted_value: string }>(
      "SELECT encrypted_value FROM tool_secrets WHERE scope = 'mcp_oauth'"
    )
    expect(JSON.stringify(raw)).not.toContain('at-secret')
    provider.invalidateCredentials('tokens')
    expect(provider.tokens()).toBeUndefined()
    store.clear('srv-1')
    expect(provider.clientInformation()).toBeUndefined()
  })
})

describe('OAuth loopback callback', () => {
  it('resolves the code when the state matches', async () => {
    const port = freePort()
    const callback = awaitOAuthCallback('state-1', { port, timeoutMs: 5000 })
    await callback.ready
    const response = await fetch(`http://127.0.0.1:${port}/callback?code=the-code&state=state-1`)
    expect(await response.text()).toContain('Connected')
    expect(await callback.code).toBe('the-code')
  })

  it('ignores a forged state (keeps waiting for the real one) and rejects an error redirect', async () => {
    const port = freePort()
    const flow = awaitOAuthCallback('expected', { port, timeoutMs: 5000 })
    await flow.ready
    // Another local page can neither answer nor cancel the sign-in.
    const forged = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=forged`)
    expect(forged.status).toBe(400)
    const forgedError = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=forged`)
    expect(forgedError.status).toBe(400)
    await fetch(`http://127.0.0.1:${port}/callback?code=real-code&state=expected`)
    await expect(flow.code).resolves.toBe('real-code')

    const port2 = freePort()
    const denied = awaitOAuthCallback('s', { port: port2, timeoutMs: 5000 })
    await denied.ready
    await fetch(`http://127.0.0.1:${port2}/callback?error=access_denied&state=s`)
    await expect(denied.code).rejects.toThrow(/access_denied/)
  })
})

describe('manager OAuth flow', () => {
  it('marks a connector needs_auth, then signs in interactively and connects', async () => {
    let authorized = false
    const connector: McpConnector = async () => {
      if (!authorized) throw new UnauthorizedError('auth required')
      return {
        listTools: async () => [{ name: 'search', description: '', inputSchema: {}, readOnly: true }],
        callTool: async () => ({ content: 'ok', isError: false }),
        close: async () => undefined,
      }
    }
    const opened: string[] = []
    const manager = new McpManager({
      db,
      keystore,
      broadcast: () => undefined,
      changedChannel: 'push:mcpServersChanged',
      connector,
      openExternal: (url) => {
        opened.push(url)
      },
      beginOAuth: async (_config, _secrets, provider) => {
        // What the SDK does: open the consent page, then the service redirects back.
        provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'))
        const state = (provider as McpOAuthProvider).expectedState()
        setTimeout(() => {
          void fetch(`${OAUTH_REDIRECT_URL}?code=granted&state=${state}`)
        }, 20)
        return {
          finish: async (code) => {
            expect(code).toBe('granted')
            provider.saveTokens({ access_token: 't', token_type: 'Bearer' })
            authorized = true
          },
        }
      },
    })
    await manager.create({ name: 'Notion', transport: 'http', url: 'https://mcp.example.com/mcp' })
    const [server] = db.mcpServers.list()
    expect(manager.getRuntime()[0]).toMatchObject({ status: 'needs_auth', signedIn: false })
    const runtime = await manager.authorize(server.id)
    expect(opened).toEqual(['https://auth.example.com/authorize'])
    expect(runtime[0]).toMatchObject({ status: 'connected', signedIn: true, toolCount: 1 })
    const afterSignOut = await manager.signOut(server.id)
    expect(afterSignOut[0].signedIn).toBe(false)
  })
})

describe('connector catalog', () => {
  it('has unique ids, known categories, https remote URLs and valid server inputs', () => {
    const ids = new Set<string>()
    for (const template of CONNECTOR_CATALOG) {
      expect(ids.has(template.id)).toBe(false)
      ids.add(template.id)
      expect(CONNECTOR_CATEGORIES).toContain(template.category)
      if (template.transport === 'http') {
        expect(template.url).toMatch(/^https:\/\//)
      } else {
        expect(template.command).toBeTruthy()
      }
      if (template.auth === 'bearer' || template.auth === 'header' || template.auth === 'env') {
        expect(template.secret).toBeTruthy()
      }
      const values = template.auth === 'env' ? (template.secret?.env ?? []).map(() => 'v') : ['key']
      const input = connectorToServerInput(template, values)
      expect(() => mcpServerInputSchema.parse(input)).not.toThrow()
    }
    expect(ids.has('zapier')).toBe(true)
  })

  it('maps API keys to the right secret header or env var', () => {
    const zapier = CONNECTOR_CATALOG.find((t) => t.id === 'zapier')!
    expect(connectorToServerInput(zapier, ['zk']).setSecrets).toEqual({ Authorization: 'Bearer zk' })
    const maps = CONNECTOR_CATALOG.find((t) => t.id === 'google-maps')!
    expect(connectorToServerInput(maps, ['gk']).setSecrets).toEqual({ 'X-Goog-Api-Key': 'gk' })
    const workspace = CONNECTOR_CATALOG.find((t) => t.id === 'google-workspace')!
    expect(connectorToServerInput(workspace, ['id', 'secret']).setSecrets).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: 'id',
      GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
    })
    expect(connectorToServerInput(CONNECTOR_CATALOG.find((t) => t.id === 'notion')!).setSecrets).toBeUndefined()
  })
})
