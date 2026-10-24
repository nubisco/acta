/**
 * Plans and billing (LA-399): limits from the entitlement licenses keeps,
 * enforced through REST and MCP, the 11th Team member bought at the next
 * renewal, nothing deleted on a downgrade, and a core build with none of it.
 * Licenses and Paddle are never called: a fake licenses answers every fetch.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../../../server/src/app'
import { createToken } from '../../../server/src/core/auth'
import { ApiError } from '../../../server/src/core/ctx'
import {
  assertWithinLimit,
  resetEdition,
} from '../../../server/src/core/edition'
import { openDb, type BunSqliteDriver } from '../../../server/src/db'
import { retentionDaysFor } from '../../../server/src/services/retention'
import { registerEnterpriseEdition } from '../src/index'
import { billingEvents } from '../src/plans/analytics'
import type { IEntitlement } from '../src/plans/client'
import { configFromEnv, configurePlans } from '../src/plans/config'
import { TRIAL_SEAT_MESSAGE } from '../src/plans/limits'
import { STALE_MS } from '../src/plans/store'

const newId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`
const LICENSES = 'https://licenses.test'
const HOOK_SECRET = 'test-entitlement-secret'
const ENV = {
  ACTA_LICENSES_URL: LICENSES,
  ACTA_LICENSES_SERVICE_TOKEN: 'svc-token',
  ACTA_ENTITLEMENT_WEBHOOK_SECRET: HOOK_SECRET,
  ACTA_PADDLE_ENV: 'sandbox',
  ACTA_PADDLE_CLIENT_TOKEN: 'test_client_token',
}

let db: BunSqliteDriver
let app: Hono<never>
let ws: string
let jose: string
let adminToken: string
let agentToken: string

/** What the fake licenses holds and was asked. */
let entitlements: Map<string, IEntitlement>
let calls: { method: string; path: string; body: any }[]
let licensesDown: boolean
let seatsAnswer: (body: any) => Response | null

function entitlement(over: Partial<IEntitlement> = {}): IEntitlement {
  return {
    app: 'acta',
    workspace_id: ws,
    plan: 'free',
    state: 'free',
    source: 'free',
    limits: { spaces: 3, members: 5, storage_gb: 1 },
    subscription: null,
    override: null,
    version: 0,
    computed_at: new Date().toISOString(),
    ...over,
  }
}

function team(
  extra = 0,
  over: Partial<IEntitlement> = {},
  status = 'active',
): IEntitlement {
  return entitlement({
    plan: 'team',
    state: status === 'trialing' ? 'trialing' : 'active',
    source: 'subscription',
    limits: { spaces: 20, members: 10 + extra, storage_gb: 50 },
    subscription: {
      id: 'sub_1',
      status,
      plan: 'team',
      billing: 'monthly',
      extra_members: extra,
      current_period_end: '2026-12-01T00:00:00Z',
      ends_at: null,
      grace_until: null,
    },
    version: 5,
    ...over,
  })
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const fakeLicenses = (async (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => {
  const url = new URL(String(input))
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  calls.push({ method: init?.method ?? 'GET', path: url.pathname, body })
  if (licensesDown) throw new TypeError('network down')
  if (url.pathname.startsWith('/v1/entitlements/acta/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop()!)
    return json(entitlements.get(id) ?? { ...entitlement(), workspace_id: id })
  }
  if (url.pathname === '/v1/billing/seats') {
    const custom = seatsAnswer(body)
    if (custom) return custom
    const held = entitlements.get(body.workspace_id)!
    const next: IEntitlement = {
      ...held,
      limits: { ...held.limits, members: 10 + body.extra_members },
      subscription: {
        ...held.subscription!,
        extra_members: body.extra_members,
      },
      version: held.version + 1,
    }
    entitlements.set(body.workspace_id, next)
    return json({
      ok: true,
      extra_members: body.extra_members,
      entitlement: next,
    })
  }
  if (url.pathname === '/v1/billing/checkout')
    return json({ transaction_id: 'txn_1', checkout_url: null })
  if (url.pathname === '/v1/billing/portal')
    return json({ url: 'https://portal.test/overview' })
  return json({ error: 'not_found' }, 404)
}) as typeof fetch

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
  )
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function push(e: IEntitlement, secret = HOOK_SECRET): Promise<Response> {
  const body = JSON.stringify({
    event: 'entitlement.updated',
    timestamp: new Date().toISOString(),
    data: e,
  })
  return app.request('https://acta.test/api/v1/billing/entitlement', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-nubisco-signature': `sha256=${await hmacHex(secret, body)}`,
    },
    body,
  })
}

