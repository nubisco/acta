/**
 * Inline comments on documents, through every door an agent or the app uses:
 * the service, the REST API and MCP.
 *
 * The property everything here protects: a comment never changes the
 * document it annotates. Anchors live in doc_comment, and the markdown and
 * the rev are left exactly as they were.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { newId } from '@nubisco/acta-shared'
import { createToken } from '../src/core/auth'
import { createApp } from '../src/app'
import { openDb, type BunSqliteDriver } from '../src/db'

const BODY = [
  '# Release plan',
  '',
  'We ship the **audio host** on Friday, after the soak test passes.',
  '',
  '## Risks',
  '',
  '- The licensing service must be reachable, or activation stalls.',
  '- Always run the tests before tagging. Then run the tests again on staging.',
  '',
].join('\n')

let db: BunSqliteDriver
let app: Hono<never>
let agentToken: string
let humanToken: string

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
  humanToken = await createToken(db, ws, jose, 'session', ['read', 'write'])
})

async function rpc(method: string, params?: unknown) {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${agentToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  expect(res.status).toBe(200)
  return res.json() as Promise<{ result?: any; error?: any }>
}

async function call(name: string, args: unknown) {
  const res = await rpc('tools/call', { name, arguments: args })
  expect(res.error).toBeUndefined()
  return JSON.parse(res.result.content[0].text as string)
}

async function rest(path: string, body?: unknown) {
  const res = await app.request(`/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${humanToken}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  return res.json() as Promise<any>
}

async function createDoc(): Promise<void> {
  const created = await call('doc_write', {
    ops: [
      { op: 'create', op_id: 'd1', slug: 'plan', title: 'Plan', body: BODY },
    ],
  })
  expect(created.results[0].ok).toBe(true)
}

describe('inline doc comments over MCP', () => {
  it('offers comments on doc_get and the new ops on doc_write', async () => {
    const list = await rpc('tools/list')
    const tools = list.result.tools as {
      name: string
      description: string
      inputSchema: any
    }[]
    const docGet = tools.find((t) => t.name === 'doc_get')!
    expect(JSON.stringify(docGet.inputSchema)).toContain('comments')
    const docWrite = tools.find((t) => t.name === 'doc_write')!
    expect(JSON.stringify(docWrite.inputSchema)).toContain('comment_resolve')
    expect(docWrite.description).toContain('comment_resolve')
  })

  it('creates by quoting, lists with anchor status, and resolves', async () => {
    await createDoc()
    const made = await call('doc_write', {
      ops: [
        {
          op: 'comment',
          op_id: 'c1',
          ref: 'plan',
          body: 'Is Friday realistic?',
          // Quoted from the rendered page: the bold markers are not there.
          anchor: { exact: 'audio host on Friday' },
        },
      ],
    })
    expect(made.results[0]).toMatchObject({
      ok: true,
      rev: 1,
      anchor_status: 'anchored',
    })
    const id = made.results[0].id

    const read = await call('doc_get', { ref: 'plan', include: ['comments'] })
    expect(read.rev).toBe(1)
    expect(read.body).toBe(BODY)
    expect(read.comments).toHaveLength(1)
    expect(read.comments[0]).toMatchObject({
      id,
      by: 'claude',
      agent: true,
      anchor: { exact: 'audio host on Friday' },
      anchor_status: 'anchored',
    })
    expect(read.comments[0].anchor.prefix).toContain('We ship the')
    expect(read.comments[0].resolved).toBeUndefined()

    const resolved = await call('doc_write', {
      ops: [
        { op: 'comment_resolve', op_id: 'r1', ref: 'plan', comment_id: id },
      ],
    })
    expect(resolved.results[0].ok).toBe(true)
    const after = await call('doc_get', { ref: 'plan', include: ['comments'] })
    expect(after.comments[0].resolved).toMatchObject({ by: 'claude' })
    expect(after.body).toBe(BODY)
    expect(after.rev).toBe(1)

    // And reopened.
    await call('doc_write', {
      ops: [
        {
          op: 'comment_resolve',
          op_id: 'r2',
          ref: 'plan',
          comment_id: id,
          resolved: false,
        },
      ],
    })
    const reopened = await call('doc_get', {
      ref: 'plan',
      include: ['comments'],
    })
    expect(reopened.comments[0].resolved).toBeUndefined()
  })

  it('refuses a quote that is missing or ambiguous, and says why', async () => {
    await createDoc()
    const res = await call('doc_write', {
      ops: [
        {
          op: 'comment',
          op_id: 'c1',
          ref: 'plan',
          body: 'x',
          anchor: { exact: 'on Saturday' },
        },
        {
          op: 'comment',
          op_id: 'c2',
          ref: 'plan',
          body: 'x',
          anchor: { exact: 'run the tests' },
        },
        {
          op: 'comment',
          op_id: 'c3',
          ref: 'plan',
          body: 'Which environment?',
          anchor: { exact: 'run the tests', prefix: 'Then' },
        },
      ],
    })
    expect(res.results[0]).toMatchObject({ ok: false })
    expect(res.results[0].error).toContain('not found')
    expect(res.results[1]).toMatchObject({ ok: false })
    expect(res.results[1].error).toContain('2 times')
    expect(res.results[2]).toMatchObject({
      ok: true,
      anchor_status: 'anchored',
    })
    const read = await call('doc_get', { ref: 'plan', include: ['comments'] })
    // Refused ops wrote nothing.
    expect(read.comments).toHaveLength(1)
    expect(read.comments[0].anchor.prefix).toMatch(/Then $/)
  })

  it('keeps a comment whose text was deleted, marked detached', async () => {
    await createDoc()
    await call('doc_write', {
      ops: [
        {
          op: 'comment',
          op_id: 'c1',
          ref: 'plan',
          body: 'Who owns the licensing fallback?',
          anchor: { exact: 'licensing service must be reachable' },
        },
        { op: 'comment', op_id: 'c2', ref: 'plan', body: 'Page comment.' },
      ],
    })
    const without = BODY.replace(
      '- The licensing service must be reachable, or activation stalls.\n',
      '',
    )
    const replaced = await call('doc_write', {
      ops: [
        { op: 'replace', op_id: 'e1', ref: 'plan', if_rev: 1, body: without },
      ],
    })
    expect(replaced.results[0].ok).toBe(true)

    const read = await call('doc_get', { ref: 'plan', include: ['comments'] })
    expect(read.comments).toHaveLength(2)
    expect(read.comments[0]).toMatchObject({
      body: 'Who owns the licensing fallback?',
      anchor_status: 'detached',
      anchor: { exact: 'licensing service must be reachable' },
    })
    // A page comment has no anchor and so no status.
    expect(read.comments[1].anchor).toBeUndefined()
    expect(read.comments[1].anchor_status).toBeUndefined()

    // Read at the old version, the same comment anchors in that text.
    const old = await call('doc_get', {
      ref: 'plan',
      include: ['comments'],
      at_version: 1,
    })
    expect(old.comments[0].anchor_status).toBe('anchored')
  })

  it('re-anchors after the text around it is edited', async () => {
    await createDoc()
    await call('doc_write', {
      ops: [
        {
          op: 'comment',
          op_id: 'c1',
          ref: 'plan',
          body: 'Define passes.',
          anchor: { exact: 'after the soak test passes' },
        },
      ],
    })
    const edited = `Intro added above.\n\n${BODY.replace('soak test passes', 'soak tests pass')}`
    await call('doc_write', {
      ops: [
        { op: 'replace', op_id: 'e1', ref: 'plan', if_rev: 1, body: edited },
      ],
    })
    const read = await call('doc_get', { ref: 'plan', include: ['comments'] })
    expect(read.comments[0].anchor_status).toBe('anchored')
  })
})

describe('inline doc comments over REST', () => {
  it('stores the app selector as given, even for unsaved text', async () => {
    await createDoc()
    const before = await rest('/docs/plan?include=comments')
    const res = await rest('/docs/write', {
      ops: [
        {
          op: 'comment',
          op_id: 'c1',
          ref: 'plan',
          body: 'On a draft.',
          // Text the app has in its editor but has not saved yet.
          anchor: {
            exact: 'a sentence only in the draft',
            prefix: 'Draft: ',
            suffix: '.',
            start: 7,
            end: 35,
          },
        },
      ],
    })
    expect(res.results[0]).toMatchObject({
      ok: true,
      anchor_status: 'detached',
    })
    const after = await rest('/docs/plan?include=comments')
    expect(after.body).toBe(before.body)
    expect(after.rev).toBe(before.rev)
    expect(after.comments[0]).toMatchObject({
      anchor: {
        exact: 'a sentence only in the draft',
        prefix: 'Draft: ',
        suffix: '.',
        start: 7,
        end: 35,
      },
      anchor_status: 'detached',
    })
  })

  it('validates the anchor shape', async () => {
    await createDoc()
    const res = await app.request('/api/v1/docs/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${humanToken}`,
      },
      body: JSON.stringify({
        ops: [
          {
            op: 'comment',
            op_id: 'c1',
            ref: 'plan',
            body: 'x',
            anchor: { exact: 'Friday', start: 4 },
          },
        ],
      }),
    })
    expect(res.status).toBe(400)
  })

  it('resolves idempotently and 404s an unknown comment', async () => {
    await createDoc()
    const made = await rest('/docs/write', {
      ops: [
        {
          op: 'comment',
          op_id: 'c1',
          ref: 'plan',
          body: 'x',
          anchor: { exact: 'soak test' },
        },
      ],
    })
    const id = made.results[0].id
    const twice = await rest('/docs/write', {
      ops: [
        { op: 'comment_resolve', op_id: 'r1', ref: 'plan', comment_id: id },
        { op: 'comment_resolve', op_id: 'r2', ref: 'plan', comment_id: id },
        {
          op: 'comment_resolve',
          op_id: 'r3',
          ref: 'plan',
          comment_id: 'cmt_missing',
        },
      ],
    })
    expect(twice.results[0].ok).toBe(true)
    expect(twice.results[1].ok).toBe(true)
    expect(twice.results[2].ok).toBe(false)
    const events = await db.query<{ verb: string }>(
      "SELECT verb FROM event WHERE verb = 'comment.resolved'",
    )
    expect(events).toHaveLength(1)
  })
})
