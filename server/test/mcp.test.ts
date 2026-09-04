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

beforeEach(async () => {
  db = await openDb(':memory:')
  app = (await createApp(db, {
    bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
    dataDir: `/tmp/acta-test-${Math.random().toString(36).slice(2)}`,
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
})

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
      'board_get',
      'item_get',
      'item_write',
      'board_write',
      'doc_tree',
      'doc_get',
      'doc_write',
      'search',
      'activity_query',
      'label_write',
      'webhook_write',
      'rule_write',
      'attachment_add',
    ])
    for (const tool of list.result.tools) {
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('runs the support-triage scenario in two calls with agent attribution', async () => {
    await call('board_write', {
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
      default_board: 'SUP',
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

    // Call 1: read the board.
    const board = await call('board_get', { board: 'SUP', state: 'open' })
    expect(board.data.items).toHaveLength(2)
    // The compact response stays cheap (economy guard).
    expect(board.raw.length).toBeLessThan(1200)

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
      'board_write',
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
