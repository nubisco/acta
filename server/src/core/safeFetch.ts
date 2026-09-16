/**
 * Fetching a URL that came from user content.
 *
 * A link preview is an SSRF sink by construction: somebody types a URL into a
 * document and the server goes and fetches it. Without this module that is a
 * request the server makes, from inside the network, to wherever the author
 * chose, and the interesting targets are not on the public internet. They are
 * `http://169.254.169.254/latest/meta-data/iam/security-credentials/`, the
 * admin port on 127.0.0.1 that has no auth because it is only bound locally,
 * and the 10/8 address of the database.
 *
 * So the rules here are deliberately paranoid, and they are an allowlist
 * wherever an allowlist is possible:
 *
 *  - http and https only. Everything else (`file:`, `gopher:`, `ftp:`,
 *    `data:`) is refused before a socket is opened.
 *  - The hostname is RESOLVED and every address it resolves to is checked.
 *    Checking the literal string is not enough: `evil.test` is a public name
 *    and DNS is free to point it at 127.0.0.1, which is exactly how this is
 *    attacked in practice.
 *  - Resolution failing is a refusal, not a pass. Fail closed.
 *  - Redirects are followed by hand, capped, and every hop is checked again,
 *    because a public URL that 302s to `http://[::1]/` is the same attack
 *    wearing a hat.
 *  - Response size and wall time are both capped, so one hostile or merely
 *    slow site cannot hold a connection or a heap open.
 *
 * The one thing this cannot close portably is DNS rebinding in the window
 * between our resolution and the runtime's own: `fetch` takes a URL, not a
 * pinned address, so a name that answers with a public address for our lookup
 * and a private one microseconds later would slip through. Closing that needs
 * connection-level control neither Bun's nor the Workers' fetch exposes. The
 * TTL cache in front of this means the window is opened rarely, and every
 * range worth reaching is still refused on the way back out through the
 * redirect check.
 */

/** Wall time for a single hop. A preview is a nicety, not worth a long wait. */
export const FETCH_TIMEOUT_MS = 5_000

/** Hops followed. Three is more than any honest site needs. */
export const MAX_REDIRECTS = 3

/**
 * Bytes read before the body is cut off.
 *
 * Open Graph tags live in `<head>`, so 256 kB is generous. The cap is what
 * stops a URL that streams gigabytes from being a one-request memory attack.
 */
export const MAX_BYTES = 262_144

export interface IFetchDeps {
  fetch: typeof fetch
  /** Hostname to IP addresses. Returning none means "refuse". */
  resolve: (hostname: string) => Promise<string[]>
  /**
   * Wall time for one hop, headers and body together. Injected so a test can
   * prove the cap without waiting five seconds for it.
   */
  timeoutMs?: number
}

export interface IFetchResult {
  /** The URL actually read, after redirects. */
  url: string
  contentType: string
  body: string
  /** True when the body was cut off at MAX_BYTES. */
  truncated: boolean
}

/** Why a URL was refused, for the log and the test name. */
export type TRefusal =
  | 'malformed'
  | 'scheme'
  | 'credentials'
  | 'unresolved'
  | 'private-address'
  | 'blocked-host'

export class UrlRefused extends Error {
  constructor(readonly reason: TRefusal) {
    super(`url refused: ${reason}`)
  }
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * Dotted-quad to four bytes, or null.
 *
 * The decimal, octal and hex spellings of an address (`2130706433`,
 * `0177.0.0.1`) are not handled here because they never reach here: the
 * WHATWG URL parser normalises all of them to dotted-quad while parsing, and
 * `assertPublicUrl` reads the hostname back off a parsed URL. There is a test
 * for exactly that, because it is the sort of thing a dependency changes.
 */
function parseIpv4(value: string): number[] | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    bytes.push(n)
  }
  return bytes
}

/** An IPv6 literal (already stripped of its brackets) to sixteen bytes. */
function parseIpv6(value: string): number[] | null {
  const text = value.toLowerCase()
  if (!/^[0-9a-f:.]+$/.test(text)) return null

  // A trailing IPv4 part, as in ::ffff:127.0.0.1, becomes two groups.
  let head = text
  let tail: number[] = []
  const lastColon = text.lastIndexOf(':')
  const after = text.slice(lastColon + 1)
  if (after.includes('.')) {
    const v4 = parseIpv4(after)
    if (!v4) return null
    tail = v4
    head = text.slice(0, lastColon + 1) + '0:0'
  }

  const halves = head.split('::')
  if (halves.length > 2) return null
  const toGroups = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null
      out.push(parseInt(group, 16))
    }
    return out
  }
  const left = toGroups(halves[0])
  const right = halves.length === 2 ? toGroups(halves[1]) : []
  if (!left || !right) return null

  const fill = 8 - left.length - right.length
  if (halves.length === 2 ? fill < 0 : fill !== 0) return null
  const groups = [
    ...left,
    ...new Array<number>(Math.max(fill, 0)).fill(0),
    ...right,
  ]
  if (groups.length !== 8) return null

  const bytes = groups.flatMap((g) => [(g >> 8) & 0xff, g & 0xff])
  if (tail.length === 4) bytes.splice(12, 4, ...tail)
  return bytes
}

