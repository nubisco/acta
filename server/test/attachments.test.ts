/**
 * Serving attachments.
 *
 * An attachment is a file somebody else uploaded, served from the same origin
 * as the application and behind the same session cookie. That makes the
 * response headers a security boundary rather than a detail:
 *
 *   - Without `nosniff`, a .png whose bytes are HTML can be sniffed as a
 *     document and run as the signed-in user.
 *   - An SVG *is* a document. It can carry script, so serving one inline is
 *     stored XSS unless a policy stops it.
 *
 * Neither header existed before this suite.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/app'
import { createToken } from '../src/core/auth'
import { openDb, type BunSqliteDriver } from '../src/db'

let db: BunSqliteDriver
let app: Hono<never>
let token: string

beforeEach(async () => {
  db = await openDb(':memory:')
  app = (await createApp(db, {
    bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
    dataDir: `/tmp/acta-att-${Math.random().toString(36).slice(2)}`,
  })) as never
  const ws = (await db.query<{ id: string }>('SELECT id FROM workspace'))[0].id
  const me = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
  token = await createToken(db, ws, me, 'session', ['read', 'write', 'admin'])
  await app.request('/api/v1/spaces/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      ops: [
        {
          op: 'create',
          op_id: 's1',
          key: 'SUP',
          name: 'Support',
          template: 'kanban6',
        },
      ],
    }),
  })
  await app.request('/api/v1/items/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      default_space: 'SUP',
      ops: [{ op: 'create', op_id: 'i1', list: 'Backlog', title: 'Card' }],
    }),
  })
})

async function attach(filename: string, mime: string, body: string) {
  const res = await app.request('/api/v1/attachments', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      item: 'SUP-1',
      filename,
      mime,
      content_base64: btoa(body),
    }),
  })
  return (await res.json()) as { id: string; url: string }
}

const serve = (id: string) =>
  app.request(`/api/v1/attachments/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  })

describe('attachment responses', () => {
  it('hands back the URL it is served from', async () => {
    // Without this a caller has to know how to build the path before it can
    // embed what it just uploaded.
    const made = await attach('icon.svg', 'image/svg+xml', '<svg/>')
    expect(made.url).toBe(`/api/v1/attachments/${made.id}`)
    expect((await serve(made.id)).status).toBe(200)
  })

  it('refuses to let the browser guess a type', async () => {
    const made = await attach('trap.png', 'image/png', '<html>hi</html>')
    const res = await serve(made.id)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  it('renders an image in the page and downloads everything else', async () => {
    const png = await attach('a.png', 'image/png', 'x')
    expect(
      (await serve(png.id)).headers.get('content-disposition'),
    ).toStartWith('inline')

    // A safelist, so a type nobody thought about downloads rather than
    // rendering. An HTML attachment rendering inline would be a document on
    // this origin, which is the whole class of bug being avoided.
    const html = await attach('page.html', 'text/html', '<script>x</script>')
    expect(
      (await serve(html.id)).headers.get('content-disposition'),
    ).toStartWith('attachment')
  })

  it('locks an SVG down, because an SVG can carry script', async () => {
    const made = await attach(
      'icon.svg',
      'image/svg+xml',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/v1/overview")</script></svg>',
    )
    const csp = (await serve(made.id)).headers.get('content-security-policy')
    expect(csp).toContain("default-src 'none'")
    // An opaque origin, so the file cannot reach the session cookie even if
    // the rest of the policy is ever loosened.
    expect(csp).toContain('sandbox')
  })

  it('does not put a policy on a plain image, which needs none', async () => {
    const made = await attach('a.png', 'image/png', 'x')
    expect(
      (await serve(made.id)).headers.get('content-security-policy'),
    ).toBeNull()
  })

  it('keeps a quote in a filename out of the header', async () => {
    // An unescaped quote ends the filename parameter early and lets the rest
    // be read as further header parameters.
    const made = await attach('we"ird.png', 'image/png', 'x')
    const disposition = (await serve(made.id)).headers.get(
      'content-disposition',
    )
    expect(disposition).toBe('inline; filename="weird.png"')
  })
})

describe('batching and removal', () => {
  it('attaches several in one call and reports each separately', async () => {
    const res = await app.request('/api/v1/attachments/batch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ops: [
          {
            op_id: 'b1',
            item: 'SUP-1',
            filename: 'one.svg',
            mime: 'image/svg+xml',
            content_base64: btoa('<svg/>'),
          },
          {
            op_id: 'b2',
            item: 'SUP-1',
            filename: 'two.svg',
            mime: 'image/svg+xml',
            content_base64: btoa('<svg/>'),
          },
        ],
      }),
    })
    const body = (await res.json()) as {
      results: { ok: boolean; url?: string }[]
    }
    expect(body.results).toHaveLength(2)
    expect(body.results.every((r) => r.ok)).toBe(true)
    expect(body.results[0].url).toStartWith('/api/v1/attachments/')
  })

  it('does not attach a second copy when an op is replayed', async () => {
    // Sixteen icons over a flaky connection is exactly when a client retries.
    // Without idempotency the document ends up with duplicates nobody asked
    // for and no way to tell which is which.
    const send = () =>
      app.request('/api/v1/attachments/batch', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ops: [
            {
              op_id: 'same-op',
              item: 'SUP-1',
              filename: 'icon.svg',
              mime: 'image/svg+xml',
              content_base64: btoa('<svg/>'),
            },
          ],
        }),
      })

    const first = (await (await send()).json()) as {
      results: { id: string }[]
    }
    const again = (await (await send()).json()) as {
      results: { id: string }[]
    }
    expect(again.results[0].id).toBe(first.results[0].id)

    const rows = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM attachment',
    )
    expect(rows[0].n).toBe(1)
  })

  it('removes an attachment and its bytes', async () => {
    const made = await attach('gone.png', 'image/png', 'x')
    const res = await app.request(`/api/v1/attachments/${made.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    expect((await serve(made.id)).status).toBe(404)
  })
})
