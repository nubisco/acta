/**
 * Copying a picture from another site into an attachment.
 *
 * This endpoint makes the server fetch an address a user typed, which is the
 * SSRF shape link previews already have. The guard itself is tested in
 * safe-fetch.test.ts. What is tested here is that this endpoint goes through
 * it, that what it stores is really an image, and that nothing it answers
 * tells a caller WHY a fetch failed.
 *
 * Nothing touches the network: resolver and fetch are injected through the app.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { newId } from '@nubisco/acta-shared'
import { createApp } from '../src/app'
import { createToken } from '../src/core/auth'
import type { IFetchDeps } from '../src/core/safeFetch'
import { openDb, type BunSqliteDriver } from '../src/db'
import {
  REMOTE_IMAGE_FAILURE,
  REMOTE_IMAGE_MAX_BYTES,
  sniffImage,
} from '../src/services/remoteImages'

/** A 1x1 PNG. */
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  ),
  (ch) => ch.charCodeAt(0),
)
const SVG =
  '<?xml version="1.0"?>\n<!-- drawn by hand -->\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'

interface IRoute {
  status?: number
  headers?: Record<string, string>
  body?: ConstructorParameters<typeof Response>[0]
}

let db: BunSqliteDriver
let app: Hono<never>
let writer: string
let reader: string
let routes: Record<string, IRoute>
let calls: string[]
let blobs: Map<string, Uint8Array>

const deps: IFetchDeps = {
  fetch: ((url: string) => {
    calls.push(String(url))
    const route = routes[String(url)]
    if (!route) return Promise.reject(new Error('connection refused'))
    return Promise.resolve(
      new Response(route.body ?? '', {
        status: route.status ?? 200,
        headers: route.headers ?? {},
      }),
    )
  }) as unknown as typeof fetch,
  resolve: (hostname) =>
    Promise.resolve(
      {
        'images.test': ['93.184.216.34'],
        'down.test': ['93.184.216.35'],
        'intranet.test': ['10.0.0.9'],
      }[hostname] ?? [],
    ),
}

beforeEach(async () => {
  db = await openDb(':memory:')
  routes = {}
  calls = []
  blobs = new Map()
  app = (await createApp(db, {
    bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
    blobStore: {
      put: async (id, bytes) => void blobs.set(id, bytes),
      get: async (id) => blobs.get(id) ?? null,
      delete: async (id) => void blobs.delete(id),
    },
    remoteFetchDeps: deps,
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
  const res = await app.request('/api/v1/docs/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${writer}`,
    },
    body: JSON.stringify({
      ops: [{ op: 'create', op_id: 'c1', slug: 'guide', title: 'Guide' }],
    }),
  })
  expect(res.status).toBe(200)
})

function copy(url: string, token = writer, doc = 'guide') {
  return app.request('/api/v1/attachments/fetch', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ doc, url }),
  })
}

async function attachmentCount(): Promise<number> {
  const rows = await db.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM attachment',
  )
  return rows[0].n
}

async function expectNothingStored(): Promise<void> {
  expect(await attachmentCount()).toBe(0)
  expect(blobs.size).toBe(0)
}

/** Status and body, which is everything a caller can compare. */
async function answer(res: Response) {
  return { status: res.status, body: await res.json() }
}

describe('what gets stored', () => {
  it('copies a PNG into an attachment on the page', async () => {
    routes['https://images.test/pics/dot.png?v=2'] = {
      headers: { 'content-type': 'image/png' },
      body: PNG,
    }
    const res = await copy('https://images.test/pics/dot.png?v=2')
    expect(res.status).toBe(200)
    const made = (await res.json()) as { id: string; filename: string }
    expect(made.id).toStartWith('att')
    expect(made.filename).toBe('dot.png')
    expect(blobs.get(made.id)).toEqual(PNG)

    const [row] = await db.query<{
      owner_kind: string
      kind: string
      mime: string
      size: number
    }>('SELECT owner_kind, kind, mime, size FROM attachment WHERE id = ?', [
      made.id,
    ])
    // Stored exactly as an upload: a file on the page, not a link.
    expect(row).toEqual({
      owner_kind: 'doc',
      kind: 'file',
      mime: 'image/png',
      size: PNG.byteLength,
    })
  })

  it('stores an SVG as an SVG, so it is served locked down', async () => {
    routes['https://images.test/logo'] = {
      headers: { 'content-type': 'image/svg+xml; charset=utf-8' },
      body: SVG,
    }
    const res = await copy('https://images.test/logo')
    expect(res.status).toBe(200)
    const made = (await res.json()) as { id: string; filename: string }
    expect(made.filename).toBe('logo.svg')

    const served = await app.request(`/api/v1/attachments/${made.id}`, {
      headers: { authorization: `Bearer ${writer}` },
    })
    expect(served.headers.get('content-type')).toBe('image/svg+xml')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    const csp = served.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain('sandbox')
  })

  it('follows a redirect to another public address', async () => {
    routes['https://images.test/short'] = {
      status: 302,
      headers: { location: '/real.png' },
    }
    routes['https://images.test/real.png'] = {
      headers: { 'content-type': 'image/png' },
      body: PNG,
    }
    expect((await copy('https://images.test/short')).status).toBe(200)
    expect(await attachmentCount()).toBe(1)
  })
})

