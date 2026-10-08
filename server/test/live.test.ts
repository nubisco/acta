/**
 * Live updates reach every open tab at once.
 *
 * On Workers the stream was fed by the instance that handled the write, which
 * was often not the one holding a given tab, so changes and reminders only
 * showed up after a reload or the next poll. Jose asked for proper instant
 * delivery on 2026-10-08. Tabs now hold a socket: on Bun the process feeds it
 * directly, on Workers every event is published to a per-workspace hub.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/app'
import { createToken } from '../src/core/auth'
import {
  LIVE_MAX_AGE_MS,
  LIVE_REAUTH_CODE,
  type ILiveTransport,
} from '../src/core/live'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bunLive, bunWebsocket } from '../src/live-bun'
import { LiveHub } from '../src/live-hub'

let db: BunSqliteDriver
let token: string
let workspaceId: string

async function boot(live?: ILiveTransport): Promise<Hono<never>> {
  db = await openDb(':memory:')
  const app = (await createApp(db, {
    bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
    dataDir: `/tmp/acta-live-${Math.random().toString(36).slice(2)}`,
    live,
  })) as never as Hono<never>
  workspaceId = (await db.query<{ id: string }>('SELECT id FROM workspace'))[0]
    .id
  const me = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
  token = await createToken(db, workspaceId, me, 'session', [
    'read',
    'write',
    'admin',
  ])
  return app
}

function createSpace(app: Hono<never>, key: string) {
  return app.request('/api/v1/spaces/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      ops: [{ op: 'create', op_id: key, key, name: key, template: 'kanban6' }],
    }),
  })
}

let server: ReturnType<typeof Bun.serve> | null = null
afterEach(() => {
  void server?.stop(true)
  server = null
})

describe('the socket on Bun', () => {
  it('delivers a write to a connected tab as it happens', async () => {
    const app = await boot(bunLive)
    server = Bun.serve({ port: 0, fetch: app.fetch, websocket: bunWebsocket })
    const ws = new WebSocket(
      `ws://localhost:${server.port}/api/v1/events/socket`,
      { headers: { authorization: `Bearer ${token}` } } as never,
    )
    const frames: string[] = []
    ws.onmessage = (m) => frames.push(String(m.data))
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('socket failed'))
    })

    ws.send('ping')
    await createSpace(app, 'LIV')
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && !frames.some((f) => f.includes('space')))
      await Bun.sleep(10)

    expect(frames).toContain('pong')
    const frame = JSON.parse(frames.find((f) => f.startsWith('{'))!)
    expect(frame.entity).toBe('space')
    expect(typeof frame.verb).toBe('string')
    ws.close()
  })

  it('refuses a socket opened from another site', async () => {
    const app = await boot(bunLive)
    server = Bun.serve({ port: 0, fetch: app.fetch, websocket: bunWebsocket })
    // Another nubisco.io app would carry the Lax session cookie here.
    const res = await fetch(
      `http://localhost:${server.port}/api/v1/events/socket`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          origin: 'https://evil.nubisco.io',
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      },
    )
    expect(res.status).toBe(403)
  })

  it('refuses somebody who is not signed in', async () => {
    const app = await boot(bunLive)
    const res = await app.request('/api/v1/events/socket', {
      headers: { upgrade: 'websocket' },
    })
    expect(res.status).toBe(401)
  })
})

describe('publishing to a hub', () => {
  it('publishes every event with its workspace, once the write commits', async () => {
    const sent: { workspaceId: string; frame: string }[] = []
    const app = await boot({
      socket: async (c) => c.text('hub', 200),
      publish: async (id, frame) => {
        sent.push({ workspaceId: id, frame })
      },
    })
    await createSpace(app, 'HUB')
    const space = sent.find((s) => JSON.parse(s.frame).entity === 'space')
    expect(space?.workspaceId).toBe(workspaceId)

    // The socket request is handed to the transport after sign-in.
    const res = await app.request('/api/v1/events/socket', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(await res.text()).toBe('hub')
  })

  it('answers 404 with no transport, so the tab falls back to the stream', async () => {
    const app = await boot()
    const res = await app.request('/api/v1/events/socket', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(404)
  })
})

describe('the hub', () => {
  const g = globalThis as Record<string, unknown>
  g.WebSocketRequestResponsePair ??= class {
    constructor(
      public request: string,
      public response: string,
    ) {}
  }

  function hub(openedAt: number[] = [Date.now(), Date.now()]) {
    const sockets = openedAt.map((at) => {
      const s = { got: [] as string[], closed: null as number | null }
      return Object.assign(s, {
        send(m: string) {
          s.got.push(m)
        },
        close(code?: number) {
          s.closed = code ?? 1000
        },
        serializeAttachment() {},
        deserializeAttachment: () => ({ openedAt: at }),
      })
    })
    let auto: unknown = null
    const state = {
      acceptWebSocket() {},
      getWebSockets: () => sockets,
      setWebSocketAutoResponse: (pair: unknown) => (auto = pair),
    }
    return { hub: new LiveHub(state), sockets, auto: () => auto }
  }

  it('fans a published frame out to every socket', async () => {
    const { hub: h, sockets } = hub()
    const res = await h.fetch(
      new Request('https://live.hub/publish', { method: 'POST', body: '{}' }),
    )
    expect(res.status).toBe(204)
    expect(sockets.map((s) => s.got)).toEqual([['{}'], ['{}']])
  })

  it('makes a socket sign in again once it is half an hour old', async () => {
    const { hub: h, sockets } = hub([
      Date.now() - LIVE_MAX_AGE_MS - 1,
      Date.now(),
    ])
    await h.fetch(
      new Request('https://live.hub/publish', { method: 'POST', body: '{}' }),
    )
    expect(sockets[0].got).toEqual([])
    expect(sockets[0].closed).toBe(LIVE_REAUTH_CODE)
    expect(sockets[1].got).toEqual(['{}'])
  })

  it('answers pings without waking, and wants an upgrade to connect', async () => {
    const { hub: h, auto } = hub()
    expect(auto()).toMatchObject({ request: 'ping', response: 'pong' })
    const res = await h.fetch(new Request('https://live.hub/connect'))
    expect(res.status).toBe(426)
  })
})
