/**
 * Walkthroughs remembered per person, not per browser.
 *
 * Asked for by Jose on 2026-10-08: a goals walkthrough that plays the first
 * time someone opens goals, a notifications one, and a settings tab that
 * shows each one's state and resets it. The state lives on the actor so a
 * second browser does not replay what was already seen.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/app'
import { createToken } from '../src/core/auth'
import { openDb, type BunSqliteDriver } from '../src/db'

let db: BunSqliteDriver
let app: Hono<never>
let headers: Record<string, string>

beforeEach(async () => {
  db = await openDb(':memory:')
  app = (await createApp(db, {
    bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
    dataDir: `/tmp/acta-walk-${Math.random().toString(36).slice(2)}`,
  })) as never
  const ws = (await db.query<{ id: string }>('SELECT id FROM workspace'))[0].id
  const me = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
  const token = await createToken(db, ws, me, 'session', ['read', 'write'])
  headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  }
})

async function read(): Promise<Record<string, unknown>> {
  const res = await app.request('/api/v1/auth/me/walkthroughs', { headers })
  expect(res.status).toBe(200)
  return ((await res.json()) as { walkthroughs: Record<string, unknown> })
    .walkthroughs
}

const record = {
  version: 1,
  outcome: 'finish',
  completedAt: '2026-10-08T19:00:00.000Z',
}

describe('walkthrough state', () => {
  it('starts empty, records an outcome, and forgets it on reset', async () => {
    expect(await read()).toEqual({})

    const put = await app.request('/api/v1/auth/me/walkthroughs/acta-goals', {
      method: 'PUT',
      headers,
      body: JSON.stringify(record),
    })
    expect(put.status).toBe(200)
    await app.request('/api/v1/auth/me/walkthroughs/acta-intro', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...record, outcome: 'skip', version: 2 }),
    })
    expect(await read()).toEqual({
      'acta-goals': record,
      'acta-intro': { ...record, outcome: 'skip', version: 2 },
    })

    await app.request('/api/v1/auth/me/walkthroughs/acta-goals', {
      method: 'DELETE',
      headers,
    })
    expect(Object.keys(await read())).toEqual(['acta-intro'])
  })

  it('refuses a malformed id or record', async () => {
    const badId = await app.request('/api/v1/auth/me/walkthroughs/Bad%20Id', {
      method: 'PUT',
      headers,
      body: JSON.stringify(record),
    })
    expect(badId.status).toBe(400)
    const badRecord = await app.request(
      '/api/v1/auth/me/walkthroughs/acta-goals',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ version: 1, outcome: 'maybe' }),
      },
    )
    expect(badRecord.status).toBe(400)
    expect(await read()).toEqual({})
  })

  it('needs a signed-in person', async () => {
    const res = await app.request('/api/v1/auth/me/walkthroughs')
    expect(res.status).toBe(401)
  })
})