function inRange(bytes: number[], prefix: number[], bits: number): boolean {
  let remaining = bits
  for (let i = 0; i < prefix.length && remaining > 0; i++) {
    const take = Math.min(8, remaining)
    const mask = 0xff << (8 - take)
    if ((bytes[i] & mask) !== (prefix[i] & mask)) return false
    remaining -= take
  }
  return true
}

/**
 * Everything that is not a public unicast address on the internet.
 *
 * Written as a blocklist of ranges rather than an allowlist of one, because
 * the public internet has no compact description. Each entry is here for a
 * reason, and the ones that matter most are the ones people forget:
 * 169.254/16 (which is where every cloud metadata endpoint lives), 100.64/10
 * (carrier-grade NAT, and what several hosts put their internal services on),
 * and 0.0.0.0/8 (which several stacks route to localhost).
 */
const BLOCKED_V4: [number[], number][] = [
  [[0, 0, 0, 0], 8], // "this network", routed to localhost by some stacks
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local, and every cloud metadata endpoint
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // TEST-NET-1
  [[192, 88, 99, 0], 24], // 6to4 relay anycast
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // TEST-NET-2
  [[203, 0, 113, 0], 24], // TEST-NET-3
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved, includes 255.255.255.255
]

/**
 * True for any address the server must not be pointed at.
 *
 * An address it cannot parse is blocked too. A string that is neither a v4
 * nor a v6 literal is not something to guess about.
 */
export function isBlockedAddress(address: string): boolean {
  const literal = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '')

  const v4 = parseIpv4(literal)
  if (v4) return BLOCKED_V4.some(([prefix, bits]) => inRange(v4, prefix, bits))

  const v6 = parseIpv6(literal)
  if (!v6) return true

  // An IPv4 address wearing an IPv6 spelling is still that address, so the
  // embedded one is what gets checked. ::ffff:127.0.0.1 and 64:ff9b::7f00:1
  // both reach loopback on a dual-stack host.
  const mapped = inRange(v6, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)
  const nat64 = inRange(v6, [0, 0x64, 0xff, 0x9b], 32)
  if (mapped || nat64) {
    const embedded = v6.slice(12)
    return BLOCKED_V4.some(([prefix, bits]) => inRange(embedded, prefix, bits))
  }
  // 6to4 carries its v4 address in the next 32 bits.
  if (inRange(v6, [0x20, 0x02], 16)) {
    const embedded = v6.slice(2, 6)
    return BLOCKED_V4.some(([prefix, bits]) => inRange(embedded, prefix, bits))
  }

  const blockedV6: [number[], number][] = [
    [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 128], // unspecified
    [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128], // ::1 loopback
    [[0xfc], 7], // fc00::/7 unique local
    [[0xfe, 0x80], 10], // fe80::/10 link-local
    [[0xff], 8], // ff00::/8 multicast
    [[0x20, 0x01, 0x00, 0x00], 32], // Teredo
    [[0x20, 0x01, 0x0d, 0xb8], 32], // documentation
  ]
  return blockedV6.some(([prefix, bits]) => inRange(v6, prefix, bits))
}

/**
 * Names that are never worth resolving.
 *
 * Belt and braces: each of these resolves into a range the address check
 * already refuses. They are listed so the refusal happens before a DNS query
 * is sent, which keeps a document full of `metadata.google.internal` from
 * being a way to make the server emit traffic at all.
 */
const BLOCKED_HOST_SUFFIXES = [
  'localhost',
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.home.arpa',
  '.in-addr.arpa',
  '.ip6.arpa',
]

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return true
  return BLOCKED_HOST_SUFFIXES.some(
    (suffix) => host === suffix.replace(/^\./, '') || host.endsWith(suffix),
  )
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * The URL, parsed, if it is safe to make a request to. Throws otherwise.
 *
 * Credentials in the URL are refused rather than stripped: `http://a@b/` is
 * read differently by different parsers, and a preview is not worth carrying
 * somebody's basic-auth header to a host they may not have meant.
 */
export async function assertPublicUrl(
  raw: string,
  deps: IFetchDeps,
): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UrlRefused('malformed')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new UrlRefused('scheme')
  if (url.username || url.password) throw new UrlRefused('credentials')

  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (isBlockedHostname(hostname)) throw new UrlRefused('blocked-host')

  // An address written literally is checked as itself and never resolved:
  // asking DNS about "127.0.0.1" is both pointless and a way to be lied to.
  if (parseIpv4(hostname) || hostname.includes(':')) {
    if (isBlockedAddress(hostname)) throw new UrlRefused('private-address')
    return url
  }

  let addresses: string[]
  try {
    addresses = await deps.resolve(hostname)
  } catch {
    throw new UrlRefused('unresolved')
  }
  // Fail closed. A name nobody can resolve is not a name to try anyway.
  if (addresses.length === 0) throw new UrlRefused('unresolved')
  // EVERY address, not the first: a name that answers with one public address
  // and one private one must be refused, or the choice of which to connect to
  // belongs to the resolver rather than to us.
  if (addresses.some((address) => isBlockedAddress(address)))
    throw new UrlRefused('private-address')

  return url
}

