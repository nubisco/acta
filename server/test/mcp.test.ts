import { beforeEach, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { createToken } from '../src/core/auth'
import { createApp } from '../src/app'
import { openDb, type BunSqliteDriver } from '../src/db'
import { newId } from '@nubisco/acta-shared'

let db: BunSqliteDriver
let app: Hono<never>
let agentToken: string

async function rpc(method: string, params?: unknown, token = agentToken) {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  expect(res.status).toBe(200)
  return res.json() as Promise<{ result?: any; error?: any }>
}

async function call(name: string, args: unknown, token = agentToken) {
  const res = await rpc('tools/call', { name, arguments: args }, token)
  expect(res.error).toBeUndefined()
  const content = res.result.content[0].text as string
  let data: any
  try {
    data = JSON.parse(content)
  } catch {
    data = content
  }
  return { data, isError: res.result.isError === true, raw: content }
}

async function boot(baseUrl?: string) {
  db = await openDb(':memory:')
  app = (await createApp(db, {
    bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
    dataDir: `/tmp/acta-test-${Math.random().toString(36).slice(2)}`,
    baseUrl,
  })) as never
  const ws = (await db.query<{ id: string }>('SELECT id FROM workspace'))[0].id
  const jose = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
  const agentId = newId('act')
  await db.run(
    `INSERT INTO actor (id, workspace_id, kind, handle, name, role, on_behalf_of, created_at)
     VALUES (?, ?, 'agent', 'claude', 'Claude', 'member', ?, ?)`,
    [agentId, ws, jose, Date.now()],
  )
  agentToken = await createToken(db, ws, agentId, 'agent', ['read', 'write'])
}

beforeEach(() => boot())

describe('mcp endpoint', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(401)
  })

  it('initializes and lists tools with schemas', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    expect(init.result.serverInfo.name).toBe('acta')
    const list = await rpc('tools/list')
    const names = list.result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual([
      'workspace_overview',
      'space_get',
      'item_get',
      'item_write',
      'goal_list',
      'goal_get',
      'goal_write',
      'space_write',
      'doc_tree',
      'doc_get',
      'doc_write',
      'search',
      'activity_query',
      'response_times',
      'label_write',
      'webhook_write',
      'rule_write',
      'attachment_add',
      'attachment_add_batch',
      'attachment_delete',
    ])
    for (const tool of list.result.tools) {
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('says it is Acta, with its own icon, and which tools only read', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    const info = init.result.serverInfo
    expect(info.title).toBe('Acta')
    expect(info.websiteUrl).toBe('http://localhost')
    expect(info.icons[0]).toEqual({
      src: 'http://localhost/acta-icon.svg',
      mimeType: 'image/svg+xml',
      sizes: ['any'],
    })

    const list = await rpc('tools/list')
    const readOnly = list.result.tools
      .filter((t: any) => t.annotations?.readOnlyHint === true)
      .map((t: any) => t.name)
    expect(readOnly).toEqual([
      'workspace_overview',
      'space_get',
      'item_get',
      'goal_list',
      'goal_get',
      'doc_tree',
      'doc_get',
      'search',
      'activity_query',
      'response_times',
    ])
  })

  it('runs the support-triage scenario in two calls with agent attribution', async () => {
    await call('space_write', {
      ops: [
        {
          op: 'create',
          op_id: 'b1',
          key: 'SUP',
          name: 'Support',
          template: 'kanban6',
        },
      ],
    })
    await call('item_write', {
      default_space: 'SUP',
      ops: [
        {
          op: 'create',
          op_id: 's1',
          list: 'Backlog',
          title: '[Support] John - crash on load',
        },
        {
          op: 'create',
          op_id: 's2',
          list: 'Backlog',
          title: '[Support] Vasco - export bug',
        },
      ],
    })

    // Call 1: read the space.
    const space = await call('space_get', { space: 'SUP', state: 'open' })
    expect(space.data.items).toHaveLength(2)
    // The compact response stays cheap (economy guard).
    expect(space.raw.length).toBeLessThan(1200)

    // Call 2: triage both in one batch.
    const triage = await call('item_write', {
      ops: [
        { op: 'move', op_id: 't1', key: 'SUP-1', list: 'In Progress' },
        {
          op: 'comment',
          op_id: 't2',
          key: 'SUP-1',
          body: 'Reproduced; fix in 1.0.3.',
        },
        { op: 'move', op_id: 't3', key: 'SUP-2', list: 'In Progress' },
      ],
    })
    expect(triage.data.results.every((r: { ok: boolean }) => r.ok)).toBe(true)

    // Attribution: the writes are recorded as the agent, on behalf of jose.
    const activity = await call('activity_query', { actor_kind: 'agent' })
    expect(activity.data.events.length).toBeGreaterThan(0)
    expect(activity.data.events[0].on_behalf_of).toBeTruthy()
  })

  it('reports response times per label, and the agent that filed a card never answers it', async () => {
    const ws = (await db.query<{ id: string }>('SELECT id FROM workspace'))[0]
      .id
    const jose = (
      await db.query<{ id: string }>(
        "SELECT id FROM actor WHERE handle = 'jose'",
      )
    )[0].id
    const human = await createToken(db, ws, jose, 'session', ['read', 'write'])
    await call('space_write', {
      ops: [
        {
          op: 'create',
          op_id: 'rt-s',
          key: 'SUP',
          name: 'Support',
          template: 'kanban6',
        },
      ],
    })
    await call('label_write', {
      ops: [
        { op: 'group_create', op_id: 'rt-g', name: 'Need' },
        {
          op: 'label_create',
          op_id: 'rt-l',
          group: 'Need',
          name: 'Bug report',
        },
      ],
    })
    await call('item_write', {
      default_space: 'SUP',
      ops: [
        {
          op: 'create',
          op_id: 'rt-1',
          list: 'Backlog',
          title: 'Crash on load',
          labels: ['Need/Bug report'],
        },
        { op: 'comment', op_id: 'rt-2', key: 'SUP-1', body: 'Thanks, filed.' },
      ],
    })
    const waiting = await call('response_times', { space: 'SUP' })
    expect(waiting.isError).toBe(false)
    expect(waiting.data.spaces[0].labels[0]).toMatchObject({
      group: 'Need',
      name: 'Bug report',
      received: 1,
      unanswered: 1,
      first_response: { count: 0, median_ms: null, p90_ms: null },
    })

    await call(
      'item_write',
      {
        ops: [{ op: 'comment', op_id: 'rt-3', key: 'SUP-1', body: 'Looking.' }],
      },
      human,
    )
    const answered = await call('response_times', { space: 'SUP' })
    const bug = answered.data.spaces[0].labels[0]
    expect(bug.unanswered).toBe(0)
    expect(bug.first_response.count).toBe(1)
    expect(bug.first_response.median_ms).toBeGreaterThanOrEqual(0)

    // The REST route answers the same question the same way.
    const res = await app.request('/api/v1/response-times?space=SUP', {
      headers: { authorization: `Bearer ${human}` },
    })
    expect(res.status).toBe(200)
    const rest = (await res.json()) as typeof answered.data
    expect(rest.spaces[0].labels[0].first_response.count).toBe(1)

    const bad = await call('response_times', { space: 'SUP', from: 10, to: 5 })
    expect(bad.isError).toBe(true)
  })

  it('edits one doc section without transferring the whole doc', async () => {
    const body = [
      '# Product',
      '',
      ...Array.from({ length: 60 }, (_, i) => `Filler line ${i}.`),
      '',
      '## Status',
      '',
      'Old status.',
    ].join('\n')
    await call('doc_write', {
      ops: [
        { op: 'create', op_id: 'd1', slug: 'product', title: 'Product', body },
      ],
    })
    const doc = await call('doc_get', { ref: 'product', include: ['sections'] })
    const status = doc.data.sections.find(
      (s: { slug: string }) => s.slug === 'status',
    )
    const patch = await call('doc_write', {
      ops: [
        {
          op: 'patch_section',
          op_id: 'd2',
          ref: 'product',
          section: 'status',
          if_hash: status.hash,
          body: '## Status\n\nShipped 1.0.',
          mode: 'replace',
        },
      ],
    })
    expect(patch.data.results[0].ok).toBe(true)
    // Economy: the patch payload is a fraction of the document size.
    expect(
      JSON.stringify({ section: 'status', body: '## Status\n\nShipped 1.0.' })
        .length,
    ).toBeLessThan(body.length * 0.15)
    const after = await call('doc_get', { ref: 'product' })
    expect(after.data.body).toContain('Shipped 1.0.')
    expect(after.data.body).toContain('Filler line 59.')
  })

  it('enforces write scope', async () => {
    const ws = (await db.query<{ id: string }>('SELECT id FROM workspace'))[0]
      .id
    const readerId = newId('act')
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, role, created_at)
       VALUES (?, ?, 'agent', 'reader', 'Reader', 'member', ?)`,
      [readerId, ws, Date.now()],
    )
    const readonly = await createToken(db, ws, readerId, 'agent', ['read'])
    const result = await call(
      'space_write',
      {
        ops: [
          { op: 'create', op_id: 'x', key: 'XX', name: 'X', template: 'none' },
        ],
      },
      readonly,
    )
    expect(result.isError).toBe(true)
    const read = await call('workspace_overview', {}, readonly)
    expect(read.isError).toBe(false)
  })
})

/*
 * An agent is somebody too. Writes over MCP go through the same services as
 * the UI's, so the people they concern have to hear about them the same way,
 * through the same endpoints the bell reads.
 */
describe('notifications from an agent', () => {
  let ivanToken: string
  let joseToken: string

  const asHuman = (path: string, token: string, init: RequestInit = {}) =>
    app.request(`/api/v1/w/nubisco${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
    })

  beforeEach(async () => {
    const ws = (await db.query<{ id: string }>('SELECT id FROM workspace'))[0]
      .id
    const jose = (
      await db.query<{ id: string }>(
        "SELECT id FROM actor WHERE handle = 'jose'",
      )
    )[0].id
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, created_at)
       VALUES ('act_ivan', ?, 'human', 'ivan', 'Ivan', 'ivan@nubisco.io', 'member', ?)`,
      [ws, Date.now()],
    )
    ivanToken = await createToken(db, ws, 'act_ivan', 'session', [
      'read',
      'write',
    ])
    joseToken = await createToken(db, ws, jose, 'session', ['read', 'write'])
    await call('space_write', {
      ops: [{ op: 'create', op_id: 'b1', key: 'SUP', name: 'Support' }],
    })
  })

  it('reaches the person an agent assigns or names, and only them', async () => {
    await call('item_write', {
      default_space: 'SUP',
      ops: [
        { op: 'create', op_id: 'i1', list: 'Backlog', title: 'Crash' },
        { op: 'assign', op_id: 'a1', key: 'SUP-1', add: ['ivan'] },
        {
          op: 'comment',
          op_id: 'c1',
          key: 'SUP-1',
          body: 'Repro attached, @Ivan',
        },
      ],
    })

    const res = await asHuman('/notifications', ivanToken)
    expect(res.status).toBe(200)
    const inbox = (await res.json()) as {
      notifications: {
        id: string
        verb: string
        reason: string
        actor_handle: string
      }[]
      unread: number
    }
    expect(inbox.notifications.map((n) => n.verb).sort()).toEqual([
      'comment.created',
      'item.assigned',
    ])
    expect(
      inbox.notifications.find((n) => n.verb === 'comment.created')?.reason,
    ).toBe('mention')
    // The face on the row is the agent's, not the person it acts for.
    expect(inbox.notifications[0].actor_handle).toBe('claude')
    expect(inbox.unread).toBe(2)

    // Nobody else's inbox fills up with it.
    const other = (await (
      await asHuman('/notifications', joseToken)
    ).json()) as { notifications: unknown[]; unread: number }
    expect(other.notifications).toHaveLength(0)
    expect(other.unread).toBe(0)

    // Marking one read is that person's, and the count follows.
    await asHuman('/notifications/read', ivanToken, {
      method: 'POST',
      body: JSON.stringify({ id: inbox.notifications[0].id }),
    })
    const after = (await (
      await asHuman('/notifications', ivanToken)
    ).json()) as { unread: number }
    expect(after.unread).toBe(1)
    await asHuman('/notifications/read', ivanToken, {
      method: 'POST',
      body: '{}',
    })
    const cleared = (await (
      await asHuman('/notifications', ivanToken)
    ).json()) as { unread: number }
    expect(cleared.unread).toBe(0)
  })

  it('puts an agent write on the live stream the bell re-reads from', async () => {
    const abort = new AbortController()
    const res = await app.request('/api/v1/w/nubisco/events/stream', {
      headers: { authorization: `Bearer ${ivanToken}` },
      signal: abort.signal,
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    await call('item_write', {
      default_space: 'SUP',
      ops: [
        { op: 'create', op_id: 'i1', list: 'Backlog', title: 'Crash' },
        { op: 'assign', op_id: 'a1', key: 'SUP-1', add: ['ivan'] },
      ],
    })

    let seen = ''
    while (!seen.includes('item.assigned')) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value)
    }
    abort.abort()
    expect(seen).toContain('"verb":"item.assigned"')
    // The frame says that something happened, never what anybody was told:
    // the inbox itself is only ever read per person, over GET.
    expect(seen).not.toContain('ivan')
  })
})

describe('where things open in the web app', () => {
  it('states the address templates once, in the bootstrap read and the instructions', async () => {
    await boot('https://acta.example.com/')
    const overview = await call('workspace_overview', {})
    expect(overview.data.url_templates).toEqual({
      item: 'https://acta.example.com/nubisco/s/{space}?item={key}',
      goal: 'https://acta.example.com/nubisco/goals/{number}',
      doc: 'https://acta.example.com/nubisco/docs/{slug}',
    })
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    expect(init.result.instructions).toContain(
      'https://acta.example.com/nubisco/s/{space}?item={key}',
    )
    // The instance's own address, not whichever host the request came in on.
    expect(init.result.serverInfo.websiteUrl).toBe('https://acta.example.com')

    // Rows stay as compact as they were.
    await call('space_write', {
      ops: [
        {
          op: 'create',
          op_id: 'b1',
          key: 'CM',
          name: 'Core',
          template: 'kanban6',
        },
      ],
    })
    await call('item_write', {
      default_space: 'CM',
      ops: [{ op: 'create', op_id: 'i1', list: 'Backlog', title: 'Card' }],
    })
    const space = await call('space_get', { space: 'CM' })
    expect(space.raw).not.toContain('acta.example.com')
  })

  it('gives no templates when the instance has no address configured', async () => {
    const overview = await call('workspace_overview', {})
    expect(overview.data.url_templates).toBeUndefined()
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    expect(init.result.instructions).not.toContain('templates')
  })
})
