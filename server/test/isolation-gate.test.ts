/**
 * The isolation gate (LA-397): what has to hold before anyone outside the
 * team can sign up.
 *
 * Each describe block is one of the card's "done when" lines: a stranger
 * signing in lands in nothing, a burst on each limited route gets 429, an
 * outbound webhook to a private address is refused, and email reaches
 * confirmed people only.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { createApp } from '../src/app'
import { createToken } from '../src/core/auth'
import type { ICtx } from '../src/core/ctx'
import type { IEmail } from '../src/core/email'
import { pruneOauthClients, UNUSED_CLIENT_TTL_MS } from '../src/core/oauth'
import { oidcConfigFromEnv } from '../src/core/oidc'
import {
  MemoryRateLimiter,
  RATE_LIMITS,
  memoryRateLimiters,
  type TRateLimiters,
} from '../src/core/rateLimit'
import { safePost, UrlRefused } from '../src/core/safeFetch'
import { ssoConfigFromEnv } from '../src/core/sso'
import { openDb, type BunSqliteDriver } from '../src/db'
import { itemWrite } from '../src/services/items'
import { ruleWrite } from '../src/services/rules'
import { spaceWrite } from '../src/services/spaces'
import { webhookWrite } from '../src/services/webhooks'
import { emailChannel, reminderSweep } from '../src/services/notificationSweep'
import { INVITE_EMAILS_PER_DAY } from '../src/core/emailQuota'

const ISSUER = 'https://idp.test'
let keyPair: CryptoKeyPair
let jwks: { keys: unknown[] }

function b64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function signToken(claims: Record<string, unknown>): Promise<string> {
  const enc = (obj: unknown) =>
    b64url(new TextEncoder().encode(JSON.stringify(obj)))
  const input = `${enc({ alg: 'RS256', kid: 'k' })}.${enc(claims)}`
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
  jwks = { keys: [{ ...jwk, kid: 'k', alg: 'RS256', use: 'sig' }] }
})

const idpFetch = (async (input: Parameters<typeof fetch>[0]) => {
  if (String(input).startsWith(`${ISSUER}/.well-known/jwks.json`))
    return new Response(JSON.stringify(jwks), {
      headers: { 'content-type': 'application/json' },
    })
  return new Response('ok', { status: 200 })
}) as typeof fetch

const tmp = () => `/tmp/acta-gate-${Math.random().toString(36).slice(2)}`

/** An app behind a provider, with auto-provisioning as the instance would default it. */
async function ssoApp(
  db: BunSqliteDriver,
  extra: Partial<Parameters<typeof createApp>[1]> = {},
): Promise<Hono<never>> {
  const sso = ssoConfigFromEnv({
    ACTA_SSO_ISSUER: ISSUER,
    ACTA_SSO_APP_ID: 'acta',
  })!
  return (await createApp(db, {
    bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
    dataDir: tmp(),
    fetchImpl: idpFetch,
    baseUrl: 'https://acta.test',
    sso,
    ...extra,
  })) as never
}

/** Through the provider as `email`, carrying whatever cookies the caller adds. */
async function ssoSignIn(
  app: Hono<never>,
  email: string,
  extraCookie = '',
): Promise<Response> {
  const start = await app.request('https://acta.test/api/v1/auth/sso/start')
  const state = /acta_sso_state=([^;]+)/.exec(
    start.headers.get('set-cookie') ?? '',
  )![1]
  const token = await signToken({
    sub: `sub-${email}`,
    email,
    iss: ISSUER,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  })
  return app.request(
    `https://acta.test/api/v1/auth/sso/callback?token=${encodeURIComponent(token)}&state=${state}`,
    {
      headers: {
        cookie: [`acta_sso_state=${state}`, extraCookie]
          .filter(Boolean)
          .join('; '),
      },
    },
  )
}

async function adminSession(db: BunSqliteDriver): Promise<string> {
  const ws = (await db.query<{ id: string }>('SELECT id FROM workspace'))[0].id
  const jose = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
  return createToken(db, ws, jose, 'session', ['read', 'write', 'admin'])
}

function json(body: unknown, cookie?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie: `acta_session=${cookie}` } : {}),
    },
    body: JSON.stringify(body),
  }
}

// ---------------------------------------------------------------------------