/**
 * GET a user-supplied URL, or throw.
 *
 * Redirects are followed here rather than by `fetch`, because `redirect:
 * 'follow'` would take the hops without showing them to us and the second hop
 * is where the private address usually is.
 */
export async function safeFetch(
  raw: string,
  deps: IFetchDeps,
  accept = 'text/html,application/xhtml+xml',
): Promise<IFetchResult> {
  let target = raw

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(target, deps)
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      deps.timeoutMs ?? FETCH_TIMEOUT_MS,
    )
    try {
      const res = await deps.fetch(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept,
          // Named honestly. A preview fetch is a robot, and a site that would
          // rather not be read by one should be able to say so.
          'user-agent': 'ActaLinkPreview/1.0 (+https://nubisco.io/acta)',
          'accept-language': 'en',
        },
      })

      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        // Resolved against the hop it came from, so a relative Location works
        // and an absolute one replaces the whole URL, both the way a browser
        // would read them. The next turn of the loop checks it from scratch.
        target = new URL(location, url).toString()
        continue
      }
      if (!res.ok) throw new Error(`http ${res.status}`)

      const contentType = res.headers.get('content-type') ?? ''
      const declared = Number(res.headers.get('content-length') ?? '0')
      // The cheapest refusal: a site that admits up front that it is too big.
      if (declared > MAX_BYTES * 8) throw new Error('too large')

      // Inside the timer, deliberately. Clearing it once the headers arrived
      // left the body read uncapped in time, so a site that sent headers
      // promptly and then dribbled the page out could hold the request open
      // for as long as it liked. The size cap alone does not close that: a
      // byte a minute never reaches it.
      const { text, truncated } = await readCapped(res)
      return { url: url.toString(), contentType, body: text, truncated }
    } finally {
      clearTimeout(timer)
    }
  }

  throw new Error('too many redirects')
}

/**
 * The body, up to MAX_BYTES, then stop reading.
 *
 * Reading the stream rather than calling `res.text()`, because `text()` has
 * no cap: a URL that streams for as long as we listen would otherwise be a
 * memory exhaustion bug with a very short reproduction.
 */
async function readCapped(
  res: Response,
): Promise<{ text: string; truncated: boolean }> {
  const body = res.body
  if (!body) return { text: '', truncated: false }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      chunks.push(value)
      size += value.byteLength
      if (size >= MAX_BYTES) {
        truncated = true
        break
      }
    }
  } finally {
    // The connection goes away with the reader. Without this a truncated read
    // leaves the socket open until the far end gives up.
    await reader.cancel().catch(() => {})
  }

  const joined = new Uint8Array(Math.min(size, MAX_BYTES))
  let offset = 0
  for (const chunk of chunks) {
    const room = joined.length - offset
    if (room <= 0) break
    joined.set(chunk.subarray(0, Math.min(room, chunk.length)), offset)
    offset += Math.min(room, chunk.length)
  }
  // Lossy on purpose: a multi-byte character cut in half at the cap must not
  // throw, it must simply not be part of the title.
  return { text: new TextDecoder('utf-8').decode(joined), truncated }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Hostname to addresses, on whichever runtime this is.
 *
 * Bun has node:dns. Workers has no resolver at all, so there it asks a
 * DNS-over-HTTPS endpoint, which is a fetch to a fixed public host rather
 * than to anything the document chose. Either way a failure returns nothing
 * and nothing means refused.
 */
export async function defaultResolve(hostname: string): Promise<string[]> {
  try {
    const dns = await import('node:dns/promises')
    const found = await dns.lookup(hostname, { all: true, verbatim: true })
    return found.map((entry) => entry.address)
  } catch (err) {
    // A resolver that answered "no such host" is an answer, not a missing
    // runtime, and must not fall through to a second lookup that could say
    // otherwise.
    if (err && typeof err === 'object' && 'code' in err) return []
    return resolveOverHttps(hostname)
  }
}

async function resolveOverHttps(hostname: string): Promise<string[]> {
  const ask = async (type: 'A' | 'AAAA'): Promise<string[]> => {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
      {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    )
    if (!res.ok) return []
    const body = (await res.json()) as {
      Answer?: { type: number; data: string }[]
    }
    return (body.Answer ?? [])
      .filter((a) => a.type === (type === 'A' ? 1 : 28))
      .map((a) => a.data)
  }
  try {
    const [v4, v6] = await Promise.all([ask('A'), ask('AAAA')])
    return [...v4, ...v6]
  } catch {
    return []
  }
}

/** The deps a real request uses. Tests pass their own. */
export function realFetchDeps(): IFetchDeps {
  return { fetch, resolve: defaultResolve }
}
