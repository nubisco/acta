import { beforeEach, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/app'
import { createToken } from '../src/core/auth'
import type { ICtx } from '../src/core/ctx'
import { openDb, type BunSqliteDriver } from '../src/db'
import { boardWrite } from '../src/services/boards'
import { itemWrite } from '../src/services/items'
import { ruleWrite } from '../src/services/rules'
import { signPayload, webhookWrite } from '../src/services/webhooks'
import { activityQuery, itemGet } from '../src/services/reads'

let db: BunSqliteDriver
let app: Hono<never>
let ctx: ICtx
let delivered: { url: string; body: string; headers: Record<string, string> }[]

function fakeFetch(ok = true): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    delivered.push({
      url: String(url),
      body: String(init?.body ?? ''),
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    return new Response(ok ? 'ok' : 'no', { status: ok ? 200 : 500 })
  }) as typeof fetch
}

beforeEach(() => {
  delivered = []
  db = openDb(':memory:')
  app = createApp(db, {
    bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
    dataDir: `/tmp/acta-test-${Math.random().toString(36).slice(2)}`,
    fetchImpl: fakeFetch(),
    webhookBackoffMs: 1,
  }) as never
  const workspaceId = db.query<{ id: string }>('SELECT id FROM workspace')[0].id
  const admin = db.query<{ id: string }>(
    "SELECT id FROM actor WHERE handle = 'jose'",
  )[0]
  ctx = {
    db,
    workspaceId,
    actor: {
      id: admin.id,
      kind: 'human',
      handle: 'jose',
      role: 'admin',
      scopes: ['read', 'write', 'admin'],
    },
  }
  boardWrite(ctx, [
    {
      op: 'create',
      op_id: 'b1',
      key: 'SUP',
      name: 'Support',
      template: 'kanban6',
    },
  ])
})

async function settle(): Promise<void> {
  // Webhook delivery is fire-and-forget; let the microtask queue drain.
  await new Promise((r) => setTimeout(r, 20))
}

describe('webhooks', () => {
  it('delivers signed payloads for matching events', async () => {
    webhookWrite(ctx, [
      {
        op: 'create',
        op_id: 'w1',
        url: 'https://example.test/hook',
        events: ['item.moved'],
        secret: 's3cret',
      },
    ])
    itemWrite(
      ctx,
      [{ op: 'create', op_id: 'i1', list: 'Backlog', title: 'T' }],
      'SUP',
    )
    await settle()
    expect(delivered).toHaveLength(0) // created != moved

    itemWrite(ctx, [
      { op: 'move', op_id: 'i2', key: 'SUP-1', list: 'In Progress' },
    ])
    await settle()
    expect(delivered).toHaveLength(1)
    const hit = delivered[0]
    expect(hit.url).toBe('https://example.test/hook')
    const payload = JSON.parse(hit.body)
    expect(payload.event).toBe('item.moved')
    expect(payload.actor.kind).toBe('human')
    const expected = `sha256=${await signPayload('s3cret', hit.body)}`
    expect(hit.headers['x-acta-signature']).toBe(expected)
  })

  it('logs deliveries and counts failures', async () => {
    // Recreate the app with a failing fetch.
    db = openDb(':memory:')
    createApp(db, {
      bootstrap: { adminHandle: 'jose' },
      dataDir: `/tmp/acta-test-${Math.random().toString(36).slice(2)}`,
      fetchImpl: fakeFetch(false),
      webhookBackoffMs: 1,
    })
    const workspaceId = db.query<{ id: string }>('SELECT id FROM workspace')[0]
      .id
    const admin = db.query<{ id: string }>(
      "SELECT id FROM actor WHERE kind = 'human'",
    )[0]
    const failCtx: ICtx = {
      db,
      workspaceId,
      actor: {
        id: admin.id,
        kind: 'human',
        handle: 'jose',
        role: 'admin',
        scopes: ['read', 'write', 'admin'],
      },
    }
    boardWrite(failCtx, [
      { op: 'create', op_id: 'b1', key: 'SW', name: 'S', template: 'kanban6' },
    ])
    webhookWrite(failCtx, [
      {
        op: 'create',
        op_id: 'w1',
        url: 'https://down.test/hook',
        events: ['*'],
      },
    ])
    itemWrite(
      failCtx,
      [{ op: 'create', op_id: 'i1', list: 'Backlog', title: 'T' }],
      'SW',
    )
    await settle()
    const log = db.query<{
      status: number
      attempts: number
      last_error: string
    }>('SELECT status, attempts, last_error FROM webhook_delivery')
    expect(log.length).toBeGreaterThan(0)
    expect(log[0].attempts).toBe(3)
    expect(log[0].last_error).toContain('http 500')
    const hook = db.query<{ failure_count: number }>(
      'SELECT failure_count FROM webhook',
    )[0]
    expect(hook.failure_count).toBeGreaterThan(0)
  })
})

