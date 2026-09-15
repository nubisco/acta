import { beforeEach, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/app'
import { createToken } from '../src/core/auth'
import type { ICtx } from '../src/core/ctx'
import { openDb, type BunSqliteDriver } from '../src/db'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import { ruleList, ruleWrite } from '../src/services/rules'
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

beforeEach(async () => {
  delivered = []
  db = await openDb(':memory:')
  app = (await createApp(db, {
    bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
    dataDir: `/tmp/acta-test-${Math.random().toString(36).slice(2)}`,
    fetchImpl: fakeFetch(),
    webhookBackoffMs: 1,
  })) as never
  const workspaceId = (
    await db.query<{ id: string }>('SELECT id FROM workspace')
  )[0].id
  const admin = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
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
  await spaceWrite(ctx, [
    {
      op: 'create',
      op_id: 'b1',
      key: 'SUP',
      name: 'Support',
      template: 'kanban6',
    },
  ])
})

/**
 * Wait for delivery to actually finish, rather than for a fixed 20ms.
 *
 * Delivery is fire-and-forget with retries, so a sleep is a bet on how long
 * that takes. The bet held on an idle machine and lost under a pre-commit
 * hook running four packages at once, which is exactly when a flake is most
 * expensive. Polling a condition costs nothing when it is already true.
 */
async function settleUntil(
  done: () => Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await new Promise((r) => setTimeout(r, 5))
    if (await done()) return
    if (Date.now() > deadline) return // Let the assertion report what is missing.
  }
}

/** Deliveries have stopped changing: every attempt made, nothing in flight. */
async function settle(attempts = 1): Promise<void> {
  await settleUntil(async () => {
    const rows = await db.query<{ attempts: number }>(
      'SELECT attempts FROM webhook_delivery',
    )
    return rows.length > 0 && rows.every((r) => r.attempts >= attempts)
  })
}

