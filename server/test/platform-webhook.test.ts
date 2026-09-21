/**
 * Membership and avatar changes pushed by the identity provider.
 *
 * Signatures here are computed with WebCrypto directly rather than through the
 * route's own helper, so a bug in that helper cannot make these tests agree
 * with it. Sign-in goes through the real callback with a real RS256 token and
 * a real JWKS, because platform_user_id is only ever bound on that path, and
 * every webhook below finds its person by it.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/app'
import { openDb, type BunSqliteDriver } from '../src/db'
import { acceptedPicture, isNubiscoPlatform } from '../src/core/avatar'

const ISSUER = 'https://platform.nubisco.io'
const SECRET = 'whsec_test_only_not_a_real_secret'
const AVATAR = `${ISSUER}/api/avatars/3f9c0a1e5b7d4c2a8e6f1b0d9c3a7e52`

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

/** The HMAC the platform sends, computed independently of the route. */
async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  )
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
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
  jwks = { keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] }
})

const idpFetch = (async (input: Parameters<typeof fetch>[0]) => {
  if (String(input).startsWith(`${ISSUER}/.well-known/jwks.json`)) {
    return new Response(JSON.stringify(jwks), {
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response('ok', { status: 200 })
}) as typeof fetch

let db: BunSqliteDriver
let app: Hono<never>

async function makeApp(
  opts: { webhookSecret?: string } = { webhookSecret: SECRET },
): Promise<Hono<never>> {
  return (await createApp(db, {
    bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
    dataDir: `/tmp/acta-pwh-${Math.random().toString(36).slice(2)}`,
    fetchImpl: idpFetch,
    platformWebhookSecret: opts.webhookSecret,
    sso: {
      issuer: ISSUER,
      appId: 'acta',
      authorizeUrl: `${ISSUER}/api/auth/sso`,
      autoProvision: true,
      label: 'Nubisco Platform',
    },
  })) as never
}

beforeEach(async () => {
  db = await openDb(':memory:')
  app = await makeApp()
})

/** Drive the real SSO callback, which is what binds platform_user_id. */
async function signIn(claims: {
  sub: string
  email: string
  name?: string
  picture?: string
}): Promise<void> {
  const start = await app.request('https://acta.test/api/v1/auth/sso/start')
  const cookie = /acta_sso_state=([^;]+)/.exec(
    start.headers.get('set-cookie') ?? '',
  )![1]
  const token = await signToken({
    iss: ISSUER,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  })
  const res = await app.request(
    `https://acta.test/api/v1/auth/sso/callback?token=${token}&state=${cookie}`,
    { headers: { cookie: `acta_sso_state=${cookie}` } },
  )
  expect(res.headers.get('location')).not.toContain('error=')
}

async function deliver(
  body: string,
  opts: { signature?: string } = {},
): Promise<Response> {
  return app.request('https://acta.test/api/v1/platform/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-nubisco-signature': opts.signature ?? `sha256=${await sign(body)}`,
    },
    body,
  })
}

function payload(event: string, data: unknown, timestamp?: string): string {
  return JSON.stringify({
    event,
    timestamp: timestamp ?? new Date().toISOString(),
    data,
  })
}

async function actorOf(sub: string) {
  return (
    await db.query<{
      id: string
      avatar_url: string | null
      disabled: number
      disabled_source: string | null
    }>(
      'SELECT id, avatar_url, disabled, disabled_source FROM actor WHERE platform_user_id = ?',
      [sub],
    )
  )[0]
}

describe('accepted avatar URLs', () => {
  /**
   * The value becomes an <img src> on every page, so it is checked rather
   * than trusted. A signed token is not a promise that the URL inside it is
   * one we should point every browser at.
   */
  it('keeps only an address on the issuer under /api/avatars/', () => {
    expect(acceptedPicture(AVATAR, ISSUER)).toBe(AVATAR)
  })

  it('refuses a foreign host, a wrong path, credentials and empties', () => {
    expect(
      acceptedPicture('https://evil.test/api/avatars/x', ISSUER),
    ).toBeNull()
    // The suffix trap: a substring test on the host would accept this.
    expect(
      acceptedPicture(
        'https://platform.nubisco.io.evil.test/api/avatars/x',
        ISSUER,
      ),
    ).toBeNull()
    expect(acceptedPicture(`${ISSUER}/api/not-avatars/x`, ISSUER)).toBeNull()
    expect(
      acceptedPicture(
        'https://user:pw@platform.nubisco.io/api/avatars/x',
        ISSUER,
      ),
    ).toBeNull()
    expect(acceptedPicture('', ISSUER)).toBeNull()
    expect(acceptedPicture(null, ISSUER)).toBeNull()
    expect(acceptedPicture(undefined, ISSUER)).toBeNull()
    expect(acceptedPicture(AVATAR, undefined)).toBeNull()
  })

  it('recognises the platform by hostname, never by substring', () => {
    expect(isNubiscoPlatform('https://platform.nubisco.io')).toBe(true)
    expect(isNubiscoPlatform('https://nubisco.io')).toBe(true)
    expect(isNubiscoPlatform('https://platform.nubisco.io.evil.test')).toBe(
      false,
    )
    expect(isNubiscoPlatform('https://evilnubisco.io')).toBe(false)
    expect(isNubiscoPlatform(undefined)).toBe(false)
  })
})

describe('the picture claim at sign-in', () => {
  it('stores it, and clears it when the claim goes away', async () => {
    await signIn({ sub: 'u-1', email: 'ana@nubisco.io', picture: AVATAR })
    expect((await actorOf('u-1')).avatar_url).toBe(AVATAR)

    // An absent claim means no avatar. The platform omits `picture` for
    // someone who has none, and never sends null or an empty string, so
    // "keep the old one" would leave a dead URL on the page for good.
    await signIn({ sub: 'u-1', email: 'ana@nubisco.io' })
    expect((await actorOf('u-1')).avatar_url).toBeNull()
  })

  it('refuses a picture claim pointing somewhere else', async () => {
    await signIn({
      sub: 'u-2',
      email: 'bo@nubisco.io',
      picture: 'https://evil.test/api/avatars/x',
    })
    expect((await actorOf('u-2')).avatar_url).toBeNull()
  })

  it('binds the provider id, so a webhook can find the person', async () => {
    await signIn({ sub: 'u-3', email: 'cy@nubisco.io' })
    expect((await actorOf('u-3')).id).toBeTruthy()
  })
})

describe('the webhook signature', () => {
  it('accepts a real signature over the exact bytes', async () => {
    await signIn({ sub: 'u-1', email: 'ana@nubisco.io' })
    const res = await deliver(
      payload('user.updated', { user_id: 'u-1', picture: AVATAR }),
    )
    expect(res.status).toBe(200)
    expect((await actorOf('u-1')).avatar_url).toBe(AVATAR)
  })

  /**
   * The signature covers the bytes the platform sent. Verifying against a
   * re-serialised body would reorder or reformat them and fail every real
   * delivery, so this changes the body after signing and expects a refusal.
   */
  it('refuses a tampered body carrying a valid signature', async () => {
    await signIn({ sub: 'u-1', email: 'ana@nubisco.io' })
    const body = payload('user.updated', { user_id: 'u-1', picture: AVATAR })
    const signature = `sha256=${await sign(body)}`
    const tampered = body.replace('"user.updated"', '"user.updated "')
    const res = await deliver(tampered, { signature })
    expect(res.status).toBe(401)
    expect((await actorOf('u-1')).avatar_url).toBeNull()
  })

  it('refuses a wrong secret, and a malformed header without throwing', async () => {
    const body = payload('user.updated', { user_id: 'u-1' })
    expect(
      (await deliver(body, { signature: `sha256=${await sign(body, 'nope')}` }))
        .status,
    ).toBe(401)
    for (const signature of [
      '',
      'nonsense',
      'sha256=',
      'sha256=zz',
      'sha1=abc',
    ]) {
      expect((await deliver(body, { signature })).status).toBe(401)
    }
  })

  it('refuses a delivery older than the replay window', async () => {
    await signIn({ sub: 'u-1', email: 'ana@nubisco.io' })
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const res = await deliver(
      payload('user.updated', { user_id: 'u-1', picture: AVATAR }, old),
    )
    expect(res.status).toBe(401)
    expect((await actorOf('u-1')).avatar_url).toBeNull()
  })

  /**
   * An endpoint that accepts nothing should not advertise itself. Without a
   * secret configured there is no way to tell a real delivery from anyone's,
   * so the route behaves as if it were not mounted.
   */
  it('answers 404 when no secret is configured', async () => {
    db = await openDb(':memory:')
    app = await makeApp({ webhookSecret: undefined })
    const body = payload('user.updated', { user_id: 'u-1' })
    expect((await deliver(body)).status).toBe(404)
  })
})

describe('user.updated', () => {
  it('clears the avatar when picture is null', async () => {
    await signIn({ sub: 'u-1', email: 'ana@nubisco.io', picture: AVATAR })
    const res = await deliver(
      payload('user.updated', { user_id: 'u-1', picture: null }),
    )
    expect(res.status).toBe(200)
    expect((await actorOf('u-1')).avatar_url).toBeNull()
  })

  /**
   * A later version may send user.updated about some other field. An absent
   * key is not "no avatar", so nothing is touched.
   */
  it('leaves the avatar alone when picture is absent', async () => {
    await signIn({ sub: 'u-1', email: 'ana@nubisco.io', picture: AVATAR })
    const res = await deliver(payload('user.updated', { user_id: 'u-1' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, handled: false })
    expect((await actorOf('u-1')).avatar_url).toBe(AVATAR)
  })

  it('refuses a picture pointing somewhere other than the issuer', async () => {
    await signIn({ sub: 'u-1', email: 'ana@nubisco.io', picture: AVATAR })
    await deliver(
      payload('user.updated', {
        user_id: 'u-1',
        picture: 'https://evil.test/api/avatars/x',
      }),
    )
    expect((await actorOf('u-1')).avatar_url).toBeNull()
  })

  it('acknowledges an event about someone who has never signed in', async () => {
    const res = await deliver(
      payload('user.updated', { user_id: 'nobody', picture: AVATAR }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, handled: false })
  })
})

describe('membership', () => {
  it('disables the person and revokes their credentials on removal', async () => {
    await signIn({ sub: 'u-9', email: 'dee@nubisco.io' })
    const actor = await actorOf('u-9')
    const before = await db.query(
      'SELECT id FROM auth_token WHERE actor_id = ? AND revoked_at IS NULL',
      [actor.id],
    )
    expect(before.length).toBeGreaterThan(0)

    const res = await deliver(payload('membership.removed', { user_id: 'u-9' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, handled: true })

    const after = await actorOf('u-9')
    expect(after.disabled).toBe(1)
    expect(after.disabled_source).toBe('platform')
    const live = await db.query(
      'SELECT id FROM auth_token WHERE actor_id = ? AND revoked_at IS NULL',
      [actor.id],
    )
    expect(live.length).toBe(0)
  })

  it('re-enables only what the platform itself disabled', async () => {
    await signIn({ sub: 'u-9', email: 'dee@nubisco.io' })
    await deliver(payload('membership.removed', { user_id: 'u-9' }))
    const res = await deliver(payload('membership.added', { user_id: 'u-9' }))
    expect(await res.json()).toEqual({ ok: true, handled: true })
    const after = await actorOf('u-9')
    expect(after.disabled).toBe(0)
    expect(after.disabled_source).toBeNull()
  })

  /**
   * Someone an admin disabled here is not the platform's to re-enable. The
   * platform is the authority on membership, not on a local suspension.
   */
  it('leaves an admin-disabled person disabled', async () => {
    await signIn({ sub: 'u-9', email: 'dee@nubisco.io' })
    const actor = await actorOf('u-9')
    await db.run('UPDATE actor SET disabled = 1 WHERE id = ?', [actor.id])

    const res = await deliver(payload('membership.added', { user_id: 'u-9' }))
    expect(await res.json()).toEqual({ ok: true, handled: false })
    expect((await actorOf('u-9')).disabled).toBe(1)
  })

  it('acknowledges a removal for someone it has never seen', async () => {
    const res = await deliver(
      payload('membership.removed', { user_id: 'ghost' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, handled: false })
  })
})

/**
 * A provider disables a hook that keeps erroring, so an event we do not act on
 * must still be answered 200. subscription.changed exists today, and more will
 * be added without asking us first.
 */
describe('unknown events', () => {
  it('acknowledges them rather than failing the delivery', async () => {
    for (const event of ['subscription.changed', 'something.invented.later']) {
      const res = await deliver(payload(event, { plan: 'pro' }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, handled: false })
    }
  })
})