describe('sign-in no longer auto-provisions', () => {
  it('is off unless an instance opts in', () => {
    const base = { ACTA_SSO_ISSUER: ISSUER, ACTA_SSO_APP_ID: 'a' }
    expect(ssoConfigFromEnv(base)!.autoProvision).toBe(false)
    expect(
      ssoConfigFromEnv({ ...base, ACTA_SSO_AUTO_PROVISION: 'true' })!
        .autoProvision,
    ).toBe(true)
    const oidc = { ACTA_OIDC_ISSUER: ISSUER, ACTA_OIDC_CLIENT_ID: 'c' }
    expect(oidcConfigFromEnv(oidc)!.autoProvision).toBe(false)
    expect(
      oidcConfigFromEnv({ ...oidc, ACTA_OIDC_AUTO_PROVISION: 'true' })!
        .autoProvision,
    ).toBe(true)
  })

  it('turns a stranger away with access to nothing', async () => {
    const db = await openDb(':memory:')
    const app = await ssoApp(db)
    const res = await ssoSignIn(app, 'stranger@example.com')
    expect(res.headers.get('location')).toBe('/login?error=not_a_member')
    expect(res.headers.get('set-cookie') ?? '').not.toContain('acta_session=')
    expect(
      await db.query(
        "SELECT id FROM actor WHERE email = 'stranger@example.com'",
      ),
    ).toHaveLength(0)
  })

  it('still lets an existing member in, and confirms their address', async () => {
    const db = await openDb(':memory:')
    const app = await ssoApp(db)
    const res = await ssoSignIn(app, 'Jose@Nubisco.io')
    expect(res.headers.get('set-cookie') ?? '').toContain('acta_session=')
    const row = (
      await db.query<{ email_confirmed_at: number | null }>(
        "SELECT email_confirmed_at FROM actor WHERE handle = 'jose'",
      )
    )[0]
    expect(row.email_confirmed_at).not.toBeNull()
  })

  it('signs a member of another workspace into that workspace', async () => {
    const db = await openDb(':memory:')
    const app = await ssoApp(db)
    await db.run(
      "INSERT INTO workspace (id, name, slug, created_at) VALUES ('ws_other', 'Other', 'other', 1)",
    )
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, created_at)
       VALUES ('act_ana', 'ws_other', 'human', 'ana', 'Ana', 'ana@example.com', 'member', 1)`,
    )
    const res = await ssoSignIn(app, 'ana@example.com')
    expect(res.headers.get('set-cookie') ?? '').toContain('acta_session=')
    // And nothing was created in this instance's own workspace.
    expect(
      await db.query(
        "SELECT id FROM actor WHERE email = 'ana@example.com' AND workspace_id != 'ws_other'",
      ),
    ).toHaveLength(0)
  })

  it('keeps the first-run rule: a fresh install with no admin gets one, once', async () => {
    const db = await openDb(':memory:')
    const app = await ssoApp(db, { bootstrap: {} })
    await ssoSignIn(app, 'first@example.com')
    const second = await ssoSignIn(app, 'second@example.com')
    expect(
      (
        await db.query<{ role: string }>(
          "SELECT role FROM actor WHERE email = 'first@example.com'",
        )
      )[0].role,
    ).toBe('admin')
    expect(second.headers.get('location')).toBe('/login?error=not_a_member')
  })
})

// ---------------------------------------------------------------------------

describe('invitations instead of inserted members', () => {
  let db: BunSqliteDriver
  let app: Hono<never>
  let sent: IEmail[]
  let admin: string

  beforeEach(async () => {
    db = await openDb(':memory:')
    sent = []
    app = await ssoApp(db, {
      emailSender: async (m) => {
        sent.push(m)
      },
    })
    admin = await adminSession(db)
  })

  const linkIn = (mail: IEmail) =>
    /https:\/\/acta\.test\/invite\/(acta_inv_[a-f0-9]+)/.exec(mail.text)![1]

  it('creates no member until the invitation is accepted', async () => {
    // The old route name, so a script written against it invites rather
    // than inserting somebody nobody has confirmed.
    const res = await app.request(
      '/api/v1/members',
      json({ email: 'ivan@example.com', name: 'Ivan' }, admin),
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      emailed: boolean
      accept_url?: string
      invitation: { status: string; handle: string }
    }
    expect(body.emailed).toBe(true)
    expect(body.invitation).toMatchObject({ status: 'pending', handle: 'ivan' })
    // The admin never sees the link when it went by email.
    expect(body.accept_url).toBeUndefined()
    expect(
      await db.query("SELECT id FROM actor WHERE email = 'ivan@example.com'"),
    ).toHaveLength(0)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('ivan@example.com')
    expect(sent[0].html).toContain('Accept the invitation')
  })

  it('refuses members who are not admins', async () => {
    const ws = (await db.query<{ id: string }>('SELECT id FROM workspace'))[0]
      .id
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, created_at)
       VALUES ('act_m', ?, 'human', 'm', 'M', 'm@example.com', 'member', 1)`,
      [ws],
    )
    const member = await createToken(db, ws, 'act_m', 'session', [
      'read',
      'write',
    ])
    const res = await app.request(
      '/api/v1/invitations',
      json({ email: 'x@example.com', name: 'X' }, member),
    )
    expect(res.status).toBe(403)
  })

  it('accepts through the provider when the email matches', async () => {
    await app.request(
      '/api/v1/invitations',
      json({ email: 'ivan@example.com', name: 'Ivan', role: 'admin' }, admin),
    )
    const token = linkIn(sent[0])

    const preview = await app.request(`/api/v1/auth/invitations/${token}`)
    expect(await preview.json()).toMatchObject({
      email: 'ivan@example.com',
      status: 'pending',
      proof: 'provider',
    })

    const accept = await app.request(
      `/api/v1/auth/invitations/${token}/accept`,
      { method: 'POST' },
    )
    expect(await accept.json()).toEqual({ next: '/api/v1/auth/sso/start' })
    expect(accept.headers.get('set-cookie')).toContain(`acta_invite=${token}`)

    const cb = await ssoSignIn(app, 'ivan@example.com', `acta_invite=${token}`)
    expect(cb.headers.get('location')).toBe('/nubisco')
    const actor = (
      await db.query<{ role: string; email_confirmed_at: number | null }>(
        "SELECT role, email_confirmed_at FROM actor WHERE email = 'ivan@example.com'",
      )
    )[0]
    expect(actor.role).toBe('admin')
    expect(actor.email_confirmed_at).not.toBeNull()
  })

  it('refuses a forwarded link signed in as somebody else', async () => {
    await app.request(
      '/api/v1/invitations',
      json({ email: 'ivan@example.com', name: 'Ivan' }, admin),
    )
    const token = linkIn(sent[0])
    const cb = await ssoSignIn(app, 'eve@example.com', `acta_invite=${token}`)
    expect(cb.headers.get('location')).toBe(
      '/login?error=invite_email_mismatch',
    )
    expect(
      await db.query("SELECT id FROM actor WHERE email = 'eve@example.com'"),
    ).toHaveLength(0)
  })

  it('stops a revoked link from working', async () => {
    const made = (await (
      await app.request(
        '/api/v1/invitations',
        json({ email: 'ivan@example.com', name: 'Ivan' }, admin),
      )
    ).json()) as { invitation: { id: string } }
    const token = linkIn(sent[0])
    await app.request(`/api/v1/invitations/${made.invitation.id}`, {
      method: 'DELETE',
      headers: { cookie: `acta_session=${admin}` },
    })
    const accept = await app.request(
      `/api/v1/auth/invitations/${token}/accept`,
      { method: 'POST' },
    )
    expect(accept.status).toBe(410)
    const cb = await ssoSignIn(app, 'ivan@example.com', `acta_invite=${token}`)
    expect(cb.headers.get('location')).toBe('/login?error=invite_revoked')
  })

  it('caps invitation emails per workspace per day', async () => {
    for (let i = 0; i < INVITE_EMAILS_PER_DAY; i++) {
      const res = await app.request(
        '/api/v1/invitations',
        json({ email: `p${i}@example.com`, name: `P${i}` }, admin),
      )
      expect(res.status).toBe(201)
    }
    const over = await app.request(
      '/api/v1/invitations',
      json({ email: 'one-more@example.com', name: 'One more' }, admin),
    )
    expect(over.status).toBe(429)
    expect(sent).toHaveLength(INVITE_EMAILS_PER_DAY)
    // Refused before anything was written.
    expect(
      await db.query(
        "SELECT id FROM invitation WHERE email = 'one-more@example.com'",
      ),
    ).toHaveLength(0)
  })
})

