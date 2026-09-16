/**
 * Metadata behind a link preview card.
 *
 * A bare URL on a line of its own renders as a card: favicon, title,
 * description, site name, picture. The storage stays a plain markdown link,
 * so none of this is in the document and nothing here can damage somebody's
 * file. The card is a decoration over text that was always there.
 *
 * Fetched here rather than in the browser, for two reasons that both matter:
 * a browser cannot read another origin's HTML at all (CORS), and a document
 * with twenty links would otherwise make twenty cross-origin requests from
 * the reader's machine, leaking where they read and stalling on whichever
 * site is slowest.
 *
 * Everything outbound goes through `safeFetch`. Read that file before
 * changing anything here: the URL comes from user content, which makes this
 * an SSRF sink.
 */
import { z } from 'zod'
import type { ICtx } from '../core/ctx'
import { now } from '../core/ctx'
import {
  realFetchDeps,
  safeFetch,
  UrlRefused,
  type IFetchDeps,
} from '../core/safeFetch'

/** How long a good answer is trusted. A title rarely changes twice a day. */
export const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000

/**
 * How long a failure is trusted.
 *
 * Shorter, because a site that was down at lunchtime is usually up by the
 * evening, and long enough that a document full of links to a site with no
 * Open Graph tags does not refetch every one of them on every open. That
 * second half is the whole point: the failure path needs a cache at least as
 * much as the success path does.
 */
export const FAILURE_TTL_MS = 60 * 60 * 1000

/** URLs one request may ask about. A document is read a screen at a time. */
export const MAX_URLS = 30

export interface ILinkPreview {
  url: string
  /** 'none' means "no card": the reader keeps showing the plain link. */
  status: 'ok' | 'none'
  title?: string
  description?: string
  site_name?: string
  image_url?: string
  favicon_url?: string
}

export const zLinkPreviewRequest = z.object({
  urls: z.array(z.string().min(1).max(2000)).min(1).max(MAX_URLS),
})

/** Caps, so a hostile page cannot store a novel in our database. */
const LIMITS = {
  title: 300,
  description: 600,
  site_name: 120,
  url: 2000,
}

