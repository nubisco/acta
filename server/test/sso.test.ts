import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/app'
import { openDb, type BunSqliteDriver } from '../src/db'

const ISSUER = 'https://idp.test'

let keyPair: CryptoKeyPair
let jwks: { keys: unknown[] }

function b64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function signToken(claims: Record<string, unknown>): Promise<string> {
  const header = { alg: 'RS256', kid: 'test-key' }
  const enc = (obj: unknown) =>
    b64url(new TextEncoder().encode(JSON.stringify(obj)))
  const signingInput = `${enc(header)}.${enc(claims)}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${b64url(new Uint8Array(signature))}`
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
  jwks = {
    keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }],
  }
})

let db: BunSqliteDriver
let app: Hono<never>

const idpFetch = (async (input: Parameters<typeof fetch>[0]) => {
  if (String(input).startsWith(`${ISSUER}/.well-known/jwks.json`)) {
    return new Response(JSON.stringify(jwks), {
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response('ok', { status: 200 })
}) as typeof fetch

beforeEach(async () => {
  db = await openDb(':memory:')
  app = (await createApp(db, {
    bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
    dataDir: `/tmp/acta-sso-test-${Math.random().toString(36).slice(2)}`,
    fetchImpl: idpFetch,
    sso: {
      issuer: ISSUER,
      appId: 'acta',
      authorizeUrl: `${ISSUER}/api/auth/sso`,
      autoProvision: true,
    },
  })) as never
})

function stateCookieOf(res: Response): { value: string; header: string } {
  const header = res.headers.get('set-cookie') ?? ''
  const match = /acta_sso_state=([^;]+)/.exec(header)
  return { value: match?.[1] ?? '', header: `acta_sso_state=${match?.[1]}` }
}

describe('external sso', () => {
  it('advertises configuration', async () => {
    const res = await app.request('/api/v1/auth/config')
    expect(await res.json()).toEqual({ sso: true, otp: true })
  })

  it('redirects to the idp with app_id, redirect_uri and state', async () => {
    const res = await app.request('https://acta.test/api/v1/auth/sso/start')
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!)
    expect(location.origin + location.pathname).toBe(`${ISSUER}/api/auth/sso`)
    expect(location.searchParams.get('app_id')).toBe('acta')
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://acta.test/api/v1/auth/sso/callback',
    )
    expect(location.searchParams.get('state')).toBe(stateCookieOf(res).value)
  })

  it('signs in an existing member and scopes the session by role', async () => {
    const start = await app.request('https://acta.test/api/v1/auth/sso/start')
    const state = stateCookieOf(start)
    const token = await signToken({
      sub: 'u1',
      email: 'jose@nubisco.io',
      name: 'José Silva',
      role: 'admin',
      iss: ISSUER,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    })
    const cb = await app.request(
      `https://acta.test/api/v1/auth/sso/callback?token=${encodeURIComponent(token)}&state=${state.value}`,
      { headers: { cookie: state.header } },
    )
    expect(cb.status).toBe(302)
    expect(cb.headers.get('location')).toBe('/')
    const session = /acta_session=([^;]+)/.exec(
      cb.headers.get('set-cookie') ?? '',
    )![1]
    const me = await app.request('/api/v1/auth/me', {
      headers: { cookie: `acta_session=${session}` },
    })
    const body = (await me.json()) as { handle: string; scopes: string[] }
    expect(body.handle).toBe('jose')
    expect(body.scopes).toContain('admin')
  })

  it('provisions a first-time member with member scopes and audit trail', async () => {
    const start = await app.request('https://acta.test/api/v1/auth/sso/start')
    const state = stateCookieOf(start)
    const token = await signToken({
      sub: 'u2',
      email: 'daniela@nubisco.io',
      name: 'Daniela Pinho',
      iss: ISSUER,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    })
    const cb = await app.request(
      `https://acta.test/api/v1/auth/sso/callback?token=${encodeURIComponent(token)}&state=${state.value}`,
      { headers: { cookie: state.header } },
    )
    expect(cb.status).toBe(302)
    const actor = (
      await db.query<{ handle: string; role: string; kind: string }>(
        "SELECT handle, role, kind FROM actor WHERE email = 'daniela@nubisco.io'",
      )
    )[0]
    expect(actor).toEqual({ handle: 'daniela', role: 'member', kind: 'human' })
    const event = await db.query<{ verb: string }>(
      "SELECT verb FROM event WHERE verb = 'member.provisioned'",
    )
    expect(event).toHaveLength(1)
    const session = /acta_session=([^;]+)/.exec(
      cb.headers.get('set-cookie') ?? '',
    )![1]
    const me = await app.request('/api/v1/auth/me', {
      headers: { cookie: `acta_session=${session}` },
    })
    expect(((await me.json()) as { scopes: string[] }).scopes).not.toContain(
      'admin',
    )
  })

  it('rejects state mismatch, bad issuer, and expired tokens', async () => {
    const start = await app.request('https://acta.test/api/v1/auth/sso/start')
    const state = stateCookieOf(start)

    const good = {
      sub: 'u1',
      email: 'jose@nubisco.io',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    }
    const wrongIssuer = await signToken({ ...good, iss: 'https://evil.test' })
    const cb1 = await app.request(
      `https://acta.test/api/v1/auth/sso/callback?token=${encodeURIComponent(wrongIssuer)}&state=${state.value}`,
      { headers: { cookie: state.header } },
    )
    expect(cb1.headers.get('location')).toContain('error=sso_token')

    const expired = await signToken({
      ...good,
      iss: ISSUER,
      exp: Math.floor(Date.now() / 1000) - 10,
    })
    const start2 = await app.request('https://acta.test/api/v1/auth/sso/start')
    const state2 = stateCookieOf(start2)
    const cb2 = await app.request(
      `https://acta.test/api/v1/auth/sso/callback?token=${encodeURIComponent(expired)}&state=${state2.value}`,
      { headers: { cookie: state2.header } },
    )
    expect(cb2.headers.get('location')).toContain('error=sso_token')

    const valid = await signToken({ ...good, iss: ISSUER })
    const cb3 = await app.request(
      `https://acta.test/api/v1/auth/sso/callback?token=${encodeURIComponent(valid)}&state=forged`,
      { headers: { cookie: state.header } },
    )
    expect(cb3.headers.get('location')).toContain('error=sso_state')

    // No session cookie was ever set on the failures.
    for (const res of [cb1, cb2, cb3]) {
      expect(res.headers.get('set-cookie') ?? '').not.toContain('acta_session=')
    }
  })

  it('relays idp errors like not_a_member', async () => {
    const cb = await app.request(
      'https://acta.test/api/v1/auth/sso/callback?error=not_a_member',
    )
    expect(cb.headers.get('location')).toBe('/login?error=not_a_member')
  })
})
