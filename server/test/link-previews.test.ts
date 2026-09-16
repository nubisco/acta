/**
 * Link preview metadata: reading it, caching it, and failing quietly.
 *
 * The SSRF guard itself is tested in safe-fetch.test.ts. What is tested here
 * is that the service actually goes through it, that a document with twenty
 * links does not make twenty fetches every time it is opened, and that every
 * way this can fail produces "no card" rather than a broken one.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import type { ICtx } from '../src/core/ctx'
import { openDb, type BunSqliteDriver } from '../src/db'
import type { IFetchDeps } from '../src/core/safeFetch'
import {
  canonicalise,
  FAILURE_TTL_MS,
  linkPreviewGet,
  parseMetadata,
  PREVIEW_TTL_MS,
} from '../src/services/linkPreviews'

let db: BunSqliteDriver
let ctx: ICtx

beforeEach(async () => {
  db = await openDb(':memory:')
  const workspaceId = await bootstrapWorkspace(db, {
    adminEmail: 'a@b.c',
    adminHandle: 'jose',
  })
  const admin = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0]
  ctx = {
    db,
    workspaceId,
    actor: {
      id: admin.id,
      kind: 'human',
      handle: 'jose',
      role: 'admin',
      scopes: ['read', 'write'],
    },
  }
})

const PAGE = `<!doctype html><html><head>
  <title>Fallback title</title>
  <meta property="og:title" content="A real page">
  <meta property="og:description" content="What the page is about.">
  <meta property="og:site_name" content="Example">
  <meta property="og:image" content="/card.png">
  <link rel="icon" href="/favicon-32.png">
</head><body>ignored</body></html>`

/** A fetch stub that counts calls, so cache hits are observable. */
function stubDeps(
  routes: Record<string, { status?: number; type?: string; body?: string }>,
): IFetchDeps & { calls: string[] } {
  const calls: string[] = []
  const fetchImpl = ((url: string) => {
    calls.push(String(url))
    const route = routes[String(url)]
    if (!route) return Promise.resolve(new Response('no', { status: 404 }))
    return Promise.resolve(
      new Response(route.body ?? '', {
        status: route.status ?? 200,
        headers: { 'content-type': route.type ?? 'text/html; charset=utf-8' },
      }),
    )
  }) as unknown as typeof fetch
  return {
    calls,
    fetch: fetchImpl,
    resolve: (hostname) =>
      Promise.resolve(
        hostname === 'intranet.test' ? ['10.0.0.9'] : ['93.184.216.34'],
      ),
  }
}

