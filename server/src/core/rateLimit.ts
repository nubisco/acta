/**
 * Request rate limits.
 *
 * The shape is Cloudflare's native rate limiting binding (`[[ratelimits]]` in
 * wrangler.toml): `limit({ key })` answers whether this call fits. On Workers
 * the binding does the counting, at the edge, with no storage operations per
 * request. Everywhere else (Bun, the Docker image, tests) a small in-process
 * fixed window stands in for it, so a self-hosted instance is limited too
 * rather than told it is and not.
 *
 * Reference: `platform/src/middleware/rate-limit.ts`, `edgeRateLimitByIp`. The
 * same two choices are made here, for the same reasons:
 *
 *  - The numbers live in ONE place. On Workers that is wrangler.toml, and
 *    RATE_LIMITS below must agree with it (a test reads both). The in-process
 *    fallback reads RATE_LIMITS.
 *  - `Retry-After` is the whole period, because the binding reports only
 *    success or failure. Conservative, never too eager.
 *
 * Counters on the binding are per Cloudflare location, not global. That is the
 * binding's design and is fine for what these limits are for: stopping one
 * client from flooding the service, not metering a plan.
 */

import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { sha256Hex } from './auth'

/** What the native binding exposes, and what the fallback implements. */
export interface IRateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>
}

/**
 * Every limited surface, with its numbers.
 *
 * `binding` is the wrangler.toml name. `period` is 10 or 60 because those are
 * the only periods the native binding accepts.
 *
 * Chosen to be invisible to a person and to an honest agent, and to stop a
 * loop or a script:
 *  - mcp: an agent batches up to 100 ops per call, so 240 calls a minute is
 *    far more work than any real session does.
 *  - write: a person dragging cards around writes a few times a second at
 *    the very most, and the importers write sequentially.
 *  - ingest: a public contact form. Thirty a minute from one address is
 *    already a flood.
 *  - oauth_register: a connector registers once. Five a minute per address
 *    covers a person retrying a connector setup, and nothing else.
 *  - auth: sign-in codes, invitation acceptance. Each one may send an email
 *    or check a secret, so they are the tightest after registration.
 */
export const RATE_LIMITS = {
  mcp: { binding: 'ACTA_MCP_LIMITER', limit: 240, period: 60 },
  write: { binding: 'ACTA_WRITE_LIMITER', limit: 300, period: 60 },
  ingest: { binding: 'ACTA_INGEST_LIMITER', limit: 30, period: 60 },
  oauth_register: {
    binding: 'ACTA_OAUTH_REGISTER_LIMITER',
    limit: 5,
    period: 60,
  },
  auth: { binding: 'ACTA_AUTH_LIMITER', limit: 20, period: 60 },
} as const satisfies Record<
  string,
  { binding: string; limit: number; period: 10 | 60 }
>

export type TRateLimitName = keyof typeof RATE_LIMITS
export type TRateLimiters = Record<TRateLimitName, IRateLimiter>

/**
 * A fixed window per key, in memory.
 *
 * One process, one map. Expired windows are swept when the map grows, so a
 * stream of distinct keys (one per address) cannot grow it without bound.
 */
export class MemoryRateLimiter implements IRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>()

  constructor(
    private readonly max: number,
    private readonly periodMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const ts = this.clock()
    let window = this.windows.get(key)
    if (!window || ts - window.start >= this.periodMs) {
      window = { start: ts, count: 0 }
      this.windows.set(key, window)
    }
    window.count += 1
    if (this.windows.size > 10_000) this.sweep(ts)
    return Promise.resolve({ success: window.count <= this.max })
  }

  private sweep(ts: number): void {
    for (const [key, window] of this.windows) {
      if (ts - window.start >= this.periodMs) this.windows.delete(key)
    }
  }
}

/** In-process limiters with the RATE_LIMITS numbers, for anything not on Workers. */
export function memoryRateLimiters(): TRateLimiters {
  const out = {} as TRateLimiters
  for (const [name, spec] of Object.entries(RATE_LIMITS)) {
    out[name as TRateLimitName] = new MemoryRateLimiter(
      spec.limit,
      spec.period * 1000,
    )
  }
  return out
}

/**
 * The Workers bindings by name, each falling back to the in-process limiter
 * when its `[[ratelimits]]` block is missing. A missing block is a deploy
 * mistake, and an isolate-local limit is a better failure than none.
 */
export function rateLimitersFromBindings(
  env: Record<string, unknown>,
): TRateLimiters {
  const fallback = memoryRateLimiters()
  const out = {} as TRateLimiters
  for (const [name, spec] of Object.entries(RATE_LIMITS)) {
    const binding = env[spec.binding] as IRateLimiter | undefined
    out[name as TRateLimitName] =
      binding && typeof binding.limit === 'function'
        ? binding
        : fallback[name as TRateLimitName]
  }
  return out
}

type THeader = (name: string) => string | undefined

/**
 * The caller's address, as well as we can tell. `cf-connecting-ip` is set by
 * Cloudflare and is the one to trust. The rest is for a self-hosted instance
 * behind its own proxy, and for tests.
 */
export function clientIp(header: THeader): string {
  return (
    header('cf-connecting-ip') ??
    header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

/**
 * Who is calling: the credential if there is one, the address if not.
 *
 * Keyed by credential so that one busy agent does not starve everyone behind
 * the same office NAT, and hashed so a raw token never becomes a key in
 * somebody else's counter store. A made-up token gets its own bucket, which
 * is fine: it is refused by auth straight after.
 */
export async function callerKey(c: {
  req: { header: THeader }
}): Promise<string> {
  const header = c.req.header('authorization')
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined
  const token = bearer ?? getCookie(c as never, 'acta_session')
  if (token) return `cred:${(await sha256Hex(token)).slice(0, 32)}`
  return `ip:${clientIp(c.req.header.bind(c.req))}`
}

export interface IRateLimitOptions {
  /** Which counter, and how to say no. */
  name: TRateLimitName
  limiter: IRateLimiter
  /** Defaults to the caller's credential, then address. */
  key?: (c: { req: { header: THeader } }) => Promise<string> | string
  /** Only these methods count. Defaults to every method. */
  methods?: string[]
  /** Paths under the mount that this limit leaves alone. */
  skip?: (path: string) => boolean
  /**
   * How to refuse. Defaults to a JSON 429. The MCP endpoint passes its own so
   * the model gets a result it can read rather than a transport failure.
   */
  refuse?: (retryAfterSec: number, req: Request) => Promise<Response> | Response
}

export function rateLimit(opts: IRateLimitOptions): MiddlewareHandler {
  const period = RATE_LIMITS[opts.name].period
  return async (c, next) => {
    if (opts.methods && !opts.methods.includes(c.req.method)) return next()
    if (opts.skip?.(new URL(c.req.url).pathname)) return next()
    const key = await (opts.key ?? callerKey)(c)
    const { success } = await opts.limiter.limit({ key: `${opts.name}:${key}` })
    if (success) return next()
    if (opts.refuse) return opts.refuse(period, c.req.raw)
    return c.json(
      {
        error: 'rate_limited',
        message: `Too many requests. Try again in ${period} seconds.`,
      },
      429,
      { 'retry-after': String(period) },
    )
  }
}

export const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']
