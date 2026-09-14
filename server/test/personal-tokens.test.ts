/**
 * Personal access tokens: the API and MCP as yourself.
 *
 * Acta's only bearer token was the agent token, which is admin-minted and
 * gets an actor of its own, so everything done through one is attributed to a
 * bot. That is right for an autonomous agent and wrong for the ordinary case:
 * a person pointing their own editor at their own workspace. The attribution
 * assertions below are the point of the feature, not a detail of it.
 *
 * The rest is containment. A token pasted into a config file is the most
 * likely credential to leak, so what it cannot do matters more than what it
 * can, and none of those limits is visible in ordinary use.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/app'
import { openDb, type BunSqliteDriver } from '../src/db'
import { createToken } from '../src/core/auth'

let db: BunSqliteDriver
let app: Hono<never>
let session: string
let workspaceId: string
let joseId: string

const as = (token: string) => ({ authorization: `Bearer ${token}` })

const post = (path: string, body: unknown, token: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...as(token) },
    body: JSON.stringify(body),
  })

async function mint(
  label = 'laptop',
  scopes: string[] = ['read', 'write'],
  token = session,
): Promise<Response> {
  return post('/api/v1/auth/me/tokens', { label, scopes }, token)
}

beforeEach(async () => {
  db = await openDb(':memory:')
  app = (await createApp(db, {
    bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
    dataDir: `/tmp/acta-pat-${Math.random().toString(36).slice(2)}`,
  })) as never
  workspaceId = (await db.query<{ id: string }>('SELECT id FROM workspace'))[0]
    .id
  joseId = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
  session = await createToken(db, workspaceId, joseId, 'session', [
    'read',
    'write',
    'admin',
  ])
})

describe('personal access tokens', () => {
  it('is minted once, shown once, and carries a recognisable prefix', async () => {
    const res = await mint()
    expect(res.status).toBe(201)
    const body = (await res.json()) as { token: string }
    // Secret scanners match on prefixes, and so do people reading a diff.
    expect(body.token.startsWith('acta_pat_')).toBe(true)

    // Stored hashed: the listing can never hand it back.
    const listed = (await (
      await app.request('/api/v1/auth/me/tokens', { headers: as(session) })
    ).json()) as { tokens: { id: string; label: string; scopes: string[] }[] }
    expect(JSON.stringify(listed)).not.toContain(body.token)
    expect(listed.tokens[0]).toMatchObject({
      label: 'laptop',
      scopes: ['read', 'write'],
    })
  })

  it('acts as the person who minted it, not as a bot', async () => {
    const { token } = (await (await mint()).json()) as { token: string }
    const me = (await (
      await app.request('/api/v1/auth/me', { headers: as(token) })
    ).json()) as { handle: string; kind: string }
    expect(me).toMatchObject({ handle: 'jose', kind: 'human' })
  })

  it('attributes the work to the person, which is the whole point', async () => {
    const { token } = (await (await mint()).json()) as { token: string }
    await post(
      '/api/v1/spaces/write',
      {
        ops: [{ op: 'create', op_id: 's1', key: 'ENG', name: 'Engineering' }],
      },
      session,
    )
    const write = await post(
      '/api/v1/items/write',
      {
        ops: [
          {
            op: 'create',
            op_id: 'op-1',
            space: 'ENG',
            list: 'To Do',
            title: 'Written through a personal token',
          },
        ],
      },
      token,
    )
    expect(write.status).toBe(200)
    expect(
      ((await write.json()) as { results: { ok: boolean }[] }).results[0].ok,
    ).toBe(true)
    const events = await db.query<{ actor_id: string }>(
      "SELECT actor_id FROM event WHERE verb LIKE 'item.%' ORDER BY ts DESC LIMIT 1",
    )
    expect(events[0].actor_id).toBe(joseId)
    // And no second actor appeared to take the credit.
    const actors = await db.query("SELECT id FROM actor WHERE kind = 'agent'")
    expect(actors).toHaveLength(0)
  })

  it('never carries admin, even when the person is an admin', async () => {
    const { token } = (await (await mint()).json()) as { token: string }
    const me = (await (
      await app.request('/api/v1/auth/me', { headers: as(token) })
    ).json()) as { role: string; scopes: string[] }
    expect(me.role).toBe('admin')
    expect(me.scopes).not.toContain('admin')

    // Concretely: it cannot mint an agent token, which is the escalation
    // that would make a leaked token permanent.
    const escalate = await post(
      '/api/v1/tokens',
      { name: 'a bot of my own' },
      token,
    )
    expect(escalate.status).toBe(403)
  })

  it('cannot mint another token', async () => {
    const { token } = (await (await mint()).json()) as { token: string }
    // Otherwise revoking a leaked token means nothing: whoever had it has
    // already minted a second one you have never seen.
    expect((await mint('copy', ['read', 'write'], token)).status).toBe(403)
  })

  it('honours read-only when that is what was asked for', async () => {
    const res = await mint('ci', ['read'])
    const { token } = (await res.json()) as { token: string }
    await post(
      '/api/v1/spaces/write',
      { ops: [{ op: 'create', op_id: 's1', key: 'OPS', name: 'Ops' }] },
      session,
    )
    const write = await post(
      '/api/v1/items/write',
      {
        ops: [
          {
            op: 'create',
            op_id: 'o1',
            space: 'OPS',
            list: 'To Do',
            title: 'x',
          },
        ],
      },
      token,
    )
    expect(write.status).toBe(403)
    expect(
      (await app.request('/api/v1/overview', { headers: as(token) })).status,
    ).toBe(200)
  })

  it('works on the MCP endpoint, which is what it is for', async () => {
    const { token } = (await (await mint()).json()) as { token: string }
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...as(token) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    const body = (await res.json()) as { result: { tools: unknown[] } }
    expect(body.result.tools.length).toBeGreaterThan(0)
  })

  it('stops working the moment it is revoked', async () => {
    const { token } = (await (await mint()).json()) as { token: string }
    const listed = (await (
      await app.request('/api/v1/auth/me/tokens', { headers: as(session) })
    ).json()) as { tokens: { id: string }[] }
    const id = listed.tokens[0].id

    await app.request(`/api/v1/auth/me/tokens/${id}`, {
      method: 'DELETE',
      headers: as(session),
    })
    expect(
      (await app.request('/api/v1/overview', { headers: as(token) })).status,
    ).toBe(401)
  })

  it('records when it was last used, so an idle one can be retired', async () => {
    const { token } = (await (await mint()).json()) as { token: string }
    const before = await db.query<{ last_used_at: number | null }>(
      "SELECT last_used_at FROM auth_token WHERE kind = 'personal'",
    )
    expect(before[0].last_used_at).toBeNull()

    await app.request('/api/v1/overview', { headers: as(token) })
    const after = await db.query<{ last_used_at: number | null }>(
      "SELECT last_used_at FROM auth_token WHERE kind = 'personal'",
    )
    expect(after[0].last_used_at).toBeGreaterThan(0)
  })

  it('is listed only to its owner', async () => {
    await mint()
    const other = (
      await db.query<{ id: string }>(
        "SELECT id FROM actor WHERE kind = 'system' LIMIT 1",
      )
    )[0].id
    const otherSession = await createToken(db, workspaceId, other, 'session', [
      'read',
      'write',
    ])
    const listed = (await (
      await app.request('/api/v1/auth/me/tokens', { headers: as(otherSession) })
    ).json()) as { tokens: unknown[] }
    expect(listed.tokens).toHaveLength(0)
  })
})
