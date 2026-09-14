/**
 * Standard OpenID Connect, against a provider that behaves like a real one.
 *
 * The reason this exists at all: Acta's original "vendor-neutral SSO" took a
 * signed JWT straight off the callback query, and nothing off the shelf does
 * that. Keycloak, Auth0, Okta, Entra and Google all return ?code= and expect
 * an exchange, so every self-hosted adopter was stuck on email codes.
 *
 * What is worth testing is not the happy path (that is one round trip) but
 * the four checks that make the exchange safe, because each one fails open if
 * it is missing and none of them is visible in ordinary use: PKCE binding,
 * state, audience and nonce.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/app'
import { openDb, type BunSqliteDriver } from '../src/db'

const ISSUER = 'https://oidc.test'
const CLIENT_ID = 'acta-test'

let keyPair: CryptoKeyPair
let jwks: { keys: unknown[] }

function b64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function signIdToken(claims: Record<string, unknown>): Promise<string> {
  const header = { alg: 'RS256', kid: 'oidc-key' }
  const enc = (o: unknown) =>
    b64url(new TextEncoder().encode(JSON.stringify(o)))
  const input = `${enc(header)}.${enc(claims)}`
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(input),
  )
  return `${input}.${b64url(new Uint8Array(sig))}`
}

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey(
    'jwk',
    keyPair.publicKey,
  )) as Record<string, unknown>
  jwks = { keys: [{ ...jwk, kid: 'oidc-key', alg: 'RS256', use: 'sig' }] }
})

/** What the fake provider was asked for, so the test can assert on it. */
interface ITokenRequest {
  code: string
  code_verifier: string
  redirect_uri: string
  authorization: string | null
}

let db: BunSqliteDriver
let app: Hono<never>
let lastTokenRequest: ITokenRequest | null
/** Claims the provider will mint next, so a test can bend one field. */
let nextClaims: Record<string, unknown>
/** Set when the provider should refuse the exchange. */
let tokenError: { status: number; body: unknown } | null

// The provider: discovery, JWKS and a token endpoint. Deliberately serves its
// keys from a non-conventional path, because that is the case the old
// verifier could not express and several real providers use.
const JWKS_PATH = `${ISSUER}/oauth2/v3/certs`

const providerFetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const url = String(input)
  const jsonRes = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return jsonRes({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: JWKS_PATH,
    })
  }
  if (url === JWKS_PATH) return jsonRes(jwks)
  if (url === `${ISSUER}/token`) {
    if (tokenError) return jsonRes(tokenError.body, tokenError.status)
    const form = new URLSearchParams(String(init?.body ?? ''))
    lastTokenRequest = {
      code: form.get('code') ?? '',
      code_verifier: form.get('code_verifier') ?? '',
      redirect_uri: form.get('redirect_uri') ?? '',
      authorization:
        new Headers(init?.headers as Record<string, string>).get(
          'authorization',
        ) ?? null,
    }
    return jsonRes({ id_token: await signIdToken(nextClaims) })
  }
  return new Response('ok')
}) as typeof fetch

const OIDC = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: 'sh/h+t=',
  scopes: ['openid', 'email', 'profile'],
  autoProvision: true,
  label: 'Test OIDC',
}

beforeEach(async () => {
  db = await openDb(':memory:')
  lastTokenRequest = null
  tokenError = null
  nextClaims = {
    sub: 'oidc-user-1',
    email: 'dana@example.test',
    name: 'Dana',
    iss: ISSUER,
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000),
  }
  app = (await createApp(db, {
    bootstrap: { workspaceName: 'Test' },
    dataDir: `/tmp/acta-oidc-${Math.random().toString(36).slice(2)}`,
    fetchImpl: providerFetch,
    oidc: OIDC,
  })) as unknown as Hono<never>
})

const cookiesOf = (res: Response): string[] => res.headers.getSetCookie()

/** Run the authorize leg and return what the browser would carry forward. */
async function startSignIn(): Promise<{
  authorizeUrl: URL
  handshakeCookie: string
}> {
  const res = await app.request('https://acta.test/api/v1/auth/sso/start')
  expect(res.status).toBe(302)
  const cookie = cookiesOf(res).find((c) =>
    c.startsWith('acta_oidc_handshake='),
  )
  return {
    authorizeUrl: new URL(res.headers.get('location') ?? ''),
    handshakeCookie: (cookie ?? '').split(';')[0],
  }
}

const callback = (query: string, cookie: string) =>
  app.request(`https://acta.test/api/v1/auth/sso/callback?${query}`, {
    headers: { cookie },
  })