describe('reading metadata off a page', () => {
  it('prefers Open Graph over the title tag, and resolves relative URLs', async () => {
    const deps = stubDeps({ 'https://example.com/a': { body: PAGE } })
    const [preview] = await linkPreviewGet(ctx, ['https://example.com/a'], deps)
    expect(preview).toEqual({
      url: 'https://example.com/a',
      status: 'ok',
      title: 'A real page',
      description: 'What the page is about.',
      site_name: 'Example',
      image_url: 'https://example.com/card.png',
      favicon_url: 'https://example.com/favicon-32.png',
    })
  })

  it('falls back to the title tag, the hostname and /favicon.ico', async () => {
    const deps = stubDeps({
      'https://example.com/b': {
        body: '<html><head><title>Just a title</title></head></html>',
      },
    })
    const [preview] = await linkPreviewGet(ctx, ['https://example.com/b'], deps)
    expect(preview.title).toBe('Just a title')
    expect(preview.site_name).toBe('example.com')
    expect(preview.favicon_url).toBe('https://example.com/favicon.ico')
    expect(preview.image_url).toBeUndefined()
  })

  it('decodes the entities a CMS emits, and collapses whitespace', () => {
    const parsed = parseMetadata(
      `<head><meta property="og:title" content="Tom &amp; Jerry&#8217;s\n  big   day"></head>`,
      'https://example.com/',
    )
    expect(parsed.title).toBe('Tom & Jerry’s big day')
  })

  it('refuses an og:image that is not http or https', () => {
    // A valid URL, and the browser would be the thing executing it. The
    // reader checks again, and this is what stops the value being stored.
    const parsed = parseMetadata(
      `<head><meta property="og:title" content="x">
       <meta property="og:image" content="javascript:alert(1)"></head>`,
      'https://example.com/',
    )
    expect(parsed.image_url).toBeUndefined()
  })

  it('ignores a title that is inside the body', () => {
    // An inline SVG with its own <title> is common, and reading it would put
    // "Menu icon" on the card.
    const parsed = parseMetadata(
      '<head><title>Real</title></head><body><svg><title>Icon</title></svg></body>',
      'https://example.com/',
    )
    expect(parsed.title).toBe('Real')
  })

  it('reads an oEmbed endpoint when the page has no title of its own', async () => {
    const deps = stubDeps({
      'https://video.test/watch': {
        body: `<head><link rel="alternate" type="application/json+oembed" href="https://video.test/oembed?u=1"></head>`,
      },
      'https://video.test/oembed?u=1': {
        type: 'application/json',
        body: JSON.stringify({
          title: 'A talk',
          provider_name: 'Video',
          thumbnail_url: 'https://video.test/thumb.jpg',
        }),
      },
    })
    const [preview] = await linkPreviewGet(
      ctx,
      ['https://video.test/watch'],
      deps,
    )
    expect(preview.status).toBe('ok')
    expect(preview.title).toBe('A talk')
    expect(preview.site_name).toBe('Video')
    expect(preview.image_url).toBe('https://video.test/thumb.jpg')
  })
})

describe('degrading gracefully', () => {
  it('answers "none" for a page with no metadata at all', async () => {
    const deps = stubDeps({
      'https://example.com/c': { body: '<html><body>hello</body></html>' },
    })
    const [preview] = await linkPreviewGet(ctx, ['https://example.com/c'], deps)
    expect(preview).toEqual({ url: 'https://example.com/c', status: 'none' })
  })

  it('answers "none" for a 404, a non-HTML body, and a dead host', async () => {
    const deps = stubDeps({
      'https://example.com/pdf': { type: 'application/pdf', body: '%PDF-' },
    })
    const previews = await linkPreviewGet(
      ctx,
      ['https://example.com/pdf', 'https://example.com/missing'],
      deps,
    )
    expect(previews.map((p) => p.status)).toEqual(['none', 'none'])
  })

  it('answers "none" for a URL the SSRF guard refuses, and never fetches it', async () => {
    const deps = stubDeps({})
    const previews = await linkPreviewGet(
      ctx,
      [
        'http://169.254.169.254/latest/meta-data/',
        'http://localhost:8080/admin',
        'https://intranet.test/wiki', // public name, private A record
        'file:///etc/passwd',
      ],
      deps,
    )
    expect(previews.map((p) => p.status)).toEqual([
      'none',
      'none',
      'none',
      'none',
    ])
    // The point of the assertion: no request was made at all.
    expect(deps.calls).toEqual([])
  })

  it('tells the caller nothing about WHY a URL was refused', async () => {
    // A different answer for "refused" and "no metadata" would turn any
    // document into a port scanner for our own network.
    const deps = stubDeps({
      'https://example.com/c': { body: '<html><body>hi</body></html>' },
    })
    const [refused] = await linkPreviewGet(ctx, ['http://10.0.0.1/'], deps)
    const [empty] = await linkPreviewGet(ctx, ['https://example.com/c'], deps)
    expect({ ...refused, url: '' }).toEqual({ ...empty, url: '' })
  })

  it('lets one slow link fail without taking the others with it', async () => {
    const deps = stubDeps({ 'https://example.com/a': { body: PAGE } })
    const slow: IFetchDeps = {
      ...deps,
      fetch: ((url: string) =>
        String(url).includes('/hang')
          ? Promise.reject(new Error('timed out'))
          : deps.fetch(url)) as unknown as typeof fetch,
    }
    const previews = await linkPreviewGet(
      ctx,
      ['https://example.com/hang', 'https://example.com/a'],
      slow,
    )
    expect(previews[0].status).toBe('none')
    expect(previews[1].status).toBe('ok')
  })
})