describe('invitations on an instance with codes and no email', () => {
  it('hands the link to the admin, and the link signs in once', async () => {
    const db = await openDb(':memory:')
    const app: Hono<never> = (await createApp(db, {
      bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
      dataDir: tmp(),
      baseUrl: 'https://acta.test',
    })) as never
    const admin = await adminSession(db)
    const made = (await (
      await app.request(
        '/api/v1/invitations',
        json({ email: 'ivan@example.com', name: 'Ivan' }, admin),
      )
    ).json()) as { emailed: boolean; accept_url: string }
    expect(made.emailed).toBe(false)
    const token = /\/invite\/(.+)$/.exec(made.accept_url)![1]

    const preview = await app.request(`/api/v1/auth/invitations/${token}`)
    expect(((await preview.json()) as { proof: string }).proof).toBe('link')

    const accept = await app.request(
      `/api/v1/auth/invitations/${token}/accept`,
      { method: 'POST' },
    )
    expect(await accept.json()).toEqual({ next: '/nubisco' })
    expect(accept.headers.get('set-cookie')).toContain('acta_session=')

    const again = await app.request(
      `/api/v1/auth/invitations/${token}/accept`,
      { method: 'POST' },
    )
    expect(again.status).toBe(409)
    expect(
      await db.query("SELECT id FROM actor WHERE email = 'ivan@example.com'"),
    ).toHaveLength(1)
  })

  it('refuses an expired link', async () => {
    const db = await openDb(':memory:')
    const app: Hono<never> = (await createApp(db, {
      bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
      dataDir: tmp(),
      baseUrl: 'https://acta.test',
    })) as never
    const admin = await adminSession(db)
    const made = (await (
      await app.request(
        '/api/v1/invitations',
        json({ email: 'ivan@example.com', name: 'Ivan' }, admin),
      )
    ).json()) as { accept_url: string }
    const token = /\/invite\/(.+)$/.exec(made.accept_url)![1]
    await db.run('UPDATE invitation SET expires_at = 1')
    const accept = await app.request(
      `/api/v1/auth/invitations/${token}/accept`,
      { method: 'POST' },
    )
    expect(accept.status).toBe(410)
  })
})

