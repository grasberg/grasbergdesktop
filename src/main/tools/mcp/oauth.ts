/**
 * OAuth 2.1 for remote MCP connectors (v53) — what Notion, Linear, Atlassian,
 * Asana, Canva, PayPal and most hosted connectors require. Implements the
 * MCP SDK's OAuthClientProvider:
 *
 * - dynamic client registration, PKCE and token refresh are the SDK's; this
 *   module only persists their state — client registration and tokens —
 *   encrypted in tool_secrets (scope 'mcp_oauth', owner = the server id);
 *   the PKCE verifier stays in memory on the sign-in's own provider. Nothing
 *   of it ever reaches the renderer or a model.
 * - a background (re)connect is NON-interactive: an expired or missing grant
 *   only marks the server "sign-in needed". Opening the browser happens when
 *   the user clicks Sign in (McpOAuthService.authorize).
 * - the redirect lands on a one-shot loopback listener (127.0.0.1, fixed
 *   port, 5-minute window, state-checked) that exists only while a sign-in
 *   is in progress — the app's permanent inbound surface stays the trigger
 *   server.
 */

import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { AppDatabase } from '../../db/database'

export const OAUTH_CALLBACK_PORT = 33418
export const OAUTH_REDIRECT_URL = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}/callback`
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

export interface OAuthKeystore {
  encryptKey(plain: string): { encryptedBase64: string; preview: string }
  decryptKey(stored: string): string
}

type StoredName = 'tokens' | 'client' | 'verifier'

/** Encrypted per-server OAuth state. */
export class McpOAuthStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly keystore: OAuthKeystore
  ) {}

  read<T>(serverId: string, name: StoredName): T | undefined {
    const cipher = this.db.secrets.getCipher('mcp_oauth', serverId, name)
    if (!cipher) return undefined
    try {
      const value = JSON.parse(this.keystore.decryptKey(cipher.encryptedValue)) as T | null
      return value === null ? undefined : value
    } catch {
      return undefined
    }
  }

  write(serverId: string, name: StoredName, value: unknown): void {
    const encrypted = this.keystore.encryptKey(JSON.stringify(value))
    this.db.secrets.set('mcp_oauth', serverId, name, encrypted.encryptedBase64, '••••')
  }

  hasTokens(serverId: string): boolean {
    return this.db.secrets.has('mcp_oauth', serverId, 'tokens')
  }

  clear(serverId: string): void {
    this.db.secrets.deleteAllFor('mcp_oauth', serverId)
  }
}

export class McpOAuthProvider implements OAuthClientProvider {
  private stateValue = randomBytes(16).toString('hex')
  /**
   * The PKCE verifier lives on THIS provider only: the sign-in that created
   * it finishes on the same instance, and a background reconnect (its own
   * provider) can never overwrite it mid-sign-in.
   */
  private verifier: string | null = null

  constructor(
    private readonly serverId: string,
    private readonly store: McpOAuthStore,
    /** Interactive = a user-started sign-in: open the browser. Else just flag it. */
    private readonly onAuthorizationUrl: (url: URL) => void
  ) {}

  get redirectUrl(): string {
    return OAUTH_REDIRECT_URL
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Grasberg',
      redirect_uris: [OAUTH_REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  state(): string {
    return this.stateValue
  }

  /** The state this sign-in expects back on the redirect. */
  expectedState(): string {
    return this.stateValue
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.store.read<OAuthClientInformationMixed>(this.serverId, 'client')
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.store.write(this.serverId, 'client', info)
  }

  tokens(): OAuthTokens | undefined {
    return this.store.read<OAuthTokens>(this.serverId, 'tokens')
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.write(this.serverId, 'tokens', tokens)
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.onAuthorizationUrl(authorizationUrl)
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('No PKCE verifier saved for this sign-in.')
    return this.verifier
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'verifier') this.verifier = null
    if (scope === 'all') this.store.clear(this.serverId)
    else if (scope === 'tokens' || scope === 'client') {
      this.store.write(this.serverId, scope, null)
    }
  }
}

/**
 * Waits for exactly one OAuth redirect on the loopback port. Resolves with
 * the authorization code; rejects on an error redirect, a busy port or the
 * timeout. Requests carrying another state are ignored (the listener keeps
 * waiting). Always closes the listener.
 */
export function awaitOAuthCallback(
  expectedState: string,
  opts: { port?: number; timeoutMs?: number; signal?: AbortSignal } = {}
): { ready: Promise<void>; code: Promise<string> } {
  let server: Server | null = null
  let readyResolve: () => void = () => undefined
  let readyReject: (e: Error) => void = () => undefined
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const code = new Promise<string>((resolve, reject) => {
    const finish = (error: Error | null, value?: string): void => {
      clearTimeout(timer)
      server?.close()
      server = null
      if (error) reject(error)
      else resolve(value as string)
    }
    const timer = setTimeout(() => finish(new Error('Sign-in timed out — try again.')), opts.timeoutMs ?? SIGN_IN_TIMEOUT_MS)
    opts.signal?.addEventListener('abort', () => finish(new Error('Sign-in cancelled.')), { once: true })
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', OAUTH_REDIRECT_URL)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const page = (title: string, body: string): void => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
            `<body style="font-family:system-ui;padding:3rem;text-align:center"><h2>${title}</h2><p>${body}</p></body>`
        )
      }
      // Anything without this sign-in's state is ignored and the listener
      // keeps waiting: another local page hitting /callback must not be able
      // to cancel (or answer) the user's sign-in.
      if (url.searchParams.get('state') !== expectedState) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('This response does not belong to the sign-in in progress.')
        return
      }
      const error = url.searchParams.get('error')
      if (error) {
        page('Sign-in failed', 'You can close this tab and try again in Grasberg.')
        finish(new Error(`The service refused the sign-in (${error}).`))
        return
      }
      const value = url.searchParams.get('code')
      if (!value) {
        page('Sign-in failed', 'No authorization code was returned.')
        finish(new Error('No authorization code was returned.'))
        return
      }
      page('Connected ✓', 'You can close this tab and return to Grasberg.')
      finish(null, value)
    })
    server.once('error', (e: NodeJS.ErrnoException) => {
      const error = new Error(
        e.code === 'EADDRINUSE'
          ? `Port ${opts.port ?? OAUTH_CALLBACK_PORT} is busy — close the other sign-in and try again.`
          : e.message
      )
      readyReject(error)
      finish(error)
    })
    server.listen(opts.port ?? OAUTH_CALLBACK_PORT, '127.0.0.1', () => readyResolve())
  })
  // A rejection the caller has not awaited yet must not surface as an
  // unhandled rejection; awaiting `code` still rejects normally.
  ready.catch(() => undefined)
  code.catch(() => undefined)
  return { ready, code }
}
