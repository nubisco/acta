/**
 * Self-serve signup (LA-398): a stranger the provider vouched for creates a
 * workspace of their own, one per account, and sees nothing of anyone else's.
 * And the Free inactivity ladder, which touches no paid workspace.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../../../server/src/app'
import { createToken } from '../../../server/src/core/auth'
import { resetEdition } from '../../../server/src/core/edition'
import type { IEmail } from '../../../server/src/core/email'
import { ssoConfigFromEnv } from '../../../server/src/core/sso'
import { openDb, type BunSqliteDriver } from '../../../server/src/db'
import { itemWrite } from '../../../server/src/services/items'
import { spaceWrite } from '../../../server/src/services/spaces'
import { registerEnterpriseEdition } from '../src/index'
import { EE_MODULES } from '../src/modules'
import {
  DELETE_AFTER_DAYS,
  FREEZE_AFTER_DAYS,
  WARN_AFTER_DAYS,
  inactivitySweep,
} from '../src/signup/inactivity'

const ISSUER = 'https://idp.test'
const DAY = 24 * 60 * 60 * 1000
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

afterEach(() => resetEdition())

const idpFetch = (async (input: Parameters<typeof fetch>[0]) => {
  if (String(input).startsWith(`${ISSUER}/.well-known/jwks.json`))
    return new Response(JSON.stringify(jwks), {
      headers: { 'content-type': 'application/json' },
    })
  return new Response('ok', { status: 200 })
}) as typeof fetch

const tmp = () => `/tmp/acta-signup-${Math.random().toString(36).slice(2)}`

/** Nubisco's instance: a provider, one workspace with Jose in it. */
async function instance(
  db: BunSqliteDriver,
  env: Record<string, string> = {},
): Promise<Hono<never>> {
  const sso = ssoConfigFromEnv({
    ACTA_SSO_ISSUER: ISSUER,
    ACTA_SSO_APP_ID: 'acta',
  })!
  return (await createApp(db, {
    bootstrap: {
      workspaceName: 'Nubisco',
      adminEmail: 'jose@nubisco.io',
      adminHandle: 'jose',
    },
    dataDir: tmp(),
    fetchImpl: idpFetch,
    baseUrl: 'https://acta.test',
    sso,
    editionEnv: env,
  })) as never
}

async function signIn(app: Hono<never>, email: string): Promise<Response> {
  const start = await app.request('https://acta.test/api/v1/auth/sso/start')
  const state = /acta_sso_state=([^;]+)/.exec(
    start.headers.get('set-cookie') ?? '',
  )![1]
  const token = await signToken({
    sub: `sub-${email}`,
    email,
    name: 'Ana Stranger',
    iss: ISSUER,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  })
  return app.request(
    `https://acta.test/api/v1/auth/sso/callback?token=${encodeURIComponent(token)}&state=${state}`,
    { headers: { cookie: `acta_sso_state=${state}` } },
  )
}

function cookieOf(res: Response, name: string): string | null {
  const m = new RegExp(`${name}=([^;]+)`).exec(
    res.headers.get('set-cookie') ?? '',
  )
  return m ? `${name}=${m[1]}` : null
}