// ---------------------------------------------------------------------------

describe('email reaches confirmed people only', () => {
  async function setup() {
    const db = await openDb(':memory:')
    await createApp(db, {
      bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
      dataDir: tmp(),
    })
    const ws = (await db.query<{ id: string }>('SELECT id FROM workspace'))[0]
      .id
    const jose = (
      await db.query<{ id: string }>(
        "SELECT id FROM actor WHERE handle = 'jose'",
      )
    )[0].id
    const ctx: ICtx = {
      db,
      workspaceId: ws,
      actor: {
        id: jose,
        kind: 'human',
        handle: 'jose',
        role: 'admin',
        scopes: ['read', 'write', 'admin'],
      },
    }
    await spaceWrite(ctx, [
      { op: 'create', op_id: 's', key: 'ST', name: 'S', template: 'kanban6' },
    ])
    return { db, ws, ctx }
  }

  async function assignTo(
    db: BunSqliteDriver,
    ctx: ICtx,
    handle: string,
    n: number,
  ) {
    await itemWrite(
      ctx,
      [
        {
          op: 'create',
          op_id: `i${n}`,
          list: 'To Do',
          title: `Card ${n}`,
          assignees: [handle],
        },
      ],
      'ST',
    )
    await db.run('UPDATE notification SET remind_at = 1')
  }

  it('sends nothing to an address nobody has proved', async () => {
    const { db, ws, ctx } = await setup()
    // The shape POST /members used to leave behind: typed in, never signed in.
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, created_at)
       VALUES ('act_typed', ?, 'human', 'typed', 'Typed', 'victim@example.com', 'member', 1)`,
      [ws],
    )
    await assignTo(db, ctx, 'typed', 1)
    const sent: IEmail[] = []
    await reminderSweep(db, {
      channels: [emailChannel(async (m) => void sent.push(m))],
      baseUrl: 'https://acta.test',
    })
    expect(sent).toHaveLength(0)

    // Once they sign in, they are reachable.
    await db.run(
      "UPDATE actor SET email_confirmed_at = 1 WHERE id = 'act_typed'",
    )
    await db.run('UPDATE notification SET reminded_at = NULL')
    await reminderSweep(db, {
      channels: [emailChannel(async (m) => void sent.push(m))],
      baseUrl: 'https://acta.test',
    })
    expect(sent.map((m) => m.to)).toEqual(['victim@example.com'])
  })

  it('caps digests per workspace per day', async () => {
    const { db, ws, ctx } = await setup()
    for (const h of ['a', 'b', 'c']) {
      await db.run(
        `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, email_confirmed_at, created_at)
         VALUES (?, ?, 'human', ?, ?, ?, 'member', 1, 1)`,
        [`act_${h}`, ws, h, h, `${h}@example.com`],
      )
    }
    let n = 0
    for (const h of ['a', 'b', 'c']) await assignTo(db, ctx, h, n++)
    const sent: IEmail[] = []
    await reminderSweep(db, {
      channels: [emailChannel(async (m) => void sent.push(m))],
      dailyEmailCap: 2,
    })
    expect(sent).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------

describe('rate limits', () => {
  /** Every limiter generous except the one under test, which allows two. */
  function tight(name: keyof TRateLimiters): TRateLimiters {
    return { ...memoryRateLimiters(), [name]: new MemoryRateLimiter(2, 60_000) }
  }

  it('agree with wrangler.toml, so the edge and the fallback enforce the same thing', () => {
    const toml = readFileSync(join(import.meta.dir, '../wrangler.toml'), 'utf8')
    const found = new Map<string, { limit: number; period: number }>()
    for (const block of toml.split(/^\[\[ratelimits\]\]$/m).slice(1)) {
      const body = block.split(/^\[(?!ratelimits\.)/m)[0] ?? ''
      const name = /name\s*=\s*"([^"]+)"/.exec(body)?.[1]
      const limit = /limit\s*=\s*(\d+)/.exec(body)?.[1]
      const period = /period\s*=\s*(\d+)/.exec(body)?.[1]
      if (name && limit && period)
        found.set(name, { limit: Number(limit), period: Number(period) })
    }
    for (const spec of Object.values(RATE_LIMITS)) {
      expect(found.get(spec.binding)).toEqual({
        limit: spec.limit,
        period: spec.period,
      })
    }
    expect(found.size).toBe(Object.keys(RATE_LIMITS).length)
  })

  it('limits OAuth client registration per address', async () => {
    const db = await openDb(':memory:')
    const app: Hono<never> = (await createApp(db, {
      dataDir: tmp(),
      rateLimiters: tight('oauth_register'),
    })) as never
    const register = () =>
      app.request('/oauth/register', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.9',
        },
        body: JSON.stringify({ redirect_uris: ['https://client.test/cb'] }),
      })
    expect((await register()).status).toBe(201)
    expect((await register()).status).toBe(201)
    const third = await register()
    expect(third.status).toBe(429)
    expect(third.headers.get('retry-after')).toBe('60')
  })

  it('limits the public ingest endpoint per address', async () => {
    const db = await openDb(':memory:')
    const app: Hono<never> = (await createApp(db, {
      dataDir: tmp(),
      rateLimiters: tight('ingest'),
    })) as never
    const hit = () =>
      app.request('/api/v1/ingest/not-a-token', json({ title: 'x' }))
    expect((await hit()).status).toBe(401)
    expect((await hit()).status).toBe(401)
    expect((await hit()).status).toBe(429)
  })

  it('limits writes per credential, and leaves reads alone', async () => {
    const db = await openDb(':memory:')
    const app: Hono<never> = (await createApp(db, {
      bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
      dataDir: tmp(),
      rateLimiters: tight('write'),
    })) as never
    const admin = await adminSession(db)
    const write = () =>
      app.request(
        '/api/v1/spaces',
        json(
          {
            ops: [
              {
                op: 'create',
                op_id: crypto.randomUUID(),
                key: `K${Math.floor(Math.random() * 900 + 100)}`,
                name: 'S',
              },
            ],
          },
          admin,
        ),
      )
    expect((await write()).status).not.toBe(429)
    expect((await write()).status).not.toBe(429)
    expect((await write()).status).toBe(429)
    const read = await app.request('/api/v1/overview', {
      headers: { cookie: `acta_session=${admin}` },
    })
    expect(read.status).toBe(200)
  })

  it('answers an MCP tool call over the limit with a result the model can read', async () => {
    const db = await openDb(':memory:')
    const app: Hono<never> = (await createApp(db, {
      bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
      dataDir: tmp(),
      rateLimiters: tight('mcp'),
    })) as never
    const token = await adminSession(db)
    const call = (id: number) =>
      app.request('/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: 'workspace_overview', arguments: {} },
        }),
      })
    await call(1)
    await call(2)
    const res = await call(3)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const body = (await res.json()) as {
      id: number
      result: { isError: boolean; content: { text: string }[] }
    }
    expect(body.id).toBe(3)
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('Rate limited')
  })

  it('limits sign-in codes per address', async () => {
    const db = await openDb(':memory:')
    const app: Hono<never> = (await createApp(db, {
      dataDir: tmp(),
      rateLimiters: tight('auth'),
    })) as never
    const ask = () =>
      app.request('/api/v1/auth/otp', json({ email: 'a@example.com' }))
    expect((await ask()).status).toBe(200)
    expect((await ask()).status).toBe(200)
    expect((await ask()).status).toBe(429)
  })
})

// ---------------------------------------------------------------------------

describe('outbound webhooks go through the SSRF guard', () => {
  const PUBLIC = async () => ['93.184.216.34']

  it('refuses a private address without opening a connection', async () => {
    const calls: string[] = []
    const deps = {
      fetch: (async (url: string) => {
        calls.push(url)
        return new Response('ok')
      }) as unknown as typeof fetch,
      resolve: async (host: string) =>
        host === 'sneaky.test' ? ['10.0.0.5'] : ['93.184.216.34'],
    }
    for (const url of [
      'http://127.0.0.1:8080/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'https://sneaky.test/hook',
      'http://localhost/hook',
      'file:///etc/passwd',
    ]) {
      const outcome = await safePost(url, deps, {
        headers: {},
        body: '{}',
      }).catch((err: unknown) => err)
      expect(outcome).toBeInstanceOf(UrlRefused)
    }
    expect(calls).toHaveLength(0)
  })

  it('does not follow a redirect to somewhere else', async () => {
    const calls: string[] = []
    const deps = {
      fetch: (async (url: string) => {
        calls.push(url)
        return new Response(null, {
          status: 307,
          headers: { location: 'http://127.0.0.1/' },
        })
      }) as unknown as typeof fetch,
      resolve: PUBLIC,
    }
    const res = await safePost('https://hooks.test/x', deps, {
      headers: {},
      body: '{}',
    })
    expect(res).toEqual({ status: 307, ok: false })
    expect(calls).toEqual(['https://hooks.test/x'])
  })

  async function workspace(fetched: string[]) {
    const db = await openDb(':memory:')
    await createApp(db, {
      bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
      dataDir: tmp(),
      webhookBackoffMs: 1,
      fetchImpl: (async (url: string) => {
        fetched.push(String(url))
        return new Response('ok')
      }) as unknown as typeof fetch,
      outboundResolve: async (host) =>
        host === 'internal.test' ? ['192.168.1.10'] : ['93.184.216.34'],
    })
    const ws = (await db.query<{ id: string }>('SELECT id FROM workspace'))[0]
      .id
    const jose = (
      await db.query<{ id: string }>(
        "SELECT id FROM actor WHERE handle = 'jose'",
      )
    )[0].id
    const ctx: ICtx = {
      db,
      workspaceId: ws,
      actor: {
        id: jose,
        kind: 'human',
        handle: 'jose',
        role: 'admin',
        scopes: ['read', 'write', 'admin'],
      },
    }
    await spaceWrite(ctx, [
      { op: 'create', op_id: 's', key: 'SUP', name: 'S', template: 'kanban6' },
    ])
    return { db, ctx }
  }

  async function until(check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      if (await check()) return
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  it('logs a webhook to a private address as refused, once', async () => {
    const fetched: string[] = []
    const { db, ctx } = await workspace(fetched)
    await webhookWrite(ctx, [
      {
        op: 'create',
        op_id: 'w1',
        url: 'https://internal.test/hook',
        events: ['item.created'],
      },
    ])
    await itemWrite(
      ctx,
      [{ op: 'create', op_id: 'i1', list: 'Backlog', title: 'T' }],
      'SUP',
    )
    await until(
      async () =>
        (await db.query('SELECT id FROM webhook_delivery')).length > 0,
    )
    const log = await db.query<{ attempts: number; last_error: string }>(
      'SELECT attempts, last_error FROM webhook_delivery',
    )
    expect(log).toEqual([
      { attempts: 1, last_error: 'url refused: private-address' },
    ])
    expect(fetched).toHaveLength(0)
  })

  it('refuses a rule that calls a private address', async () => {
    const fetched: string[] = []
    const { ctx } = await workspace(fetched)
    await ruleWrite(ctx, [
      {
        op: 'create',
        op_id: 'r1',
        name: 'Ping the intranet',
        trigger: 'item.created',
        action: { kind: 'call_webhook', url: 'http://10.0.0.1/hook' },
        enabled: true,
      },
      {
        op: 'create',
        op_id: 'r2',
        name: 'Ping a real service',
        trigger: 'item.created',
        action: { kind: 'call_webhook', url: 'https://hooks.test/ok' },
        enabled: true,
      },
    ])
    await itemWrite(
      ctx,
      [{ op: 'create', op_id: 'i1', list: 'Backlog', title: 'T' }],
      'SUP',
    )
    await until(async () => fetched.length > 0)
    await new Promise((r) => setTimeout(r, 20))
    expect(fetched).toEqual(['https://hooks.test/ok'])
  })
})

// ---------------------------------------------------------------------------

describe('OAuth dynamic registration', () => {
  it('prunes clients nobody used, and keeps the ones somebody did', async () => {
    const db = await openDb(':memory:')
    await createApp(db, { dataDir: tmp() })
    const old = Date.now() - UNUSED_CLIENT_TTL_MS - 1000
    await db.run(
      `INSERT INTO oauth_client (id, name, redirect_uris, used_at, created_at) VALUES
         ('oac_stale', 'Stale', '[]', NULL, ?),
         ('oac_used', 'Used', '[]', ?, ?),
         ('oac_fresh', 'Fresh', '[]', NULL, ?)`,
      [old, old, old, Date.now()],
    )
    await pruneOauthClients(db)
    const left = await db.query<{ id: string }>(
      'SELECT id FROM oauth_client ORDER BY id',
    )
    expect(left.map((r) => r.id)).toEqual(['oac_fresh', 'oac_used'])
  })

  it('pauses registration when the table is full of unused clients', async () => {
    const db = await openDb(':memory:')
    const app = await createApp(db, { dataDir: tmp() })
    await db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
       INSERT INTO oauth_client (id, name, redirect_uris, created_at)
       SELECT 'oac_' || i, 'x', '[]', 1 FROM n`,
    )
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://client.test/cb'] }),
    })
    expect(res.status).toBe(503)
  })
})