describe('what is refused', () => {
  it('refuses a private or metadata address, and never connects to it', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://127.0.0.1:8080/admin.png',
      'http://[::ffff:127.0.0.1]/x.png',
      'http://metadata.google.internal/computeMetadata/v1/',
      'https://intranet.test/logo.png',
      'file:///etc/passwd',
    ]) {
      const res = await copy(url)
      expect(res.status, url).toBe(422)
    }
    expect(calls).toEqual([])
    await expectNothingStored()
  })

  it('refuses a public address that redirects to a private one', async () => {
    routes['https://images.test/bounce.png'] = {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    }
    expect((await copy('https://images.test/bounce.png')).status).toBe(422)
    // The metadata endpoint was never contacted.
    expect(calls).toEqual(['https://images.test/bounce.png'])
    await expectNothingStored()
  })

  it('refuses a response that is not an image', async () => {
    routes['https://images.test/page'] = {
      headers: { 'content-type': 'text/html' },
      body: '<!doctype html><title>hi</title>',
    }
    expect((await copy('https://images.test/page')).status).toBe(422)
    await expectNothingStored()
  })

  it('refuses HTML wearing an image content type', async () => {
    // The header is whatever the far end chose to send. Stored, this would be
    // a document on Acta's origin that only nosniff stands between.
    for (const type of ['image/png', 'image/svg+xml', 'image/jpeg']) {
      routes['https://images.test/trap.png'] = {
        headers: { 'content-type': type },
        body: '<html><script>fetch("/api/v1/overview")</script></html>',
      }
      expect((await copy('https://images.test/trap.png')).status, type).toBe(
        422,
      )
    }
    await expectNothingStored()
  })

  it('refuses when the bytes and the declared type disagree', async () => {
    // An SVG, a document that can carry script, labelled as a PNG.
    routes['https://images.test/sneaky.png'] = {
      headers: { 'content-type': 'image/png' },
      body: SVG,
    }
    expect((await copy('https://images.test/sneaky.png')).status).toBe(422)
    await expectNothingStored()
  })

  it('refuses an image over the size cap, declared or not', async () => {
    const big = new Uint8Array(REMOTE_IMAGE_MAX_BYTES + 1)
    big.set(PNG)
    // Honest about its size: refused from the header.
    routes['https://images.test/declared.png'] = {
      headers: {
        'content-type': 'image/png',
        'content-length': String(big.byteLength),
      },
      body: big,
    }
    expect((await copy('https://images.test/declared.png')).status).toBe(422)
    // Silent about its size: refused while reading, not truncated and kept.
    routes['https://images.test/streamed.png'] = {
      headers: { 'content-type': 'image/png' },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(big)
          controller.close()
        },
      }),
    }
    expect((await copy('https://images.test/streamed.png')).status).toBe(422)
    await expectNothingStored()

    // And a picture of exactly the cap is still fine.
    routes['https://images.test/limit.png'] = {
      headers: { 'content-type': 'image/png' },
      body: big.subarray(0, REMOTE_IMAGE_MAX_BYTES),
    }
    expect((await copy('https://images.test/limit.png')).status).toBe(200)
  })

  it('needs write scope, and checks it before fetching anything', async () => {
    routes['https://images.test/dot.png'] = {
      headers: { 'content-type': 'image/png' },
      body: PNG,
    }
    expect((await copy('https://images.test/dot.png', reader)).status).toBe(403)
    expect(calls).toEqual([])
    await expectNothingStored()
  })

  it('does not fetch for a page that does not exist', async () => {
    routes['https://images.test/dot.png'] = {
      headers: { 'content-type': 'image/png' },
      body: PNG,
    }
    const res = await copy('https://images.test/dot.png', writer, 'nowhere')
    expect(res.status).toBe(404)
    expect(calls).toEqual([])
  })
})

describe('telling a caller nothing', () => {
  it('answers a guard refusal exactly like a network failure', async () => {
    routes['https://images.test/404.png'] = { status: 404 }
    routes['https://images.test/page'] = {
      headers: { 'content-type': 'text/html' },
      body: '<html></html>',
    }
    const refused = await answer(await copy('http://169.254.169.254/'))
    const privateName = await answer(await copy('https://intranet.test/a.png'))
    const unresolved = await answer(await copy('https://nowhere.test/a.png'))
    const unreachable = await answer(await copy('https://down.test/a.png'))
    const missing = await answer(await copy('https://images.test/404.png'))
    const notImage = await answer(await copy('https://images.test/page'))

    const expected = { status: 422, body: { error: REMOTE_IMAGE_FAILURE } }
    for (const got of [
      refused,
      privateName,
      unresolved,
      unreachable,
      missing,
      notImage,
    ])
      expect(got).toEqual(expected)
  })
})

describe('sniffing', () => {
  it('reads the formats from their bytes', () => {
    const bytes = (text: string) => new TextEncoder().encode(text)
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      'image/jpeg',
    )
    expect(sniffImage(bytes('GIF89a....'))).toBe('image/gif')
    expect(sniffImage(bytes('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImage(bytes('\0\0\0\x1cftypavif'))).toBe('image/avif')
    expect(sniffImage(bytes(SVG))).toBe('image/svg+xml')
    expect(sniffImage(bytes('﻿  <svg viewBox="0 0 1 1"/>'))).toBe(
      'image/svg+xml',
    )
  })

  it('does not take markup that merely contains an svg for an svg', () => {
    const bytes = (text: string) => new TextEncoder().encode(text)
    expect(sniffImage(bytes('<html><body><svg></svg></body></html>'))).toBe(
      null,
    )
    expect(sniffImage(bytes('<svgx>'))).toBe(null)
    expect(sniffImage(bytes(''))).toBe(null)
    expect(sniffImage(new Uint8Array([0, 1, 2, 3]))).toBe(null)
  })
})
