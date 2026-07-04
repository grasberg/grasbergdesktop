/**
 * "Sign in with ChatGPT" OAuth (PKCE) manager — EXPERIMENTAL.
 *
 * Runs the same browser-based OAuth/PKCE flow the Codex CLI uses: open the
 * system browser to auth.openai.com, capture the redirect on a short-lived
 * loopback server (127.0.0.1:1455), exchange the code for access/refresh
 * tokens, and store them ENCRYPTED (safeStorage) via the providers repo. The
 * resulting access token authenticates the ChatGPT-backend Codex adapter and
 * bills the user's ChatGPT subscription.
 *
 * Unofficial and may break; strictly opt-in (only runs when the user clicks
 * "Sign in with ChatGPT"). Tokens are never logged and never returned to the
 * renderer — only a token-free status is exposed.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { OAuthStatus } from '@shared/types'
import type { OAuthTokenRow, ProvidersRepository } from '../db/repositories/providers'
import { ProviderError } from './errors'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const REDIRECT_PORT = 1455
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`
const SCOPE = 'openid profile email offline_access'
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** Refresh a little before the token actually expires. */
const EXPIRY_SKEW_MS = 60 * 1000

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface Pkce {
  verifier: string
  challenge: string
}

export function generatePkce(): Pkce {
  const verifier = base64UrlEncode(randomBytes(48))
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function buildAuthorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
    state,
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

/** Decode a JWT payload without verifying the signature (claims are display-only). */
export function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.')
  if (parts.length < 2) return null
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}

/** Pull the ChatGPT account id + a display label (email) from the tokens. */
export function extractAccount(tokens: TokenResponse): { accountId: string | null; label: string | null } {
  const accessClaims = decodeJwtClaims(tokens.access_token) ?? {}
  const idClaims = tokens.id_token ? decodeJwtClaims(tokens.id_token) ?? {} : {}
  const authClaim = accessClaims['https://api.openai.com/auth']
  let accountId: string | null = null
  if (authClaim && typeof authClaim === 'object') {
    const v = (authClaim as Record<string, unknown>).chatgpt_account_id
    if (typeof v === 'string') accountId = v
  }
  const email =
    (typeof idClaims.email === 'string' && idClaims.email) ||
    (typeof accessClaims.email === 'string' && accessClaims.email) ||
    null
  return { accountId, label: email }
}