describe('webhooks', () => {
  it('delivers signed payloads for matching events', async () => {
    await webhookWrite(ctx, [
      {
        op: 'create',
        op_id: 'w1',
        url: 'https://example.test/hook',
        events: ['item.moved'],
        secret: 's3cret',
      },
    ])
    await itemWrite(
      ctx,
      [{ op: 'create', op_id: 'i1', list: 'Backlog', title: 'T' }],
      'SUP',
    )
    await settle()
    expect(delivered).toHaveLength(0) // created != moved

    await itemWrite(ctx, [
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
    db = await openDb(':memory:')
    await createApp(db, {
      bootstrap: { adminHandle: 'jose', adminEmail: 'jose@nubisco.io' },
      dataDir: `/tmp/acta-test-${Math.random().toString(36).slice(2)}`,
      fetchImpl: fakeFetch(false),
      webhookBackoffMs: 1,
    })
    const workspaceId = (
      await db.query<{ id: string }>('SELECT id FROM workspace')
    )[0].id
    const admin = (
      await db.query<{ id: string }>(
        "SELECT id FROM actor WHERE kind = 'human'",
      )
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
    await spaceWrite(failCtx, [
      { op: 'create', op_id: 'b1', key: 'SW', name: 'S', template: 'kanban6' },
    ])
    await webhookWrite(failCtx, [
      {
        op: 'create',
        op_id: 'w1',
        url: 'https://down.test/hook',
        events: ['*'],
      },
    ])
    await itemWrite(
      failCtx,
      [{ op: 'create', op_id: 'i1', list: 'Backlog', title: 'T' }],
      'SW',
    )
    await settle(3)
    const log = await db.query<{
      status: number
      attempts: number
      last_error: string
    }>('SELECT status, attempts, last_error FROM webhook_delivery')
    expect(log.length).toBeGreaterThan(0)
    expect(log[0].attempts).toBe(3)
    expect(log[0].last_error).toContain('http 500')
    const hook = (
      await db.query<{ failure_count: number }>(
        'SELECT failure_count FROM webhook',
      )
    )[0]
    expect(hook.failure_count).toBeGreaterThan(0)
  })
})

describe('rules', () => {
  it('moves labeled ingest items and chains causation without looping', async () => {
    await ruleWrite(ctx, [
      {
        op: 'create',
        op_id: 'r1',
        name: 'route stagewright tickets',
        trigger: 'item.created',
        condition: 'space=SUP label=Bug',
        action: { kind: 'move_item', list: 'In Progress' },
        enabled: true,
      },
    ])
    await itemWrite(
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
    const labeled = (await itemGet(ctx, { keys: ['SUP-1'] })).items[0] as {
      list: string
    }
    const unlabeled = (await itemGet(ctx, { keys: ['SUP-2'] })).items[0] as {
      list: string
    }
    expect(labeled.list).toBe('In Progress')
    expect(unlabeled.list).toBe('Backlog')

    const activity = await activityQuery(ctx, {
      actor_kind: 'system',
      limit: 10,
    })
    const ruleMove = activity.events.find((e) => e.verb === 'item.moved')
    expect(ruleMove).toBeDefined()
    expect(ruleMove!.caused_by).toBeTruthy()

    // Loop guard: the rule-caused move produced no further rule executions.
    const systemMoves = activity.events.filter((e) => e.verb === 'item.moved')
    expect(systemMoves).toHaveLength(1)
  })

  /**
   * Editing a rule's logic in place.
   *
   * Update took name and enabled only, so any real change meant delete plus
   * create: a new id, and an audit trail that splits in two exactly where
   * somebody changed a condition. The editor needs to edit.
   */
  it('changes trigger, condition and action in place, keeping the id', async () => {
    const [created] = await ruleWrite(ctx, [
      {
        op: 'create',
        op_id: 'r-edit-1',
        name: 'route bugs',
        trigger: 'item.created',
        condition: 'space=SUP label=Bug',
        action: { kind: 'move_item', list: 'In Progress' },
        enabled: true,
      },
    ])
    const id = (created as { id: string }).id

    await ruleWrite(ctx, [
      {
        op: 'update',
        op_id: 'r-edit-2',
        id,
        trigger: 'item.updated',
        condition: 'space=SUP label=Urgent',
        action: { kind: 'apply_label', label: 'Bug' },
      },
    ])

    const rule = (await ruleList(ctx)).rules.find((r) => r.id === id)
    expect(rule).toBeDefined()
    expect(rule!.trigger).toBe('item.updated')
    expect(rule!.condition).toBe('space=SUP label=Urgent')
    expect(rule!.action).toEqual({ kind: 'apply_label', label: 'Bug' })
    // Untouched fields survive: a partial update is a patch, not a replace.
    expect(rule!.name).toBe('route bugs')
    expect(rule!.enabled).toBe(true)
  })

  it('tells clearing a condition apart from leaving it alone', async () => {
    const [created] = await ruleWrite(ctx, [
      {
        op: 'create',
        op_id: 'r-cond-1',
        name: 'narrow rule',
        trigger: 'item.created',
        condition: 'space=SUP',
        action: { kind: 'complete' },
        enabled: true,
      },
    ])
    const id = (created as { id: string }).id

    // Omitted: untouched.
    await ruleWrite(ctx, [
      { op: 'update', op_id: 'r-cond-2', id, name: 'renamed' },
    ])
    expect(
      (await ruleList(ctx)).rules.find((r) => r.id === id)!.condition,
    ).toBe('space=SUP')

    // Explicit null: cleared, so the rule now matches every event of its
    // trigger. Without the distinction there is no way back to "no
    // condition" once one has been set. The list normalises the stored NULL
    // to undefined, which is the shape the client actually receives.
    await ruleWrite(ctx, [
      { op: 'update', op_id: 'r-cond-3', id, condition: null },
    ])
    expect(
      (await ruleList(ctx)).rules.find((r) => r.id === id)!.condition,
    ).toBeUndefined()
  })

  it('refuses a condition that would silently match nothing', async () => {
    const [created] = await ruleWrite(ctx, [
      {
        op: 'create',
        op_id: 'r-bad-1',
        name: 'rule',
        trigger: 'item.created',
        action: { kind: 'complete' },
        enabled: true,
      },
    ])
    const id = (created as { id: string }).id

    // An unparseable condition matches nothing, so accepting it here would
    // retire a rule that still reads as active in the list.
    const [result] = await ruleWrite(ctx, [
      { op: 'update', op_id: 'r-bad-2', id, condition: 'nonsense' },
    ])
    expect(result.ok).toBe(false)
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
        space: 'SUP',
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

    const item = (await itemGet(ctx, { keys: [created.key] })).items[0] as {
      description: string
      list: string
    }
    expect(item.list).toBe('Backlog')
    expect(item.description).toContain('**From**: John Buser')

    const activity = await activityQuery(ctx, {
      actor_kind: 'agent',
      limit: 10,
    })
    expect(activity.events.some((e) => e.verb === 'item.created')).toBe(true)

    // Bad token is rejected.
    const bad = await app.request('/api/v1/ingest/deadbeef', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(bad.status).toBe(401)
  })

  /**
   * The settings screen had no way to see what existed: there was a create
   * route and nothing else, so the Ingest tab was create-only and a token
   * pasted into a form a year ago could not be found, let alone revoked.
   */
  it('lists tokens with the context needed to decide about them', async () => {
    const admin = await createToken(
      db,
      ctx.workspaceId,
      ctx.actor.id,
      'session',
      ['read', 'write', 'admin'],
    )
    const as = { authorization: `Bearer ${admin}` }
    const mk = async (name: string) =>
      (await (
        await app.request('/api/v1/ingest_tokens', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...as },
          body: JSON.stringify({ name, space: 'SUP', list: 'Backlog' }),
        })
      ).json()) as { token: string; actor_id: string }

    const marketing = await mk('Contact Form (Marketing)')
    await mk('Contact Form (Support)')

    await app.request(`/api/v1/ingest/${marketing.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'from the website' }),
    })

    const body = (await (
      await app.request('/api/v1/ingest_tokens', { headers: as })
    ).json()) as {
      tokens: {
        id: string
        name: string
        space: string
        list: string | null
        items: number
        last_used_at: number | null
      }[]
    }
    expect(body.tokens).toHaveLength(2)
    const row = body.tokens.find((t) => t.name === 'Contact Form (Marketing)')
    expect(row).toBeDefined()
    expect(row?.space).toBe('SUP')
    expect(row?.list).toBe('Backlog')
    // "Never used" is what makes an old token safe to revoke.
    expect(row?.items).toBe(1)
    expect(row?.last_used_at).toBeGreaterThan(0)
    const unused = body.tokens.find((t) => t.name === 'Contact Form (Support)')
    expect(unused?.items).toBe(0)

    // The secret itself is unrecoverable, and must stay that way: only its
    // hash was ever stored, and a list route that could return one would be
    // a far worse bug than the missing list it fixed.
    expect(JSON.stringify(body)).not.toContain(marketing.token)
  })

  it('revoking stops the token but keeps what it already created', async () => {
    const admin = await createToken(
      db,
      ctx.workspaceId,
      ctx.actor.id,
      'session',
      ['read', 'write', 'admin'],
    )
    const as = { authorization: `Bearer ${admin}` }
    const made = (await (
      await app.request('/api/v1/ingest_tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...as },
        body: JSON.stringify({ name: 'Contact form', space: 'SUP' }),
      })
    ).json()) as { token: string; actor_id: string }

    const first = (await (
      await app.request(`/api/v1/ingest/${made.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'before the revoke' }),
      })
    ).json()) as { key: string }

    const listed = (await (
      await app.request('/api/v1/ingest_tokens', { headers: as })
    ).json()) as { tokens: { id: string }[] }
    const cut = await app.request(
      `/api/v1/ingest_tokens/${listed.tokens[0].id}`,
      {
        method: 'DELETE',
        headers: as,
      },
    )
    expect(cut.status).toBe(200)

    // The credential is dead.
    const after = await app.request(`/api/v1/ingest/${made.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'after the revoke' }),
    })
    expect(after.status).toBe(401)

    // The history it wrote is not. Deleting the actor instead would leave a
    // year of contact-form cards attributed to nobody.
    const item = (await itemGet(ctx, { keys: [first.key] })).items[0] as {
      title: string
    }
    expect(item.title).toBe('before the revoke')

    const gone = (await (
      await app.request('/api/v1/ingest_tokens', { headers: as })
    ).json()) as { tokens: unknown[] }
    expect(gone.tokens).toHaveLength(0)
  })
})