// ---------------------------------------------------------------------------

describe('a suspended workspace', () => {
  it('refuses every authenticated request into it', async () => {
    const db = await openDb(':memory:')
    const app: Hono<never> = (await createApp(db, {
      bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
      dataDir: tmp(),
    })) as never
    const admin = await adminSession(db)
    const headers = { cookie: `acta_session=${admin}` }
    expect((await app.request('/api/v1/overview', { headers })).status).toBe(
      200,
    )
    await db.run('UPDATE workspace SET suspended_at = 1')
    expect((await app.request('/api/v1/overview', { headers })).status).toBe(
      403,
    )
    expect(
      (await app.request('/api/v1/w/nubisco/overview', { headers })).status,
    ).toBe(403)
  })
})

// ---------------------------------------------------------------------------

describe('migration', () => {
  it('confirms people who have signed in, and nobody an admin merely typed', async () => {
    const db = await openDb(':memory:')
    await createApp(db, { dataDir: tmp() })
    const ws = (await db.query<{ id: string }>('SELECT id FROM workspace'))[0]
      .id
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, platform_user_id, created_at) VALUES
         ('act_sso', ?, 'human', 'sso', 'S', 's@example.com', 'member', 'u1', 1),
         ('act_otp', ?, 'human', 'otp', 'O', 'o@example.com', 'member', NULL, 1),
         ('act_typed', ?, 'human', 'typed', 'T', 't@example.com', 'member', NULL, 1)`,
      [ws, ws, ws],
    )
    await createToken(db, ws, 'act_otp', 'session', ['read'])
    // Force the next migrate to run, as it does on a deploy that changes the
    // schema.
    await db.run('DELETE FROM schema_state')
    db.migrate()
    const rows = await db.query<{
      handle: string
      email_confirmed_at: number | null
    }>(
      "SELECT handle, email_confirmed_at FROM actor WHERE kind = 'human' ORDER BY handle",
    )
    expect(
      Object.fromEntries(
        rows.map((r) => [r.handle, r.email_confirmed_at !== null]),
      ),
    ).toEqual({ otp: true, sso: true, typed: false })
  })
})