function post(path: string, body: unknown, cookie: string): Promise<Request> {
  return Promise.resolve(
    new Request(`https://acta.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  )
}

/** A stranger through the provider, holding their signup cookie. */
async function stranger(
  app: Hono<never>,
  email = 'ana@example.com',
): Promise<string> {
  const res = await signIn(app, email)
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toBe('/signup')
  return cookieOf(res, 'acta_signup')!
}

describe('without the Enterprise Edition', () => {
  it('refuses a stranger as before, and offers no signup', async () => {
    const db = await openDb(':memory:')
    const app = await instance(db)
    const res = await signIn(app, 'ana@example.com')
    expect(res.headers.get('location')).toBe('/login?error=not_a_member')
    const created = await app.fetch(
      await post(
        '/api/v1/auth/signup/workspaces',
        { name: 'Ana Co' },
        'acta_signup=x',
      ),
    )
    // Not mounted at all: the core has no signup to answer with.
    expect(created.status).not.toBe(201)
    expect(
      await db.query("SELECT id FROM workspace WHERE name = 'Ana Co'"),
    ).toHaveLength(0)
    const config = (await (
      await app.request('/api/v1/auth/config')
    ).json()) as { signup: boolean }
    expect(config.signup).toBe(false)
  })
})

describe('signup with the Enterprise Edition', () => {
  it('takes a stranger from sign-in to a workspace of their own', async () => {
    registerEnterpriseEdition(EE_MODULES)
    const db = await openDb(':memory:')
    const app = await instance(db)
    const config = (await (
      await app.request('/api/v1/auth/config')
    ).json()) as { signup: boolean }
    expect(config.signup).toBe(true)

    const cookie = await stranger(app)
    const state = (await (
      await app.request('https://acta.test/api/v1/auth/signup/state', {
        headers: { cookie },
      })
    ).json()) as {
      identity: { email: string; source: string }
      can_create: boolean
    }
    expect(state.identity).toMatchObject({
      email: 'ana@example.com',
      source: 'pending',
    })
    expect(state.can_create).toBe(true)

    const res = await app.fetch(
      await post(
        '/api/v1/auth/signup/workspaces',
        { name: 'Ana Co', slug: 'ana-co' },
        cookie,
      ),
    )
    expect(res.status).toBe(201)
    expect(((await res.json()) as { slug: string }).slug).toBe('ana-co')
    const session = cookieOf(res, 'acta_session')!
    expect(session).toBeTruthy()

    const ws = (
      await db.query<{
        id: string
        owner_email: string
        last_seen_at: number
      }>(
        "SELECT id, owner_email, last_seen_at FROM workspace WHERE slug = 'ana-co'",
      )
    )[0]
    expect(ws.owner_email).toBe('ana@example.com')
    const admin = (
      await db.query<{ role: string; email_confirmed_at: number | null }>(
        "SELECT role, email_confirmed_at FROM actor WHERE workspace_id = ? AND kind = 'human'",
        [ws.id],
      )
    )[0]
    expect(admin.role).toBe('admin')
    expect(admin.email_confirmed_at).not.toBeNull()
    // The intent is used up.
    expect(await db.query('SELECT token_hash FROM signup_intent')).toHaveLength(
      0,
    )

    // The new admin sees their workspace, and only theirs.
    const listed = (await (
      await app.request('https://acta.test/api/v1/auth/workspaces', {
        headers: { cookie: session },
      })
    ).json()) as { workspaces: { slug: string }[] }
    expect(listed.workspaces.map((w) => w.slug)).toEqual(['ana-co'])
    const nubisco = await app.request(
      'https://acta.test/api/v1/w/nubisco/overview',
      { headers: { cookie: session } },
    )
    expect(nubisco.status).toBe(404)
  })

  it("isolates the new workspace: nothing of Nubisco's shows up in it", async () => {
    registerEnterpriseEdition(EE_MODULES)
    const db = await openDb(':memory:')
    const app = await instance(db)
    const nubiscoId = (
      await db.query<{ id: string }>(
        "SELECT id FROM workspace WHERE slug = 'nubisco'",
      )
    )[0].id
    const jose = (
      await db.query<{ id: string }>(
        "SELECT id FROM actor WHERE handle = 'jose'",
      )
    )[0].id
    const ctx = {
      db,
      workspaceId: nubiscoId,
      actor: {
        id: jose,
        kind: 'human' as const,
        handle: 'jose',
        role: 'admin' as const,
        scopes: ['read', 'write', 'admin'],
      },
    }
    await spaceWrite(ctx, [
      {
        op: 'create',
        op_id: 's',
        key: 'SW',
        name: 'Secret',
        template: 'kanban6',
      },
    ])
    await itemWrite(
      ctx,
      [
        {
          op: 'create',
          op_id: 'i',
          list: 'To Do',
          title: 'Confidential roadmap',
        },
      ],
      'SW',
    )

    const cookie = await stranger(app)
    const res = await app.fetch(
      await post('/api/v1/auth/signup/workspaces', { name: 'Ana Co' }, cookie),
    )
    const session = cookieOf(res, 'acta_session')!
    const slug = ((await res.json()) as { slug: string }).slug
    const overview = (await (
      await app.request(`https://acta.test/api/v1/w/${slug}/overview`, {
        headers: { cookie: session },
      })
    ).json()) as { spaces: unknown[] }
    expect(overview.spaces).toHaveLength(0)
    const searched = await app.request(
      `https://acta.test/api/v1/w/${slug}/search?q=confidential`,
      { headers: { cookie: session } },
    )
    expect(searched.status).toBe(200)
    const search = (await searched.json()) as { results: unknown[] }
    expect(search.results).toHaveLength(0)
  })

  it('allows one workspace per account, and points at sales above it', async () => {
    registerEnterpriseEdition(EE_MODULES)
    const db = await openDb(':memory:')
    const app = await instance(db, {
      ACTA_SALES_URL: 'https://nubisco.io/contact',
    })
    const cookie = await stranger(app)
    const first = await app.fetch(
      await post('/api/v1/auth/signup/workspaces', { name: 'One' }, cookie),
    )
    const session = cookieOf(first, 'acta_session')!
    const second = await app.fetch(
      await post('/api/v1/auth/signup/workspaces', { name: 'Two' }, session),
    )
    expect(second.status).toBe(403)
    expect(await second.json()).toMatchObject({
      error: 'workspace_limit',
      sales_url: 'https://nubisco.io/contact',
    })

    // Deleting the first does not free the slot while it waits to be purged.
    await db.run(
      "UPDATE workspace SET deleted_at = 1, purge_at = 2 WHERE owner_email = 'ana@example.com'",
    )
    const state = (await (
      await app.request('https://acta.test/api/v1/auth/signup/state', {
        headers: { cookie: session },
      })
    ).json()) as { can_create: boolean; owned: number }
    expect(state).toMatchObject({ can_create: false, owned: 1 })
  })

  it('lets an existing member create one, and keeps their session', async () => {
    registerEnterpriseEdition(EE_MODULES)
    const db = await openDb(':memory:')
    const app = await instance(db)
    const ws = (await db.query<{ id: string }>('SELECT id FROM workspace'))[0]
      .id
    const jose = (
      await db.query<{ id: string }>(
        "SELECT id FROM actor WHERE handle = 'jose'",
      )
    )[0].id
    const token = await createToken(db, ws, jose, 'session', [
      'read',
      'write',
      'admin',
    ])
    const res = await app.fetch(
      await post(
        '/api/v1/auth/signup/workspaces',
        { name: 'Side project' },
        `acta_session=${token}`,
      ),
    )
    expect(res.status).toBe(201)
    expect(cookieOf(res, 'acta_session')).toBeNull()
    const listed = (await (
      await app.request('https://acta.test/api/v1/auth/workspaces', {
        headers: { cookie: `acta_session=${token}` },
      })
    ).json()) as { workspaces: { slug: string }[] }
    expect(listed.workspaces.map((w) => w.slug).sort()).toEqual([
      'nubisco',
      'side-project',
    ])
  })

  it('refuses reserved and taken addresses, and a request with no identity', async () => {
    registerEnterpriseEdition(EE_MODULES)
    const db = await openDb(':memory:')
    const app = await instance(db)
    const anonymous = await app.fetch(
      await post('/api/v1/auth/signup/workspaces', { name: 'X' }, ''),
    )
    expect(anonymous.status).toBe(401)

    const cookie = await stranger(app)
    for (const slug of ['admin', 'api', 'login', 'nubisco', 'acta', 'a']) {
      const res = await app.fetch(
        await post(
          '/api/v1/auth/signup/workspaces',
          { name: 'X', slug },
          cookie,
        ),
      )
      expect(res.status).toBe(400)
    }
    // Free of the reserved list, but Nubisco already has it.
    await db.run(
      "UPDATE workspace SET slug = 'taken-one' WHERE slug = 'nubisco'",
    )
    const taken = await app.fetch(
      await post(
        '/api/v1/auth/signup/workspaces',
        { name: 'X', slug: 'taken-one' },
        cookie,
      ),
    )
    expect(taken.status).toBe(409)
    // A name that slugifies to a reserved word gets an address that is not.
    const named = await app.fetch(
      await post('/api/v1/auth/signup/workspaces', { name: 'Admin' }, cookie),
    )
    expect(named.status).toBe(201)
    expect(((await named.json()) as { slug: string }).slug).not.toBe('admin')
  })

  it('records the terms when the deployment names a version, and requires them', async () => {
    registerEnterpriseEdition(EE_MODULES)
    const db = await openDb(':memory:')
    const app = await instance(db, {
      ACTA_TERMS_VERSION: '2026-11',
      ACTA_TERMS_URL: 'https://nubisco.io/terms',
      ACTA_PRIVACY_URL: 'https://nubisco.io/privacy',
    })
    const cookie = await stranger(app)
    const missing = await app.fetch(
      await post('/api/v1/auth/signup/workspaces', { name: 'Ana Co' }, cookie),
    )
    expect(missing.status).toBe(400)
    const ok = await app.fetch(
      await post(
        '/api/v1/auth/signup/workspaces',
        { name: 'Ana Co', terms_version: '2026-11' },
        cookie,
      ),
    )
    expect(ok.status).toBe(201)
    const row = (
      await db.query<{ terms_version: string; terms_accepted_at: number }>(
        "SELECT terms_version, terms_accepted_at FROM workspace WHERE owner_email = 'ana@example.com'",
      )
    )[0]
    expect(row.terms_version).toBe('2026-11')
    expect(row.terms_accepted_at).toBeGreaterThan(0)
  })

  it('never takes over a sign-in that has somewhere to go', async () => {
    registerEnterpriseEdition(EE_MODULES)
    const db = await openDb(':memory:')
    const app = await instance(db)
    const res = await signIn(app, 'jose@nubisco.io')
    expect(res.headers.get('location')).toBe('/')
    expect(cookieOf(res, 'acta_signup')).toBeNull()
  })
})

