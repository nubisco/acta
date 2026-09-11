import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/app'
import { openDb, type BunSqliteDriver } from '../src/db'
import { JwksVerifier } from '../src/core/sso'

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
  // A configured provider owns sign-in. Codes are off, so the client knows
  // not to offer a door that is not there.
  it('advertises the provider, and that codes are off behind it', async () => {
    const res = await app.request('/api/v1/auth/config')
    expect(await res.json()).toEqual({ sso: true, otp: false })
  })

  /**
   * Not merely hidden in the UI. A second door beside the provider means an
   * account the provider has disabled can still sign in, and the default
   * sender prints the code to the log, so anyone who can read the logs could
   * sign in as anyone.
   */
  it('refuses one-time codes while a provider is configured', async () => {
    for (const path of ['/api/v1/auth/otp', '/api/v1/auth/verify']) {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'jose@nubisco.io', code: '123456' }),
      })
      expect(res.status).toBe(404)
    }
  })

  it('keeps codes when the instance asks for them alongside', async () => {
    const bothDb = await openDb(':memory:')
    const both = (await createApp(bothDb, {
      bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
      dataDir: `/tmp/acta-otp-${Math.random().toString(36).slice(2)}`,
      fetchImpl: idpFetch,
      otpFallback: true,
      sso: {
        issuer: ISSUER,
        appId: 'acta',
        authorizeUrl: `${ISSUER}/api/auth/sso`,
        autoProvision: true,
      },
    })) as never
    const cfg = await (both as typeof app).request('/api/v1/auth/config')
    expect(await cfg.json()).toEqual({ sso: true, otp: true })
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

  // An SSO-backed instance sets no ACTA_ADMIN_EMAIL, because identity belongs
  // to the provider. Without a rule for it, the first person to sign in to a
  // fresh install lands in a workspace with no administrator and no way to
  // ever get one.
  it('makes the first person through the door an admin when nothing seeded one', async () => {
    const bare = await openDb(':memory:')
    const noSeedApp = (await createApp(bare, {
      // No adminEmail: the shape an SSO-only deployment ships in.
      bootstrap: {},
      dataDir: `/tmp/acta-sso-test-${Math.random().toString(36).slice(2)}`,
      fetchImpl: idpFetch,
      sso: {
        issuer: ISSUER,
        appId: 'acta',
        authorizeUrl: `${ISSUER}/api/auth/sso`,
        autoProvision: true,
      },
    })) as never

    expect(
      await bare.query("SELECT id FROM actor WHERE kind = 'human'"),
    ).toHaveLength(0)

    const signIn = async (email: string) => {
      const start = await (noSeedApp as typeof app).request(
        'https://acta.test/api/v1/auth/sso/start',
      )
      const state = stateCookieOf(start)
      const token = await signToken({
        sub: email,
        email,
        iss: ISSUER,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
      })
      return (noSeedApp as typeof app).request(
        `https://acta.test/api/v1/auth/sso/callback?token=${encodeURIComponent(token)}&state=${state.value}`,
        { headers: { cookie: state.header } },
      )
    }

    const first = await signIn('first@nubisco.io')
    expect(first.status).toBe(302)
    expect(
      (
        await bare.query<{ role: string }>(
          "SELECT role FROM actor WHERE email = 'first@nubisco.io'",
        )
      )[0].role,
    ).toBe('admin')

    // And only into a vacuum. Once an admin exists the rule is inert, or it
    // would be an escalation path on any established workspace.
    await signIn('second@nubisco.io')
    expect(
      (
        await bare.query<{ role: string }>(
          "SELECT role FROM actor WHERE email = 'second@nubisco.io'",
        )
      )[0].role,
    ).toBe('member')
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

describe('welcome state', () => {
  it('reports a new member as not onboarded, and records it once', async () => {
    const start = await app.request('https://acta.test/api/v1/auth/sso/start')
    const state = stateCookieOf(start)
    const token = await signToken({
      sub: 'u9',
      email: 'ivan@nubisco.io',
      iss: ISSUER,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    })
    const cb = await app.request(
      `https://acta.test/api/v1/auth/sso/callback?token=${encodeURIComponent(token)}&state=${state.value}`,
      { headers: { cookie: state.header } },
    )
    const session = /acta_session=([^;]+)/.exec(
      cb.headers.get('set-cookie') ?? '',
    )![1]
    const cookie = { cookie: `acta_session=${session}` }

    const before = await app.request('/api/v1/auth/me', { headers: cookie })
    expect(((await before.json()) as { onboarded: boolean }).onboarded).toBe(
      false,
    )

    await app.request('/api/v1/auth/me/onboarded', {
      method: 'POST',
      headers: cookie,
    })
    const after = await app.request('/api/v1/auth/me', { headers: cookie })
    expect(((await after.json()) as { onboarded: boolean }).onboarded).toBe(
      true,
    )

    // Idempotent, and it keeps the first moment rather than moving it, so a
    // stray second call cannot rewrite when someone joined.
    const first = (
      await db.query<{ onboarded_at: number }>(
        "SELECT onboarded_at FROM actor WHERE email = 'ivan@nubisco.io'",
      )
    )[0].onboarded_at
    await app.request('/api/v1/auth/me/onboarded', {
      method: 'POST',
      headers: cookie,
    })
    expect(
      (
        await db.query<{ onboarded_at: number }>(
          "SELECT onboarded_at FROM actor WHERE email = 'ivan@nubisco.io'",
        )
      )[0].onboarded_at,
    ).toBe(first)
  })
})

describe('JwksVerifier fetch binding', () => {
  // workerd's global fetch throws "Illegal invocation" unless `this` is the
  // global scope, and the verifier holds fetch on the instance. Calling it as
  // `this.fetchImpl(...)` therefore broke every SSO login in production while
  // this suite stayed green, because bun and Node's fetch ignore `this`. No
  // amount of mocking reproduces that, so the test asserts the invariant the
  // runtime cares about: whatever fetch we end up with is never invoked with
  // the verifier as its receiver.
  it('never calls fetch with the verifier as `this`', async () => {
    const seen: unknown[] = []
    const verifier = new JwksVerifier(ISSUER, {
      fetchImpl: function (this: unknown) {
        seen.push(this)
        return Promise.resolve(
          new Response(JSON.stringify(jwks), {
            headers: { 'content-type': 'application/json' },
          }),
        )
      } as unknown as typeof fetch,
    })

    const token = await signToken({
      sub: 'u1',
      email: 'someone@example.com',
      iss: ISSUER,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    })
    await verifier.verify(token)

    expect(seen.length).toBeGreaterThan(0)
    for (const receiver of seen) expect(receiver).not.toBe(verifier)
  })
})
