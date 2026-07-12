import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { OAuthTokenRow, ProvidersRepository } from '../../../src/main/db/repositories/providers'
import {
  OpenAiOAuthManager,
  base64UrlEncode,
  buildAuthorizeUrl,
  decodeJwtClaims,
  extractAccount,
  generatePkce,
  isExpired,
  type OAuthDeps,
} from '../../../src/main/providers/openai-oauth'

/** Minimal base64url JWT with the given payload (signature is irrelevant here). */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
}

/** In-memory provider_oauth store implementing only what the manager touches. */
function fakeRepo(initial?: OAuthTokenRow): ProvidersRepository {
  let row: OAuthTokenRow | null = initial ?? null
  return {
    getOAuthRow: () => row,
    setOAuthRow: (r: OAuthTokenRow) => {
      row = r
    },
    deleteOAuthRow: () => {
      row = null
    },
  } as unknown as ProvidersRepository
}

describe('openai-oauth pure helpers', () => {
  it('generates a valid PKCE pair (challenge = S256(verifier), url-safe)', () => {
    const { verifier, challenge } = generatePkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    const expected = base64UrlEncode(createHash('sha256').update(verifier).digest())
    expect(challenge).toBe(expected)
  })

  it('builds an authorize URL with PKCE + state', () => {
    const url = new URL(buildAuthorizeUrl('CHALLENGE', 'STATE123'))
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    expect(url.searchParams.get('code_challenge')).toBe('CHALLENGE')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('STATE123')
    expect(url.searchParams.get('scope')).toContain('offline_access')
  })

  it('decodes JWT claims and extracts the ChatGPT account + email', () => {
    const access = makeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_9' } })
    const id = makeJwt({ email: 'a@b.com' })
    expect(decodeJwtClaims(access)).toMatchObject({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_9' } })
    expect(extractAccount({ access_token: access, id_token: id })).toEqual({
      accountId: 'acct_9',
      label: 'a@b.com',
    })
  })

  it('decodeJwtClaims returns null for malformed input', () => {
    expect(decodeJwtClaims('not-a-jwt')).toBeNull()
  })

  it('isExpired honors the skew window', () => {
    const now = 1_000_000
    expect(isExpired(null, now)).toBe(false) // unknown expiry never forces refresh
    expect(isExpired(now + 5 * 60_000, now)).toBe(false) // far in the future
    expect(isExpired(now + 30_000, now)).toBe(true) // within the 60s skew
    expect(isExpired(now - 1, now)).toBe(true)
  })
})

describe('OpenAiOAuthManager.getAccessToken', () => {
  const deps = (repo: ProvidersRepository, extra?: Partial<OAuthDeps>) =>
    new OpenAiOAuthManager({
      repo,
      encrypt: (p) => `enc(${p})`,
      decrypt: (s) => s.replace(/^enc\(/, '').replace(/\)$/, ''),
      openExternal: async () => {},
      now: () => 1_000_000,
      ...extra,
    })

  it('returns the stored token when not near expiry (no network)', async () => {
    const fetchImpl = vi.fn()
    const mgr = deps(
      fakeRepo({
        providerId: 'p',
        encryptedAccess: 'enc(TOKEN)',
        encryptedRefresh: 'enc(REFRESH)',
        accountId: 'acct',
        accountLabel: null,
        expiresAt: 1_000_000 + 10 * 60_000,
      }),
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )
    const got = await mgr.getAccessToken('p')
    expect(got).toEqual({ accessToken: 'TOKEN', accountId: 'acct' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refreshes an expired token and persists the new one', async () => {
    const newAccess = makeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_new' } })
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: newAccess, refresh_token: 'REFRESH2', expires_in: 3600 }),
    })) as unknown as typeof fetch
    const repo = fakeRepo({
      providerId: 'p',
      encryptedAccess: 'enc(OLD)',
      encryptedRefresh: 'enc(REFRESH1)',
      accountId: 'acct_old',
      accountLabel: 'x@y.com',
      expiresAt: 1, // long expired
    })
    const mgr = deps(repo, { fetchImpl })
    const got = await mgr.getAccessToken('p')
    expect(got.accessToken).toBe(newAccess)
    // Persisted with the refreshed token + new expiry.
    const saved = repo.getOAuthRow('p')!
    expect(saved.encryptedAccess).toBe(`enc(${newAccess})`)
    expect(saved.expiresAt).toBe(1_000_000 + 3600 * 1000)
  })

  it('throws when not signed in', async () => {
    const mgr = deps(fakeRepo())
    await expect(mgr.getAccessToken('p')).rejects.toThrow(/not signed in/i)
  })

  it('throws when expired without a refresh token', async () => {
    const mgr = deps(
      fakeRepo({
        providerId: 'p',
        encryptedAccess: 'enc(OLD)',
        encryptedRefresh: null,
        accountId: null,
        accountLabel: null,
        expiresAt: 1,
      })
    )
    await expect(mgr.getAccessToken('p')).rejects.toThrow(/expired/i)
  })

  it('a logout during an in-flight refresh never resurrects the session', async () => {
    let release!: () => void
    const tokenCall = new Promise<void>((r) => {
      release = r
    })
    const fetchImpl = (async () => {
      await tokenCall // the refresh is still on the wire while the user signs out
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: makeJwt({}), refresh_token: 'REFRESH2', expires_in: 3600 }),
      }
    }) as unknown as typeof fetch
    const repo = fakeRepo({
      providerId: 'p',
      encryptedAccess: 'enc(OLD)',
      encryptedRefresh: 'enc(REFRESH1)',
      accountId: 'acct',
      accountLabel: null,
      expiresAt: 1,
    })
    const mgr = deps(repo, { fetchImpl })
    const settled = mgr.getAccessToken('p').then(
      () => null,
      (e: unknown) => e as Error
    )
    mgr.logout('p')
    release()

    const err = await settled
    expect(err?.message).toMatch(/signed out/i)
    expect(repo.getOAuthRow('p')).toBeNull()
  })

  it('forwards the caller AbortSignal to the token refresh fetch (cancels a hang)', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const s = init.signal as AbortSignal | null
          if (s?.aborted) return reject(new Error('aborted'))
          s?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
    ) as unknown as typeof fetch
    const repo = fakeRepo({
      providerId: 'p',
      encryptedAccess: 'enc(OLD)',
      encryptedRefresh: 'enc(REFRESH1)',
      accountId: 'acct',
      accountLabel: null,
      expiresAt: 1, // expired -> must refresh over the network
    })
    const mgr = deps(repo, { fetchImpl })
    const settled = mgr.getAccessToken('p', controller.signal).then(
      () => null,
      (e: unknown) => e as Error
    )
    // A Stop in the pending phase aborts the caller signal; the fetch's signal
    // fires, the hung request rejects, and the caller is unblocked.
    controller.abort()
    const err = await settled
    expect(err?.message).toMatch(/could not reach/i)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('OpenAiOAuthManager.startLogin', () => {
  it('fails fast when the system browser cannot be opened', async () => {
    const mgr = new OpenAiOAuthManager({
      repo: fakeRepo(),
      encrypt: (p) => p,
      decrypt: (s) => s,
      openExternal: async () => {
        throw new Error('no default browser')
      },
    })
    await expect(mgr.startLogin('p')).rejects.toThrow(/system browser/i)
  })
})