interface IRow {
  url: string
  status: 'ok' | 'none'
  title: string | null
  description: string | null
  site_name: string | null
  image_url: string | null
  favicon_url: string | null
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Previews for a batch of URLs, from cache where possible.
 *
 * Misses are fetched concurrently and each one is capped on its own, so the
 * slowest site in a document delays only its own card. A fetch that fails for
 * any reason (refused, unreachable, no metadata) is recorded as 'none' rather
 * than thrown, because the caller's correct response to all of those is the
 * same: keep showing the plain link.
 */
export async function linkPreviewGet(
  ctx: ICtx,
  urls: string[],
  deps: IFetchDeps = realFetchDeps(),
  clock: () => number = now,
): Promise<ILinkPreview[]> {
  const asked = urls.slice(0, MAX_URLS)
  // Canonicalised before anything touches the cache, so `example.com/a#one`
  // and `example.com/a#two` are one row rather than two fetches.
  const canonical = new Map<string, string | null>()
  for (const url of asked) canonical.set(url, canonicalise(url))

  const wanted = [...new Set([...canonical.values()].filter(isString))]
  const cached = await readCache(ctx, wanted, clock())

  const missing = wanted.filter((url) => !cached.has(url))
  const fetched = await Promise.all(
    missing.map((url) => fetchPreview(url, deps)),
  )
  for (const preview of fetched) {
    cached.set(preview.url, preview)
    await writeCache(ctx, preview, clock())
  }

  return asked.map((original) => {
    const key = canonical.get(original)
    const found = key ? cached.get(key) : undefined
    // The URL is echoed back exactly as asked, so the client can match a
    // result to the link it rendered without repeating the canonicalisation.
    return {
      ...(found ?? { status: 'none' as const, url: original }),
      url: original,
    }
  })
}

function isString(value: string | null): value is string {
  return value !== null
}

/**
 * The form a URL is cached under.
 *
 * The fragment comes off because it never reaches the server and so cannot
 * change what the server says. Nothing else is touched: a query string is
 * usually what picks the page, and stripping tracking parameters here would
 * mean fetching a different URL from the one the author wrote.
 */
export function canonicalise(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    const text = url.toString()
    return text.length <= LIMITS.url ? text : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

async function readCache(
  ctx: ICtx,
  urls: string[],
  at: number,
): Promise<Map<string, ILinkPreview>> {
  const found = new Map<string, ILinkPreview>()
  if (urls.length === 0) return found
  const holes = urls.map(() => '?').join(', ')
  const rows = await ctx.db.query<IRow>(
    `SELECT url, status, title, description, site_name, image_url, favicon_url
       FROM link_preview WHERE url IN (${holes}) AND expires_at > ?`,
    [...urls, at],
  )
  for (const row of rows) found.set(row.url, fromRow(row))
  return found
}

function fromRow(row: IRow): ILinkPreview {
  const preview: ILinkPreview = { url: row.url, status: row.status }
  if (row.title) preview.title = row.title
  if (row.description) preview.description = row.description
  if (row.site_name) preview.site_name = row.site_name
  if (row.image_url) preview.image_url = row.image_url
  if (row.favicon_url) preview.favicon_url = row.favicon_url
  return preview
}

async function writeCache(
  ctx: ICtx,
  preview: ILinkPreview,
  at: number,
): Promise<void> {
  const ttl = preview.status === 'ok' ? PREVIEW_TTL_MS : FAILURE_TTL_MS
  await ctx.db.run(
    `INSERT INTO link_preview
       (url, status, title, description, site_name, image_url, favicon_url, fetched_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         status = excluded.status,
         title = excluded.title,
         description = excluded.description,
         site_name = excluded.site_name,
         image_url = excluded.image_url,
         favicon_url = excluded.favicon_url,
         fetched_at = excluded.fetched_at,
         expires_at = excluded.expires_at`,
    [
      preview.url,
      preview.status,
      preview.title ?? null,
      preview.description ?? null,
      preview.site_name ?? null,
      preview.image_url ?? null,
      preview.favicon_url ?? null,
      at,
      at + ttl,
    ],
  )
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * One URL, fetched and read. Never throws.
 *
 * A refusal and a timeout produce the same answer as a page with no tags at
 * all, because the reader's behaviour for all three is identical: no card.
 * Distinguishing them in the response would only tell the author of a
 * document which of our internal addresses exist.
 */
export async function fetchPreview(
  url: string,
  deps: IFetchDeps,
): Promise<ILinkPreview> {
  try {
    const res = await safeFetch(url, deps)
    const type = res.contentType.split(';')[0].trim().toLowerCase()
    if (type && type !== 'text/html' && type !== 'application/xhtml+xml')
      return { url, status: 'none' }

    const meta = parseMetadata(res.body, res.url)
    if (!meta.title && meta.oembed) {
      const extra = await readOembed(meta.oembed, deps)
      if (extra) Object.assign(meta, { ...extra, oembed: undefined })
    }
    // A card with no title is a grey box with a URL in it, which is worse
    // than the link it replaced. No title means no card.
    if (!meta.title) return { url, status: 'none' }

    const preview: ILinkPreview = { url, status: 'ok', title: meta.title }
    if (meta.description) preview.description = meta.description
    if (meta.site_name) preview.site_name = meta.site_name
    else preview.site_name = hostLabel(res.url)
    if (meta.image_url) preview.image_url = meta.image_url
    preview.favicon_url = meta.favicon_url ?? defaultFavicon(res.url)
    return preview
  } catch (err) {
    // Logged at debug level only: a refused URL is an ordinary event in a
    // workspace where somebody pasted an intranet address, not an incident.
    if (!(err instanceof UrlRefused)) void err
    return { url, status: 'none' }
  }
}

/** oEmbed, for the sites that publish that and no Open Graph tags. */
async function readOembed(
  endpoint: string,
  deps: IFetchDeps,
): Promise<Partial<ILinkPreview> | null> {
  try {
    const res = await safeFetch(endpoint, deps, 'application/json')
    const body = JSON.parse(res.body) as Record<string, unknown>
    const title = text(body.title, LIMITS.title)
    if (!title) return null
    const out: Partial<ILinkPreview> = { title }
    const provider = text(body.provider_name, LIMITS.site_name)
    if (provider) out.site_name = provider
    const author = text(body.author_name, LIMITS.description)
    if (author) out.description = author
    const thumb = absolute(text(body.thumbnail_url, LIMITS.url), endpoint)
    if (thumb) out.image_url = thumb
    return out
  } catch {
    return null
  }
}

interface IParsed {
  title?: string
  description?: string
  site_name?: string
  image_url?: string
  favicon_url?: string
  /** An oEmbed endpoint the page advertises, used only as a fallback. */
  oembed?: string
}

/**
 * Open Graph, Twitter cards, and the plain HTML that predates both.
 *
 * Read with regular expressions rather than a DOM, because there is no DOM on
 * either runtime this server targets and the input is already capped at
 * 256 kB. This is not a parser and does not need to be: everything it looks
 * for is a self-closing tag in `<head>`, and anything it misreads produces no
 * card, which is the same as the failure path.
 */
export function parseMetadata(html: string, baseUrl: string): IParsed {
  const head = html.slice(0, cutAtHeadEnd(html))
  const metas = new Map<string, string>()
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag)
    const key = (attrs.property ?? attrs.name ?? attrs.itemprop)?.toLowerCase()
    const value = attrs.content
    // First wins: a page that declares og:title twice means the first one,
    // and the later ones are usually per-section overrides in a template.
    if (key && value && !metas.has(key)) metas.set(key, value)
  }

  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const found = text(metas.get(key), LIMITS.title)
      if (found) return found
    }
    return undefined
  }

  const parsed: IParsed = {}
  const title =
    pick('og:title', 'twitter:title') ??
    text(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1], LIMITS.title)
  if (title) parsed.title = title

  const description = pick(
    'og:description',
    'twitter:description',
    'description',
  )
  if (description) parsed.description = description.slice(0, LIMITS.description)

  const site = pick('og:site_name', 'application-name')
  if (site) parsed.site_name = site.slice(0, LIMITS.site_name)

  const image = absolute(
    pick(
      'og:image:secure_url',
      'og:image',
      'twitter:image',
      'twitter:image:src',
    ),
    baseUrl,
  )
  if (image) parsed.image_url = image

  // Links: the icon, and an oEmbed endpoint if the page advertises one.
  let iconHref: string | undefined
  let iconRank = 99
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag)
    const rel = (attrs.rel ?? '').toLowerCase()
    const href = attrs.href
    if (!href) continue
    if (rel.includes('icon')) {
      // A real favicon beats an Apple touch icon, which is 180px of rounded
      // square and looks wrong at 16px beside a title.
      const rank = rel.includes('apple') ? 2 : 1
      if (rank < iconRank) {
        iconRank = rank
        iconHref = href
      }
    }
    if (
      rel.includes('alternate') &&
      (attrs.type ?? '').toLowerCase().includes('oembed') &&
      !parsed.oembed
    )
      parsed.oembed = absolute(href, baseUrl) ?? undefined
  }
  const favicon = absolute(iconHref, baseUrl)
  if (favicon) parsed.favicon_url = favicon

  return parsed
}