/** True when the stored access token is missing or within the skew of expiry. */
export function isExpired(expiresAt: number | null, now: number): boolean {
  if (expiresAt == null) return false
  return now >= expiresAt - EXPIRY_SKEW_MS
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface OAuthDeps {
  repo: ProvidersRepository
  encrypt: (plain: string) => string
  decrypt: (stored: string) => string
  openExternal: (url: string) => Promise<void>
  fetchImpl?: typeof fetch
  now?: () => number
}

interface ActiveLogin {
  servers: Server[]
  state: string
  verifier: string
  timer: ReturnType<typeof setTimeout>
  reject: (e: Error) => void
}

export class OpenAiOAuthManager {
  private active: ActiveLogin | null = null
  /** Single-flight token refreshes keyed by providerId (tokens rotate). */
  private readonly refreshInFlight = new Map<
    string,
    Promise<{ accessToken: string; accountId: string | null }>
  >()

  constructor(private readonly deps: OAuthDeps) {}

  private get fetchImpl(): typeof fetch {
    return this.deps.fetchImpl ?? globalThis.fetch
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  status(providerId: string): OAuthStatus {
    const row = this.deps.repo.getOAuthRow(providerId)
    if (!row) return { connected: false }
    return { connected: true, accountLabel: row.accountLabel, expiresAt: row.expiresAt }
  }

  logout(providerId: string): void {
    this.deps.repo.deleteOAuthRow(providerId)
  }

  /** Cancel any in-flight login and close its loopback server(s). */
  stopAll(): void {
    if (this.active) {
      clearTimeout(this.active.timer)
      for (const s of this.active.servers) s.close()
      this.active.reject(new ProviderError('aborted', 'Sign-in cancelled.', { retryable: false }))
      this.active = null
    }
  }

  /**
   * Run the browser login and persist the tokens. Resolves with a token-free
   * status. Only one login may be in flight; a new one cancels the previous.
   */
  async startLogin(providerId: string): Promise<OAuthStatus> {
    this.stopAll()
    const { verifier, challenge } = generatePkce()
    const state = base64UrlEncode(randomBytes(24))

    const servers: Server[] = []
    let cleanup: (() => void) | undefined
    const code = await new Promise<string>((resolve, reject) => {
      const handler = (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', REDIRECT_URI)
        if (url.pathname !== '/auth/callback') {
          res.writeHead(404).end()
          return
        }
        const err = url.searchParams.get('error')
        const gotState = url.searchParams.get('state')
        const gotCode = url.searchParams.get('code')
        const finish = (ok: boolean, msg: string) => {
          res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(
            `<!doctype html><meta charset="utf-8"><title>Grasberg Desktop</title>` +
              `<body style="font-family:system-ui;background:#0f1115;color:#e6e6e6;display:grid;place-items:center;height:100vh;margin:0">` +
              `<div style="text-align:center"><h2>${ok ? 'Signed in ✓' : 'Sign-in failed'}</h2>` +
              `<p>${msg}</p><p>You can close this tab and return to Grasberg Desktop.</p></div></body>`
          )
        }
        if (err) {
          finish(false, 'Authorization was denied.')
          reject(new ProviderError('auth', 'ChatGPT sign-in was denied.', { retryable: false }))
        } else if (!gotCode || gotState !== state) {
          finish(false, 'Invalid callback.')
          reject(new ProviderError('auth', 'ChatGPT sign-in returned an invalid response.', { retryable: false }))
        } else {
          finish(true, 'Authentication complete.')
          resolve(gotCode)
        }
      }
      // Bind to loopback only — never accept a callback from another host.
      // Listen on BOTH IPv4 and IPv6 loopback: the fixed redirect_uri is
      // `localhost`, which resolves to ::1 first on IPv6-preferring hosts.
      const v4 = createServer(handler)
      v4.on('error', (e) =>
        reject(
          new ProviderError('unknown', `Could not start the local sign-in listener on port ${REDIRECT_PORT}.`, {
            retryable: false,
            cause: e,
          })
        )
      )
      v4.listen(REDIRECT_PORT, '127.0.0.1', () => {
        void this.deps.openExternal(buildAuthorizeUrl(challenge, state))
      })
      servers.push(v4)
      // IPv6 loopback is best-effort: hosts without IPv6 simply skip it.
      const v6 = createServer(handler)
      v6.on('error', () => {})
      v6.listen(REDIRECT_PORT, '::1')
      servers.push(v6)

      const timer = setTimeout(() => {
        reject(new ProviderError('aborted', 'ChatGPT sign-in timed out.', { retryable: false }))
      }, LOGIN_TIMEOUT_MS)
      const thisLogin: ActiveLogin = { servers, state, verifier, timer, reject }
      this.active = thisLogin
      // Gate cleanup on identity so an overlapping startLogin can't tear us down.
      cleanup = () => {
        if (this.active === thisLogin) this.active = null
        clearTimeout(timer)
        for (const s of servers) s.close()
      }
    }).finally(() => cleanup?.())

    const tokens = await this.exchangeCode(code, verifier)
    this.persist(providerId, tokens)
    return this.status(providerId)
  }

  /** Return a valid access token + account id, refreshing when near expiry. */
  async getAccessToken(providerId: string): Promise<{ accessToken: string; accountId: string | null }> {
    const row = this.deps.repo.getOAuthRow(providerId)
    if (!row) {
      throw new ProviderError('auth', 'Not signed in to ChatGPT — sign in from Settings → Providers.', {
        retryable: false,
      })
    }
    if (!isExpired(row.expiresAt, this.now())) {
      return { accessToken: this.deps.decrypt(row.encryptedAccess), accountId: row.accountId }
    }
    if (!row.encryptedRefresh) {
      throw new ProviderError('auth', 'ChatGPT session expired — sign in again from Settings.', {
        retryable: false,
      })
    }
    // Single-flight: refresh tokens rotate, so concurrent callers for the same
    // provider must share ONE refresh or the second invalidates the first.
    let pending = this.refreshInFlight.get(providerId)
    if (!pending) {
      pending = this.doRefresh(providerId, row).finally(() => this.refreshInFlight.delete(providerId))
      this.refreshInFlight.set(providerId, pending)
    }
    return pending
  }

  private async doRefresh(
    providerId: string,
    row: OAuthTokenRow
  ): Promise<{ accessToken: string; accountId: string | null }> {
    const refreshToken = this.deps.decrypt(row.encryptedRefresh as string)
    const tokens = await this.refresh(refreshToken)
    // A refresh may omit a new refresh token — keep the old one.
    if (!tokens.refresh_token) tokens.refresh_token = refreshToken
    this.persist(providerId, tokens, row)
    return {
      accessToken: tokens.access_token,
      accountId: this.deps.repo.getOAuthRow(providerId)?.accountId ?? row.accountId,
    }
  }

  // -- internals --------------------------------------------------------------

  private persist(providerId: string, tokens: TokenResponse, prev?: OAuthTokenRow): void {
    const { accountId, label } = extractAccount(tokens)
    const expiresAt =
      typeof tokens.expires_in === 'number' ? this.now() + tokens.expires_in * 1000 : null
    const row: OAuthTokenRow = {
      providerId,
      encryptedAccess: this.deps.encrypt(tokens.access_token),
      encryptedRefresh: tokens.refresh_token ? this.deps.encrypt(tokens.refresh_token) : prev?.encryptedRefresh ?? null,
      accountId: accountId ?? prev?.accountId ?? null,
      accountLabel: label ?? prev?.accountLabel ?? null,
      expiresAt,
    }
    this.deps.repo.setOAuthRow(row)
  }

  private async exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    })
  }

  private async refresh(refreshToken: string): Promise<TokenResponse> {
    return this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: SCOPE,
    })
  }

  private async tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
    let res: Response
    try {
      res = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
      })
    } catch (e) {
      throw new ProviderError('network', 'Could not reach the OpenAI token endpoint.', {
        retryable: true,
        cause: e,
      })
    }
    if (!res.ok) {
      throw new ProviderError('auth', `ChatGPT token exchange failed (HTTP ${res.status}).`, {
        retryable: false,
        status: res.status,
      })
    }
    const json = (await res.json()) as TokenResponse
    if (!json || typeof json.access_token !== 'string') {
      throw new ProviderError('auth', 'ChatGPT token response was missing an access token.', {
        retryable: false,
      })
    }
    return json
  }
}