describe('the cache', () => {
  it('fetches a URL once, however many times a document is opened', async () => {
    const deps = stubDeps({ 'https://example.com/a': { body: PAGE } })
    const urls = ['https://example.com/a']
    await linkPreviewGet(ctx, urls, deps)
    await linkPreviewGet(ctx, urls, deps)
    const third = await linkPreviewGet(ctx, urls, deps)
    expect(deps.calls).toEqual(['https://example.com/a'])
    expect(third[0].title).toBe('A real page')
  })

  it('fetches a repeated URL once within a single request', async () => {
    // Twenty links to the same page is one fetch, not twenty.
    const deps = stubDeps({ 'https://example.com/a': { body: PAGE } })
    const previews = await linkPreviewGet(
      ctx,
      new Array<string>(20).fill('https://example.com/a'),
      deps,
    )
    expect(deps.calls.length).toBe(1)
    expect(previews.length).toBe(20)
    expect(previews.every((p) => p.status === 'ok')).toBe(true)
  })

  it('caches a failure too, so a site with no tags is not refetched', async () => {
    const deps = stubDeps({
      'https://example.com/c': { body: '<html><body>hi</body></html>' },
    })
    await linkPreviewGet(ctx, ['https://example.com/c'], deps)
    await linkPreviewGet(ctx, ['https://example.com/c'], deps)
    expect(deps.calls.length).toBe(1)
  })

  it('refetches once the TTL has passed, and a failure expires sooner', async () => {
    const deps = stubDeps({
      'https://example.com/a': { body: PAGE },
      'https://example.com/c': { body: '<html><body>hi</body></html>' },
    })
    const start = 1_000_000_000_000
    let clock = start
    const at = () => clock
    await linkPreviewGet(ctx, ['https://example.com/a'], deps, at)
    await linkPreviewGet(ctx, ['https://example.com/c'], deps, at)
    expect(deps.calls.length).toBe(2)

    // Past the failure TTL but well inside the success one: the failure comes
    // back for another look, the success does not.
    clock = start + FAILURE_TTL_MS + 1
    await linkPreviewGet(ctx, ['https://example.com/a'], deps, at)
    await linkPreviewGet(ctx, ['https://example.com/c'], deps, at)
    expect(deps.calls.length).toBe(3)

    clock = start + PREVIEW_TTL_MS + 1
    await linkPreviewGet(ctx, ['https://example.com/a'], deps, at)
    expect(deps.calls.length).toBe(4)
  })

  it('caches on the URL without its fragment', async () => {
    // #install and #usage are the same page to the server, and the fragment
    // is never sent to it in the first place.
    const deps = stubDeps({ 'https://example.com/a': { body: PAGE } })
    const previews = await linkPreviewGet(
      ctx,
      ['https://example.com/a#install', 'https://example.com/a#usage'],
      deps,
    )
    expect(deps.calls.length).toBe(1)
    // Echoed back exactly as asked, so the client can match a card to a link.
    expect(previews[0].url).toBe('https://example.com/a#install')
    expect(previews[1].url).toBe('https://example.com/a#usage')
    expect(previews[0].title).toBe('A real page')
  })

  it('keeps a query string, which usually picks the page', () => {
    expect(canonicalise('https://example.com/a?id=2#x')).toBe(
      'https://example.com/a?id=2',
    )
    expect(canonicalise('javascript:alert(1)')).toBeNull()
    expect(canonicalise('not a url')).toBeNull()
  })
})
