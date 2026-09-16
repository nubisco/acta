/**
 * Page width is stored on the document, and changing it is not an edit.
 *
 * The web reader offers a width toggle to people who may edit the page. What
 * matters here is the contract that toggle relies on: the width persists
 * through the ordinary doc write endpoint, a read-only caller is refused, and
 * the body and rev are untouched, so somebody mid-edit holding `if_rev` is not
 * pushed into a conflict because a colleague widened the page.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { newId } from '@nubisco/acta-shared'
import { createApp } from '../src/app'
import { createToken } from '../src/core/auth'
import { openDb, type BunSqliteDriver } from '../src/db'

let db: BunSqliteDriver
let app: Hono<never>
let writer: string
let reader: string

const BODY =
  '# Runbook\n\n## Restart\n\nDrain first.\n\n```sh\nmake restart\n```\n'

const as = (token: string) => ({ authorization: `Bearer ${token}` })

function write(ops: unknown[], token: string): Promise<Response> {
  return Promise.resolve(
    app.request('/api/v1/docs/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...as(token) },
      body: JSON.stringify({ ops }),
    }),
  )
}

async function read(token = writer) {
  const res = await app.request('/api/v1/docs/runbook', { headers: as(token) })
  expect(res.status).toBe(200)
  return (await res.json()) as { layout?: string; body: string; rev: number }
}

beforeEach(async () => {
  db = await openDb(':memory:')
  app = (await createApp(db, {
    bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
    dataDir: `/tmp/acta-layout-${Math.random().toString(36).slice(2)}`,
  })) as never
  const ws = (await db.query<{ id: string }>('SELECT id FROM workspace'))[0].id
  const jose = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
  writer = await createToken(db, ws, jose, 'session', ['read', 'write'])
  const readerId = newId('act')
  await db.run(
    `INSERT INTO actor (id, workspace_id, kind, handle, name, role, created_at)
     VALUES (?, ?, 'agent', 'reader', 'Reader', 'member', ?)`,
    [readerId, ws, Date.now()],
  )
  reader = await createToken(db, ws, readerId, 'agent', ['read'])
  const created = await write(
    [
      {
        op: 'create',
        op_id: 'c1',
        slug: 'runbook',
        title: 'Runbook',
        body: BODY,
      },
    ],
    writer,
  )
  expect(created.status).toBe(200)
})

describe('doc layout', () => {
  it('persists wide and back through the write API without touching the body', async () => {
    const before = await read()
    expect(before.layout).toBeUndefined()

    const wide = await write(
      [{ op: 'set_layout', op_id: 'l1', ref: 'runbook', layout: 'wide' }],
      writer,
    )
    expect(wide.status).toBe(200)
    const widened = await read()
    expect(widened.layout).toBe('wide')
    expect(widened.body).toBe(BODY)
    expect(widened.rev).toBe(before.rev)

    await write(
      [{ op: 'set_layout', op_id: 'l2', ref: 'runbook', layout: 'default' }],
      writer,
    )
    const back = await read()
    expect(back.layout).toBeUndefined()
    expect(back.body).toBe(BODY)
    expect(back.rev).toBe(before.rev)
  })

  it('refuses a read-only caller and leaves the width as it was', async () => {
    const res = await write(
      [{ op: 'set_layout', op_id: 'r1', ref: 'runbook', layout: 'wide' }],
      reader,
    )
    expect(res.status).toBe(403)
    expect((await read(reader)).layout).toBeUndefined()
  })

  it('does not put an editor holding if_rev into a conflict', async () => {
    const { rev } = await read()
    await write(
      [{ op: 'set_layout', op_id: 'l3', ref: 'runbook', layout: 'wide' }],
      writer,
    )
    const save = await write(
      [
        {
          op: 'replace',
          op_id: 's1',
          ref: 'runbook',
          if_rev: rev,
          body: `${BODY}\nMore.\n`,
        },
      ],
      writer,
    )
    const { results } = (await save.json()) as { results: { ok: boolean }[] }
    expect(results[0].ok).toBe(true)
    expect((await read()).layout).toBe('wide')
  })

  it('rejects a width that is not one of the two', async () => {
    const res = await write(
      [{ op: 'set_layout', op_id: 'x1', ref: 'runbook', layout: 'full' }],
      writer,
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect((await read()).layout).toBeUndefined()
  })
})