describe('openid connect', () => {
  it('sends the browser to the provider with PKCE and a nonce', async () => {
    const { authorizeUrl } = await startSignIn()
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      `${ISSUER}/authorize`,
    )
    const q = authorizeUrl.searchParams
    expect(q.get('response_type')).toBe('code')
    expect(q.get('client_id')).toBe(CLIENT_ID)
    expect(q.get('scope')).toBe('openid email profile')
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('code_challenge')).toBeTruthy()
    // The challenge is the hash, never the verifier: sending the verifier
    // through the browser would defeat the whole exercise.
    expect(q.get('code_challenge')).not.toBe(q.get('state'))
    expect(q.get('nonce')).toBeTruthy()
    expect(q.get('redirect_uri')).toBe(
      'https://acta.test/api/v1/auth/sso/callback',
    )
  })

  it('exchanges the code and signs the person in', async () => {
    const { authorizeUrl, handshakeCookie } = await startSignIn()
    nextClaims.nonce = authorizeUrl.searchParams.get('nonce')
    const res = await callback(
      `code=abc123&state=${authorizeUrl.searchParams.get('state')}`,
      handshakeCookie,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    expect(cookiesOf(res).some((c) => c.startsWith('acta_session='))).toBe(true)

    expect(lastTokenRequest?.code).toBe('abc123')
    expect(lastTokenRequest?.code_verifier).toBeTruthy()
    expect(lastTokenRequest?.redirect_uri).toBe(
      'https://acta.test/api/v1/auth/sso/callback',
    )
    // client_secret_basic, with both halves form-encoded before base64 so a
    // secret containing + / or = survives the trip. This one contains all three.
    const basic = atob(
      (lastTokenRequest?.authorization ?? '').slice('Basic '.length),
    )
    expect(basic).toBe(
      `${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent('sh/h+t=')}`,
    )
  })

  it('provisions the first person in as the admin', async () => {
    const { authorizeUrl, handshakeCookie } = await startSignIn()
    nextClaims.nonce = authorizeUrl.searchParams.get('nonce')
    await callback(
      `code=abc&state=${authorizeUrl.searchParams.get('state')}`,
      handshakeCookie,
    )
    const rows = await db.query<{ role: string; email: string }>(
      "SELECT role, email FROM actor WHERE kind = 'human'",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ email: 'dana@example.test', role: 'admin' })
  })

  // Each of the next four is a check that fails open when absent.

  it('refuses a state that did not come from this browser', async () => {
    const { handshakeCookie } = await startSignIn()
    const res = await callback('code=abc&state=not-the-one', handshakeCookie)
    expect(res.headers.get('location')).toBe('/login?error=sso_state')
    expect(lastTokenRequest).toBeNull()
  })

  it('refuses a callback with no handshake cookie at all', async () => {
    const { authorizeUrl } = await startSignIn()
    const res = await callback(
      `code=abc&state=${authorizeUrl.searchParams.get('state')}`,
      '',
    )
    expect(res.headers.get('location')).toBe('/login?error=sso_state')
    expect(lastTokenRequest).toBeNull()
  })

  it('refuses an id_token minted for a different client', async () => {
    const { authorizeUrl, handshakeCookie } = await startSignIn()
    nextClaims.nonce = authorizeUrl.searchParams.get('nonce')
    nextClaims.aud = 'some-other-app'
    const res = await callback(
      `code=abc&state=${authorizeUrl.searchParams.get('state')}`,
      handshakeCookie,
    )
    expect(res.headers.get('location')).toBe('/login?error=sso_token')
    expect(cookiesOf(res).some((c) => c.startsWith('acta_session='))).toBe(
      false,
    )
  })

  it('refuses an id_token replayed from an earlier sign-in', async () => {
    const { authorizeUrl, handshakeCookie } = await startSignIn()
    nextClaims.nonce = 'a-nonce-from-some-other-attempt'
    const res = await callback(
      `code=abc&state=${authorizeUrl.searchParams.get('state')}`,
      handshakeCookie,
    )
    expect(res.headers.get('location')).toBe('/login?error=sso_token')
  })

  it('surfaces a refused exchange as a failed sign-in, not a crash', async () => {
    const { authorizeUrl, handshakeCookie } = await startSignIn()
    tokenError = { status: 400, body: { error: 'invalid_grant' } }
    const res = await callback(
      `code=stale&state=${authorizeUrl.searchParams.get('state')}`,
      handshakeCookie,
    )
    expect(res.headers.get('location')).toBe('/login?error=sso_token')
  })

  it('reads the key location from discovery rather than assuming it', async () => {
    // The provider serves keys from /oauth2/v3/certs. The old verifier always
    // looked at ${issuer}/.well-known/jwks.json, so this sign-in could not
    // have worked at all.
    const { authorizeUrl, handshakeCookie } = await startSignIn()
    nextClaims.nonce = authorizeUrl.searchParams.get('nonce')
    const res = await callback(
      `code=abc&state=${authorizeUrl.searchParams.get('state')}`,
      handshakeCookie,
    )
    expect(cookiesOf(res).some((c) => c.startsWith('acta_session='))).toBe(true)
  })

  it('turns off one-time codes, and says which provider it uses', async () => {
    const res = await app.request('https://acta.test/api/v1/auth/config')
    expect(await res.json()).toEqual({
      sso: true,
      otp: false,
      sso_label: 'Test OIDC',
    })
  })
})