/**
 * Where `<head>` stops, or the whole (already capped) document.
 *
 * Plenty of real pages put Open Graph tags after `</head>`, so this is a
 * hint rather than a boundary: it exists to keep a `<title>` inside an SVG in
 * the body from being read as the page title.
 */
function cutAtHeadEnd(html: string): number {
  const end = html.search(/<\/head\s*>/i)
  return end === -1 ? html.length : end
}

/** The attributes of one tag, lowercased keys, entity-decoded values. */
function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  const pattern =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let match = pattern.exec(tag)
  while (match) {
    const value = match[3] ?? match[4] ?? match[5] ?? ''
    out[match[1].toLowerCase()] = decodeEntities(value)
    match = pattern.exec(tag)
  }
  return out
}

/**
 * The entities that actually appear in a title.
 *
 * Not a full table. `&amp;` and the quotes are what a CMS emits, and a
 * numeric reference is what a title with an em dash or a smart quote in it
 * comes out as. Anything else is left as written, which reads as itself.
 */
function decodeEntities(value: string): string {
  return (
    value
      .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) =>
        safeCodePoint(parseInt(hex, 16)),
      )
      .replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(Number(dec)))
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      // Last, or "&amp;lt;" would decode twice and produce a "<" the page
      // deliberately escaped.
      .replace(/&amp;/gi, '&')
  )
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** Trimmed, collapsed, capped, and empty becomes undefined. */
function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = decodeEntities(value)
    // Control characters out, including the ones a title could otherwise use
    // to fake a second line in the card.
    // eslint-disable-next-line no-control-regex -- the point is control chars.
    .replace(/[ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean ? clean.slice(0, limit) : undefined
}

/**
 * A relative URL made absolute against the page it was found on.
 *
 * Refused unless it ends up http or https: an `og:image` of
 * `javascript:alert(1)` is a valid URL, and the browser would be the one
 * executing it. The reader checks again through `safeUrl`, and both checks
 * stay, because this one is what stops the value being stored.
 */
function absolute(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined
  try {
    const url = new URL(href.trim(), base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    const text = url.toString()
    return text.length <= LIMITS.url ? text : undefined
  } catch {
    return undefined
  }
}

/** The site name a page did not give: its hostname, without the www. */
function hostLabel(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

/** Where a favicon lives when the page does not say. */
function defaultFavicon(url: string): string | undefined {
  try {
    return new URL('/favicon.ico', url).toString()
  } catch {
    return undefined
  }
}