describe('the Free inactivity ladder', () => {
  async function idleWorkspace(
    db: BunSqliteDriver,
    idleDays: number,
    at: number,
  ) {
    registerEnterpriseEdition(EE_MODULES)
    const app = await instance(db)
    const cookie = await stranger(app)
    const res = await app.fetch(
      await post('/api/v1/auth/signup/workspaces', { name: 'Idle Co' }, cookie),
    )
    const slug = ((await res.json()) as { slug: string }).slug
    await db.run('UPDATE workspace SET last_seen_at = ? WHERE slug = ?', [
      at - idleDays * DAY,
      slug,
    ])
    return { app, slug, session: cookieOf(res, 'acta_session')! }
  }

  const free = async () => true
  const paid = async () => false

  it('does nothing to a paid workspace, or to any while no plans exist', async () => {
    const db = await openDb(':memory:')
    const at = Date.now()
    await idleWorkspace(db, 400, at)
    // The default answer, until the plans module supplies one, is "paid".
    expect(
      await inactivitySweep({ db, isFreePlan: paid, nowMs: at, force: true }),
    ).toEqual([])
    const row = (
      await db.query<{ inactivity_warned_at: number | null }>(
        "SELECT inactivity_warned_at FROM workspace WHERE slug = 'idle-co'",
      )
    )[0]
    expect(row.inactivity_warned_at).toBeNull()
  })

  it('warns, freezes, then schedules deletion, a rung at a time', async () => {
    const db = await openDb(':memory:')
    const sent: IEmail[] = []
    const send = async (m: IEmail) => {
      sent.push(m)
    }
    let at = Date.now()
    await idleWorkspace(db, WARN_AFTER_DAYS - 1, at)
    const sweep = (nowMs: number) =>
      inactivitySweep({ db, isFreePlan: free, send, nowMs, force: true })

    expect(await sweep(at)).toEqual([])

    at += 2 * DAY // 181 days idle
    expect((await sweep(at)).map((d) => d.action)).toEqual(['warned'])
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('ana@example.com')
    expect(sent[0].text).toContain('read-only on')

    // Long idle, but the freeze waits thirty days after the warning.
    at += 29 * DAY
    expect(await sweep(at)).toEqual([])
    at += 1 * DAY // 211 idle, 30 since the warning
    expect((await sweep(at)).map((d) => d.action)).toEqual(['frozen'])
    expect(sent).toHaveLength(2)

    at += (DELETE_AFTER_DAYS - FREEZE_AFTER_DAYS) * DAY
    expect((await sweep(at)).map((d) => d.action)).toEqual([
      'deletion_scheduled',
    ])
    const row = (
      await db.query<{ purge_at: number | null }>(
        "SELECT purge_at FROM workspace WHERE slug = 'idle-co'",
      )
    )[0]
    expect(row.purge_at).not.toBeNull()
  })

  it('a frozen workspace refuses token writes, and a person opening it lifts it', async () => {
    const db = await openDb(':memory:')
    const at = Date.now()
    const { app, slug, session } = await idleWorkspace(db, 0, at)
    const ws = (
      await db.query<{ id: string }>(
        'SELECT id FROM workspace WHERE slug = ?',
        [slug],
      )
    )[0].id
    const admin = (
      await db.query<{ id: string }>(
        "SELECT id FROM actor WHERE workspace_id = ? AND kind = 'human'",
        [ws],
      )
    )[0].id
    const personal = await createToken(db, ws, admin, 'personal', [
      'read',
      'write',
    ])
    await db.run(
      'UPDATE workspace SET frozen_at = ?, inactivity_warned_at = ? WHERE id = ?',
      [at, at, ws],
    )
    const write = () =>
      app.request('https://acta.test/api/v1/spaces/write', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${personal}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ops: [{ op: 'create', op_id: 'x', key: 'XX', name: 'X' }],
        }),
      })
    expect((await write()).status).toBe(403)
    // Reading still works for a token.
    const read = await app.request('https://acta.test/api/v1/overview', {
      headers: { authorization: `Bearer ${personal}` },
    })
    expect(read.status).toBe(200)

    // A person opens it in a browser.
    const opened = await app.request(
      `https://acta.test/api/v1/w/${slug}/overview`,
      { headers: { cookie: session } },
    )
    expect(opened.status).toBe(200)
    const row = (
      await db.query<{
        frozen_at: number | null
        inactivity_warned_at: number | null
      }>('SELECT frozen_at, inactivity_warned_at FROM workspace WHERE id = ?', [
        ws,
      ])
    )[0]
    expect(row).toEqual({ frozen_at: null, inactivity_warned_at: null })
    expect((await write()).status).toBe(200)
  })

  it("never touches the instance's own workspace", async () => {
    const db = await openDb(':memory:')
    const at = Date.now()
    await idleWorkspace(db, 0, at)
    await db.run("UPDATE workspace SET last_seen_at = 0 WHERE slug = 'nubisco'")
    expect(
      await inactivitySweep({ db, isFreePlan: free, nowMs: at, force: true }),
    ).toEqual([])
  })
})