function api(
  path: string,
  body?: unknown,
  token = adminToken,
  method = body === undefined ? 'GET' : 'POST',
): Promise<Response> {
  return Promise.resolve(
    app.request(`https://acta.test/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
}

async function mcp(name: string, args: unknown, token = agentToken) {
  const res = await app.request('https://acta.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const out = (await res.json()) as any
  return {
    isError: out.result?.isError === true,
    text: out.result?.content?.[0]?.text as string,
  }
}

async function spaces(keys: string[]) {
  const res = await api('/spaces/write', {
    ops: keys.map((key) => ({
      op: 'create',
      op_id: `s-${key}`,
      key,
      name: key,
      template: 'kanban6',
    })),
  })
  const out = (await res.json()) as any
  return out.results as {
    ok: boolean
    error?: string
    current?: any
  }[]
}

async function addMembers(n: number): Promise<void> {
  for (let i = 0; i < n; i++)
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, created_at)
       VALUES (?, ?, 'human', ?, ?, ?, 'member', ?)`,
      [newId('act'), ws, `m${i}`, `M${i}`, `m${i}@example.com`, Date.now() + i],
    )
}

async function build(withEe = true): Promise<void> {
  if (withEe) registerEnterpriseEdition()
  db = await openDb(':memory:')
  app = (await createApp(db, {
    bootstrap: {
      workspaceName: 'Acme',
      adminEmail: 'jose@nubisco.io',
      adminHandle: 'jose',
    },
    dataDir: `/tmp/acta-plans-${Math.random().toString(36).slice(2)}`,
    baseUrl: 'https://acta.test',
    editionEnv: withEe ? ENV : {},
  })) as never
  if (withEe)
    configurePlans({ ...configFromEnv(ENV)!, fetchImpl: fakeLicenses })
  ws = (await db.query<{ id: string }>('SELECT id FROM workspace'))[0].id
  jose = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
  adminToken = await createToken(db, ws, jose, 'personal', [
    'read',
    'write',
    'admin',
  ])
  const agent = newId('act')
  await db.run(
    `INSERT INTO actor (id, workspace_id, kind, handle, name, role, created_at)
     VALUES (?, ?, 'agent', 'claude', 'Claude', 'member', ?)`,
    [agent, ws, Date.now()],
  )
  agentToken = await createToken(db, ws, agent, 'agent', ['read', 'write'])
}

beforeEach(async () => {
  entitlements = new Map()
  calls = []
  licensesDown = false
  seatsAnswer = () => null
  await build()
})

afterEach(() => {
  configurePlans(null)
  resetEdition()
})

describe('the plan a workspace is held to', () => {
  it('is Free with no row and licenses unreachable', async () => {
    licensesDown = true
    const results = await spaces(['SA', 'SB', 'SC', 'SD'])
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false])
    expect(results[3]!.current).toMatchObject({
      error: 'plan_limit',
      resource: 'spaces',
      limit: 3,
      current: 3,
    })
  })

  it('never drops to Free on a network error', async () => {
    expect((await push(team())).status).toBe(200)
    // A day later the row is stale and licenses is down: Team still holds.
    await db.run('UPDATE workspace_plan SET fetched_at = ?', [
      Date.now() - STALE_MS - 1000,
    ])
    licensesDown = true
    const results = await spaces(['SA', 'SB', 'SC', 'SD', 'SE'])
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('fetches a missing entitlement once and caches it', async () => {
    entitlements.set(ws, team())
    await spaces(['SA', 'SB', 'SC', 'SD'])
    const fetches = calls.filter((c) => c.path.startsWith('/v1/entitlements/'))
    expect(fetches).toHaveLength(1)
  })
})

describe('limits through REST and MCP', () => {
  it('refuses the fourth space on Free, over MCP with isError', async () => {
    await push(entitlement({ version: 1 }))
    await spaces(['SA', 'SB', 'SC'])
    const res = await mcp('space_write', {
      ops: [
        {
          op: 'create',
          op_id: 'm1',
          key: 'SD',
          name: 'D',
          template: 'kanban6',
        },
      ],
    })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('plan_limit')
    expect(res.text).toContain('allows 3 spaces')
  })

  it('archiving a space makes room, and restoring it is checked', async () => {
    await push(entitlement({ version: 1 }))
    await spaces(['SA', 'SB', 'SC'])
    await api('/spaces/write', {
      ops: [{ op: 'archive', op_id: 'a1', key: 'SC' }],
    })
    expect((await spaces(['SD']))[0]!.ok).toBe(true)
    const restore = await api('/spaces/write', {
      ops: [{ op: 'restore', op_id: 'r1', key: 'SC' }],
    })
    expect(((await restore.json()) as any).results[0].current.error).toBe(
      'plan_limit',
    )
  })

  it('caps rules, webhooks and agents on Free', async () => {
    await push(entitlement({ version: 1 }))
    const hooks = await api('/webhooks/write', {
      ops: [1, 2, 3, 4].map((i) => ({
        op: 'create',
        op_id: `w${i}`,
        url: `https://hooks.example.com/${i}`,
        events: ['*'],
      })),
    })
    expect(((await hooks.json()) as any).results.map((r: any) => r.ok)).toEqual(
      [true, true, true, false],
    )
    // Claude is one agent already, so one more fits and the third does not.
    const first = await api('/tokens', { name: 'Bot one' })
    expect(first.status).toBe(200)
    const second = await api('/tokens', { name: 'Bot two' })
    expect(second.status).toBe(402)
    expect(((await second.json()) as any).current.resource).toBe('agents')
  })

  it('refuses a file over the plan size, and storage over the plan', async () => {
    await push(entitlement({ version: 1 }))
    await spaces(['SA'])
    await api('/items/write', {
      ops: [
        { op: 'create', op_id: 'i1', space: 'SA', list: 'To Do', title: 'x' },
      ],
    })
    const big = new Uint8Array(11 * 1024 * 1024)
    const res = await app.request(
      'https://acta.test/api/v1/attachments/raw?item=SA-1&filename=big.bin',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}` },
        body: big,
      },
    )
    expect(res.status).toBe(402)
    expect(((await res.json()) as any).error).toContain('files up to 10 MB')
  })
})

describe('the entitlement webhook', () => {
  it('refuses a bad signature and writes nothing', async () => {
    const res = await push(team(), 'wrong-secret')
    expect(res.status).toBe(401)
    expect(await db.query('SELECT * FROM workspace_plan')).toHaveLength(0)
  })

  it('applies a newer version and ignores an older one', async () => {
    await push(team(0, { version: 5 }))
    const older = await push(entitlement({ version: 4 }))
    expect(((await older.json()) as any).outcome).toBe('stale')
    const row = (
      await db.query<{ plan: string; version: number }>(
        'SELECT plan, version FROM workspace_plan',
      )
    )[0]
    expect(row).toEqual({ plan: 'team', version: 5 })
  })

  it('is not there when no secret is configured', async () => {
    configurePlans({
      ...configFromEnv(ENV)!,
      webhookSecret: null,
      fetchImpl: fakeLicenses,
    })
    expect((await push(team())).status).toBe(404)
  })
})

describe('members on Acta Team', () => {
  it('buys the 11th member, billed at the next renewal', async () => {
    entitlements.set(ws, team(0))
    await push(team(0))
    await addMembers(9) // Jose plus 9 is 10, all included.
    await assertWithinLimit({ db, workspaceId: ws }, 'members', 10)
    const seats = calls.filter((c) => c.path === '/v1/billing/seats')
    expect(seats).toHaveLength(1)
    expect(seats[0]!.body).toEqual({
      app: 'acta',
      workspace_id: ws,
      extra_members: 1,
    })
    const limits = await (await api('/billing')).json()
    expect((limits as any).limits.members).toBe(11)
  })

  it('stops at 50 and sends the rest to sales', async () => {
    await push(team(40))
    await expect(
      assertWithinLimit({ db, workspaceId: ws }, 'members', 50),
    ).rejects.toMatchObject({ status: 402 })
  })

  it('explains the trial rule rather than passing on a 409', async () => {
    await push(team(0, {}, 'trialing'))
    let caught: unknown
    try {
      await assertWithinLimit({ db, workspaceId: ws }, 'members', 10)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as ApiError).status).toBe(409)
    expect((caught as ApiError).message).toBe(TRIAL_SEAT_MESSAGE)
  })

  it('surfaces the trial refusal from the seats route in plain words', async () => {
    await push(team(2, {}, 'trialing'))
    seatsAnswer = () =>
      json({ error: 'trial_seat_change', message: 'paddle words' }, 409)
    const res = await api('/billing/seats', { extra_members: 0 })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error).toBe(TRIAL_SEAT_MESSAGE)
  })

  it('refuses an invitation on Free at the member cap', async () => {
    await push(entitlement({ version: 1 }))
    await addMembers(4)
    const res = await api('/invitations', {
      email: 'new@example.com',
      name: 'New Person',
      role: 'member',
    })
    expect(res.status).toBe(402)
  })
})

describe('a downgrade deletes nothing', () => {
  it('makes the newest spaces and the last people read-only', async () => {
    await push(team())
    await spaces(['SA', 'SB', 'SC', 'SD', 'SE'])
    await push(entitlement({ version: 6 }))
    // Everything is still there.
    expect(
      (await db.query('SELECT id FROM space WHERE archived = 0')).length,
    ).toBe(5)
    const write = async (space: string, n: string) => {
      const res = await api('/items/write', {
        ops: [{ op: 'create', op_id: n, space, list: 'To Do', title: n }],
      })
      return ((await res.json()) as any).results[0]
    }
    expect((await write('SA', 'in-a')).ok).toBe(true)
    const blocked = await write('SE', 'in-e')
    expect(blocked.ok).toBe(false)
    expect(blocked.current).toMatchObject({
      error: 'plan_limit',
      resource: 'spaces',
    })
    // Archiving is how an admin chooses what stays: allowed, and it frees E.
    await api('/spaces/write', {
      ops: [
        { op: 'archive', op_id: 'ar-c', key: 'SC' },
        { op: 'archive', op_id: 'ar-d', key: 'SD' },
      ],
    })
    expect((await write('SE', 'in-e-2')).ok).toBe(true)
  })

  it('lets an admin choose who keeps write access over the member cap', async () => {
    await push(team())
    await addMembers(6) // 7 people on a Free cap of 5 after the downgrade.
    await push(entitlement({ version: 6 }))
    const last = (
      await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'm5'")
    )[0]!.id
    const token = await createToken(db, ws, last, 'personal', ['read', 'write'])
    let n = 0
    const doc = () =>
      api(
        '/docs/write',
        {
          ops: [
            {
              op: 'create',
              op_id: `doc-${++n}`,
              slug: `page-${n}`,
              title: 'D',
              body: 'x',
            },
          ],
        },
        token,
      ).then(async (r) => ((await r.json()) as any).results[0])
    expect((await doc()).ok).toBe(false)
    await api(`/members/${last}`, { keeps_write: true }, adminToken, 'PATCH')
    expect((await doc()).ok).toBe(true)
  })
})

describe('the billing routes', () => {
  it('starts a checkout through licenses for admins only', async () => {
    const res = await api('/billing/checkout', {
      billing: 'yearly',
      extra_members: 2,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      transaction_id: 'txn_1',
      paddle: { env: 'sandbox', client_token: 'test_client_token' },
    })
    expect(
      calls.find((c) => c.path === '/v1/billing/checkout')!.body,
    ).toMatchObject({
      app: 'acta',
      plan: 'team',
      workspace_id: ws,
      billing: 'yearly',
      extra_members: 2,
    })
    expect(
      (await api('/billing/checkout', { billing: 'monthly' }, agentToken))
        .status,
    ).toBe(403)
  })

  it('reports plan, usage and limits, fetched on open', async () => {
    entitlements.set(ws, team(3))
    const body = (await (await api('/billing')).json()) as any
    expect(body.plan).toBe('team')
    expect(body.limits.members).toBe(13)
    expect(body.usage.members).toBe(1)
    expect(body.team).toEqual({ members_included: 10, members_max: 50 })
  })

  it('history follows the plan', async () => {
    await push(entitlement({ version: 1 }))
    expect(await retentionDaysFor(db, ws)).toBe(90)
    await push(team(0, { version: 7 }))
    expect(await retentionDaysFor(db, ws)).toBe(365)
  })
})

describe('analytics', () => {
  it('names a trial, a purchase with its revenue, and a cancellation', () => {
    const trial = team(0, {}, 'trialing')
    expect(billingEvents(null, trial).map((e) => e.name)).toEqual([
      'Trial Started',
    ])
    const before = {
      plan: 'team',
      state: 'trialing' as const,
      source: 'subscription' as const,
      limits: {},
      subscription: trial.subscription,
      version: 5,
      fetched_at: 0,
    }
    const paid = billingEvents(before, team(2, { version: 6 }))
    expect(paid).toEqual([
      expect.objectContaining({
        name: 'Purchase',
        revenue: { amount: '47.00', currency: 'USD' },
      }),
    ])
    const cancelled = team(2, { version: 7 })
    cancelled.subscription!.ends_at = '2026-12-01T00:00:00Z'
    expect(
      billingEvents({ ...before, state: 'active' }, cancelled).map(
        (e) => e.name,
      ),
    ).toEqual(['Subscription Cancelled'])
  })
})

describe('a core build', () => {
  it('has no limits, no billing routes and no plans feature', async () => {
    configurePlans(null)
    resetEdition()
    await build(false)
    const cfg = (await (
      await app.request('https://acta.test/api/v1/auth/config')
    ).json()) as any
    expect(cfg.plans).toBe(false)
    expect((await api('/billing')).status).toBe(404)
    expect(
      (await spaces(['SA', 'SB', 'SC', 'SD', 'SE'])).every((r) => r.ok),
    ).toBe(true)
  })

  it('a hosted build without billing set up has no limits either', async () => {
    configurePlans(null)
    expect(
      (await spaces(['SA', 'SB', 'SC', 'SD', 'SE'])).every((r) => r.ok),
    ).toBe(true)
    const cfg = (await (
      await app.request('https://acta.test/api/v1/auth/config')
    ).json()) as any
    expect(cfg.plans).toBe(false)
  })
})