describe('rules', () => {
  it('moves labeled ingest items and chains causation without looping', async () => {
    ruleWrite(ctx, [
      {
        op: 'create',
        op_id: 'r1',
        name: 'route stagewright tickets',
        trigger: 'item.created',
        condition: 'board=SUP label=Bug',
        action: { kind: 'move_item', list: 'In Progress' },
        enabled: true,
      },
    ])
    itemWrite(
      ctx,
      [
        {
          op: 'create',
          op_id: 'i1',
          list: 'Backlog',
          title: 'Labeled',
          labels: ['Bug'],
        },
        { op: 'create', op_id: 'i2', list: 'Backlog', title: 'Unlabeled' },
      ],
      'SUP',
    )
    await settle()
    const labeled = itemGet(ctx, { keys: ['SUP-1'] }).items[0] as {
      list: string
    }
    const unlabeled = itemGet(ctx, { keys: ['SUP-2'] }).items[0] as {
      list: string
    }
    expect(labeled.list).toBe('In Progress')
    expect(unlabeled.list).toBe('Backlog')

    const activity = activityQuery(ctx, { actor_kind: 'system', limit: 10 })
    const ruleMove = activity.events.find((e) => e.verb === 'item.moved')
    expect(ruleMove).toBeDefined()
    expect(ruleMove!.caused_by).toBeTruthy()

    // Loop guard: the rule-caused move produced no further rule executions.
    const systemMoves = activity.events.filter((e) => e.verb === 'item.moved')
    expect(systemMoves).toHaveLength(1)
  })
})

describe('ingest', () => {
  it('creates attributed items from the public endpoint', async () => {
    const adminToken = await createToken(
      db,
      ctx.workspaceId,
      ctx.actor.id,
      'session',
      ['read', 'write', 'admin'],
    )
    const tokenRes = await app.request('/api/v1/ingest_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        name: 'Contact form',
        board: 'SUP',
        list: 'Backlog',
      }),
    })
    expect(tokenRes.status).toBe(200)
    const { token } = (await tokenRes.json()) as { token: string }

    const res = await app.request(`/api/v1/ingest/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '[Support] John - crash on load',
        description: 'It crashes.',
        meta: { From: 'John Buser', Email: 'john@example.test' },
      }),
    })
    expect(res.status).toBe(200)
    const created = (await res.json()) as { ok: boolean; key: string }
    expect(created.ok).toBe(true)

    const item = itemGet(ctx, { keys: [created.key] }).items[0] as {
      description: string
      list: string
    }
    expect(item.list).toBe('Backlog')
    expect(item.description).toContain('**From**: John Buser')

    const activity = activityQuery(ctx, { actor_kind: 'agent', limit: 10 })
    expect(activity.events.some((e) => e.verb === 'item.created')).toBe(true)

    // Bad token is rejected.
    const bad = await app.request('/api/v1/ingest/deadbeef', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(bad.status).toBe(401)
  })
})
