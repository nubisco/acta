/**
 * Inbound provider webhooks and outbound Slack delivery.
 *
 * The cases worth the most here are the ones a manual click-through will not
 * find: a forged signature, a redelivered event, and a close arriving for an
 * issue this workspace never saw.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/app'
import { createToken } from '../src/core/auth'
import type { ICtx } from '../src/core/ctx'
import { openDb, type BunSqliteDriver } from '../src/db'
import { boardWrite } from '../src/services/boards'
import { itemWrite } from '../src/services/items'
import { connectionWrite } from '../src/services/connections'
import { webhookWrite } from '../src/services/webhooks'
import { labelWrite } from '../src/services/labels'
import { itemGet } from '../src/services/reads'

let db: BunSqliteDriver
let app: Hono<never>
let ctx: ICtx
let delivered: { url: string; body: string; headers: Record<string, string> }[]
let adminName: string

function fakeFetch(): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    delivered.push({
      url: String(url),
      body: String(init?.body ?? ''),
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    return new Response('ok', { status: 200 })
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
    baseUrl: 'https://acta.example',
  })) as never
  const workspaceId = (
    await db.query<{ id: string }>('SELECT id FROM workspace')
  )[0].id
  const admin = (
    await db.query<{ id: string; name: string }>(
      "SELECT id, name FROM actor WHERE handle = 'jose'",
    )
  )[0]
  adminName = admin.name
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
  await boardWrite(ctx, [
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
  await new Promise((r) => setTimeout(r, 20))
}

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  )
  return `sha256=${Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`
}

async function makeConnection(config?: Record<string, unknown>) {
  const results = await connectionWrite(ctx, [
    {
      op: 'create',
      op_id: `c-${Math.random()}`,
      provider: 'github',
      name: 'GitHub',
      board: 'SUP',
      list: 'Backlog',
      config,
    },
  ])
  const result = results[0] as unknown as {
    ok: true
    id: string
    secret: string
  }
  return result
}

function issueEvent(
  action: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    action,
    issue: {
      id: 4242,
      number: 7,
      title: 'Login button does nothing',
      body: 'Steps:\n1. click\n2. nothing',
      html_url: 'https://github.com/nubisco/acta/issues/7',
      user: { login: 'someone' },
      ...(overrides.issue ?? {}),
    },
    repository: { full_name: 'nubisco/acta' },
    ...overrides,
  })
}

async function post(
  id: string,
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  return app.request(`/api/v1/hooks/github/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

describe('github connection', () => {
  it('rejects a forged signature without writing anything', async () => {
    const connection = await makeConnection()
    const body = issueEvent('opened')
    const res = await post(connection.id, body, {
      'x-github-event': 'issues',
      'x-github-delivery': 'd1',
      'x-hub-signature-256': await sign('wrong-secret', body),
    })
    expect(res.status).toBe(401)
    const items = await db.query('SELECT id FROM item')
    expect(items).toHaveLength(0)
    // The failure is visible to an admin rather than silent.
    const row = await db.query<{ last_error: string }>(
      'SELECT last_error FROM connection WHERE id = ?',
      [connection.id],
    )
    expect(row[0].last_error).toContain('signature')
  })

  it('rejects a missing signature header', async () => {
    const connection = await makeConnection()
    const res = await post(connection.id, issueEvent('opened'), {
      'x-github-event': 'issues',
    })
    expect(res.status).toBe(401)
  })

  it('creates a card from an opened issue and links it', async () => {
    const connection = await makeConnection()
    const body = issueEvent('opened')
    const res = await post(connection.id, body, {
      'x-github-event': 'issues',
      'x-github-delivery': 'd1',
      'x-hub-signature-256': await sign(connection.secret, body),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { key: string; created: boolean }
    expect(json.created).toBe(true)

    const { items } = await itemGet(ctx, { keys: [json.key] })
    expect(items[0].title).toBe('Login button does nothing')
    expect(items[0].list).toBe('Backlog')
    // The issue text is quoted, so later notes stay distinguishable from it.
    expect(items[0].description).toContain('nubisco/acta#7')
    expect(items[0].description).toContain('> Steps:')

    const link = await db.query<{ external_id: string; url: string }>(
      'SELECT external_id, url FROM external_link',
    )
    expect(link).toHaveLength(1)
    expect(link[0].external_id).toBe('4242')
    expect(link[0].url).toBe('https://github.com/nubisco/acta/issues/7')
  })

  it('attributes the card to the connection, not to a person', async () => {
    const connection = await makeConnection()
    const body = issueEvent('opened')
    await post(connection.id, body, {
      'x-github-event': 'issues',
      'x-github-delivery': 'd1',
      'x-hub-signature-256': await sign(connection.secret, body),
    })
    const rows = await db.query<{ kind: string; name: string }>(
      `SELECT a.kind, a.name FROM item i JOIN actor a ON a.id = i.created_by`,
    )
    expect(rows[0].kind).toBe('agent')
    expect(rows[0].name).toBe('GitHub')
  })

  it('does not duplicate on redelivery of the same event', async () => {
    const connection = await makeConnection()
    const body = issueEvent('opened')
    const headers = {
      'x-github-event': 'issues',
      'x-github-delivery': 'same-guid',
      'x-hub-signature-256': await sign(connection.secret, body),
    }
    await post(connection.id, body, headers)
    await post(connection.id, body, headers)
    expect(await db.query('SELECT id FROM item')).toHaveLength(1)
  })

  it('closes and reopens the linked card, and survives close-reopen-close', async () => {
    const connection = await makeConnection()
    const opened = issueEvent('opened')
    await post(connection.id, opened, {
      'x-github-event': 'issues',
      'x-github-delivery': 'd1',
      'x-hub-signature-256': await sign(connection.secret, opened),
    })

    const send = async (action: string, guid: string) => {
      const body = issueEvent(action)
      return post(connection.id, body, {
        'x-github-event': 'issues',
        'x-github-delivery': guid,
        'x-hub-signature-256': await sign(connection.secret, body),
      })
    }
    // `done` is true or absent, never false, so compare truthiness.
    const done = async () =>
      Boolean((await itemGet(ctx, { keys: ['SUP-1'] })).items[0].done)

    await send('closed', 'd2')
    expect(await done()).toBe(true)
    await send('reopened', 'd3')
    expect(await done()).toBe(false)
    // The second close carries a new delivery guid, so it must not be
    // swallowed as a duplicate of the first.
    await send('closed', 'd4')
    expect(await done()).toBe(true)
    expect(await db.query('SELECT id FROM item')).toHaveLength(1)
  })

  it('retitles the card when the issue title is edited', async () => {
    const connection = await makeConnection()
    const opened = issueEvent('opened')
    await post(connection.id, opened, {
      'x-github-event': 'issues',
      'x-github-delivery': 'd1',
      'x-hub-signature-256': await sign(connection.secret, opened),
    })
    const edited = issueEvent('edited', {
      issue: { id: 4242, number: 7, title: 'Login button is dead' },
    })
    await post(connection.id, edited, {
      'x-github-event': 'issues',
      'x-github-delivery': 'd2',
      'x-hub-signature-256': await sign(connection.secret, edited),
    })
    const { items } = await itemGet(ctx, { keys: ['SUP-1'] })
    expect(items[0].title).toBe('Login button is dead')
  })

  it('ignores a close for an issue it never saw opened', async () => {
    const connection = await makeConnection()
    const body = issueEvent('closed')
    const res = await post(connection.id, body, {
      'x-github-event': 'issues',
      'x-github-delivery': 'd1',
      'x-hub-signature-256': await sign(connection.secret, body),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { ignored: string }).toHaveProperty('ignored')
    expect(await db.query('SELECT id FROM item')).toHaveLength(0)
  })

  it('acknowledges pings and unhandled events instead of erroring', async () => {
    const connection = await makeConnection()
    const body = JSON.stringify({ zen: 'hello' })
    const ping = await post(connection.id, body, {
      'x-github-event': 'ping',
      'x-hub-signature-256': await sign(connection.secret, body),
    })
    expect(ping.status).toBe(200)

    const push = await post(connection.id, body, {
      'x-github-event': 'push',
      'x-hub-signature-256': await sign(connection.secret, body),
    })
    expect(push.status).toBe(200)
    expect(await db.query('SELECT id FROM item')).toHaveLength(0)
  })

  it('honours a repository allow-list', async () => {
    const connection = await makeConnection({ repos: ['nubisco/other'] })
    const body = issueEvent('opened')
    const res = await post(connection.id, body, {
      'x-github-event': 'issues',
      'x-github-delivery': 'd1',
      'x-hub-signature-256': await sign(connection.secret, body),
    })
    expect(res.status).toBe(200)
    expect(await db.query('SELECT id FROM item')).toHaveLength(0)
  })

  it('applies the connection labels to created cards', async () => {
    await labelWrite(ctx, [
      { op: 'group_create', op_id: 'g1', name: 'Source' },
      {
        op: 'label_create',
        op_id: 'l1',
        group: 'Source',
        name: 'github',
        color: 'gray',
      },
    ])
    const connection = await makeConnection({ labels: ['github'] })
    const body = issueEvent('opened')
    await post(connection.id, body, {
      'x-github-event': 'issues',
      'x-github-delivery': 'd1',
      'x-hub-signature-256': await sign(connection.secret, body),
    })
    const { items } = await itemGet(ctx, { keys: ['SUP-1'] })
    expect(items[0].labels).toContain('github')
  })

  it('refuses a disabled connection', async () => {
    const connection = await makeConnection()
    await db.run('UPDATE connection SET enabled = 0 WHERE id = ?', [
      connection.id,
    ])
    const body = issueEvent('opened')
    const res = await post(connection.id, body, {
      'x-github-event': 'issues',
      'x-github-delivery': 'd1',
      'x-hub-signature-256': await sign(connection.secret, body),
    })
    expect(res.status).toBe(404)
  })
})

describe('slack webhooks', () => {
  it('posts Block Kit that Slack will accept, not our own envelope', async () => {
    await webhookWrite(ctx, [
      {
        op: 'create',
        op_id: 'w1',
        url: 'https://hooks.slack.test/services/x',
        events: ['item.moved'],
        format: 'slack',
      },
    ])
    await itemWrite(
      ctx,
      [{ op: 'create', op_id: 'i1', list: 'Backlog', title: 'Ship it' }],
      'SUP',
    )
    await itemWrite(ctx, [
      { op: 'move', op_id: 'i2', key: 'SUP-1', list: 'In Progress' },
    ])
    await settle()

    expect(delivered).toHaveLength(1)
    const payload = JSON.parse(delivered[0].body)
    // `text` is what Slack shows in the notification preview; a payload with
    // blocks but no text arrives as an empty notification.
    expect(typeof payload.text).toBe('string')
    expect(payload.text).toContain(adminName)
    expect(payload.text).toContain('moved SUP-1')
    expect(payload.blocks[0].type).toBe('section')
    expect(payload.blocks[0].text.text).toContain(
      '<https://acta.example/?item=SUP-1|SUP-1>',
    )
    // None of the generic envelope's keys should be present.
    expect(payload.event).toBeUndefined()
    expect(payload.entity).toBeUndefined()
  })

  it('does not sign Slack deliveries, since Slack checks no signature', async () => {
    await webhookWrite(ctx, [
      {
        op: 'create',
        op_id: 'w1',
        url: 'https://hooks.slack.test/services/x',
        events: ['item.*'],
        secret: 'unused',
        format: 'slack',
      },
    ])
    await itemWrite(
      ctx,
      [{ op: 'create', op_id: 'i1', list: 'Backlog', title: 'Ship it' }],
      'SUP',
    )
    await settle()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].headers['x-acta-signature']).toBeUndefined()
  })

  it('leaves generic webhooks on the original envelope', async () => {
    await webhookWrite(ctx, [
      {
        op: 'create',
        op_id: 'w1',
        url: 'https://example.test/hook',
        events: ['item.*'],
      },
    ])
    await itemWrite(
      ctx,
      [{ op: 'create', op_id: 'i1', list: 'Backlog', title: 'Ship it' }],
      'SUP',
    )
    await settle()
    const payload = JSON.parse(delivered[0].body)
    expect(payload.event).toBe('item.created')
    expect(payload.blocks).toBeUndefined()
  })
})

describe('ingest attachments', () => {
  it('keeps a long log as a file instead of truncating the description', async () => {
    const created = await app.request('/api/v1/ingest_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await tokenFor()}`,
      },
      body: JSON.stringify({ name: 'Contact form', board: 'SUP' }),
    })
    const { token } = (await created.json()) as { token: string }

    const log = 'stack frame\n'.repeat(5000)
    const res = await app.request(`/api/v1/ingest/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Engine crashed',
        description: 'Excerpt only.',
        attachments: [{ filename: 'engine.log', text: log }],
      }),
    })
    const json = (await res.json()) as { key: string; attached?: string[] }
    expect(json.attached).toEqual(['engine.log'])

    const { items } = await itemGet(ctx, { keys: [json.key] })
    expect(items[0].description).toBe('Excerpt only.')
    const attachment = (
      items[0].attachments as { filename: string; size: number }[] | undefined
    )?.[0]
    expect(attachment?.filename).toBe('engine.log')
    expect(attachment?.size).toBe(new TextEncoder().encode(log).byteLength)
  })

  it('still creates the ticket when a label does not exist', async () => {
    const created = await app.request('/api/v1/ingest_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await tokenFor()}`,
      },
      body: JSON.stringify({ name: 'Contact form labels', board: 'SUP' }),
    })
    const { token } = (await created.json()) as { token: string }
    const res = await app.request(`/api/v1/ingest/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'A support request',
        labels: ['no-such-label'],
      }),
    })
    const json = (await res.json()) as {
      ok: boolean
      key: string
      labels_failed?: boolean
    }
    // The ticket survives the bad label, and the caller is told about it.
    expect(json.ok).toBe(true)
    expect(json.labels_failed).toBe(true)
    const { items } = await itemGet(ctx, { keys: [json.key] })
    expect(items[0].title).toBe('A support request')
  })

  it('still creates the card when an attachment cannot be stored', async () => {
    const created = await app.request('/api/v1/ingest_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await tokenFor()}`,
      },
      body: JSON.stringify({ name: 'Contact form 2', board: 'SUP' }),
    })
    const { token } = (await created.json()) as { token: string }
    const res = await app.request(`/api/v1/ingest/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Still a ticket',
        // An empty file is refused by the attachment path, which is exactly
        // the shape of failure that must not cost us the ticket.
        attachments: [{ filename: 'x.log', text: ' ' }],
      }),
    })
    const json = (await res.json()) as { ok: boolean; key: string }
    expect(json.ok).toBe(true)
    const { items } = await itemGet(ctx, { keys: [json.key] })
    expect(items[0].title).toBe('Still a ticket')
  })
})

/** An admin bearer token, for the REST-only endpoints. */
async function tokenFor(): Promise<string> {
  return createToken(db, ctx.workspaceId, ctx.actor.id, 'agent', [
    'read',
    'write',
    'admin',
  ])
}
