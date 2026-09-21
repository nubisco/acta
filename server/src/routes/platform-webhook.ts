/**
 * Signed events from the identity provider.
 *
 * Without this, removing someone from Acta on the provider stopped them
 * signing in again but left everything they already held working: their
 * session until it expired, and any personal or agent token they had minted.
 * `membership.removed` now disables the actor and revokes every credential it
 * holds, at once.
 *
 * The provider signs the raw request body with the app's webhook secret and
 * sends `X-Nubisco-Signature: sha256=<hex>`. It delivers fire-and-forget with
 * no retry, which is why sign-in still refreshes the avatar and why tokens
 * still expire on their own: this is the fast path, not the only one.
 *
 * node:crypto is deliberately not used here. This runs on Cloudflare Workers
 * as well as Bun, and WebCrypto is the only HMAC both have. routes/hooks.ts
 * makes the same choice for the GitHub receiver.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import type { ISqlDriver } from '../db'
import { now } from '../core/ctx'
import { acceptedPicture } from '../core/avatar'

interface IPlatformHookEnv {
  Variables: { db: ISqlDriver }
}

/**
 * A delivery older or newer than this is refused, so one captured off the wire
 * cannot be replayed later. Generous enough to absorb clock skew between the
 * two sides.
 */
const MAX_SKEW_MS = 5 * 60 * 1000

const zDelivery = z.object({
  event: z.string().min(1),
  timestamp: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
})

const zUserUpdatedData = z.object({
  user_id: z.string().min(1),
  // null when the avatar was removed. Optional because a delivery about some
  // other change must leave the picture alone, which is what the `in` check at
  // the call site does.
  picture: z.string().nullable().optional(),
})

const zMembershipData = z.object({
  user_id: z.string().min(1),
  app_id: z.string().optional(),
})

/**
 * Constant-time comparison. A fast `===` on a signature leaks how many leading
 * bytes were right, which is enough to forge one byte at a time.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  )
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function signatureMatches(
  secret: string,
  rawBody: string,
  header: string | undefined,
): Promise<boolean> {
  if (!header?.startsWith('sha256=')) return false
  const given = header.slice('sha256='.length)
  // Hex of a sha256 is 64 characters. Checking the shape first means a
  // malformed header is rejected on its length rather than reaching the
  // compare, and keeps the compare over two equal-length strings.
  if (!/^[0-9a-f]{64}$/i.test(given)) return false
  const expected = await hmacSha256Hex(secret, rawBody)
  return timingSafeEqual(given.toLowerCase(), expected)
}

export function platformWebhookRoutes(
  secret: string | undefined,
  issuer: string | undefined,
): Hono<IPlatformHookEnv> {
  const app = new Hono<IPlatformHookEnv>()

  app.post('/webhook', async (c) => {
    // Not configured: answer as if the route were not there, rather than
    // advertising an endpoint that accepts nothing.
    if (!secret) return c.json({ error: 'not found' }, 404)

    // The exact bytes the provider signed. Parsing first and re-serialising
    // would reorder or reformat them and fail every legitimate delivery.
    const raw = await c.req.text()
    if (
      !(await signatureMatches(
        secret,
        raw,
        c.req.header('x-nubisco-signature'),
      ))
    ) {
      return c.json({ error: 'bad signature' }, 401)
    }

    let delivery: z.infer<typeof zDelivery>
    try {
      delivery = zDelivery.parse(JSON.parse(raw))
    } catch {
      return c.json({ error: 'malformed delivery' }, 400)
    }

    const sentAt = Date.parse(delivery.timestamp)
    if (Number.isNaN(sentAt) || Math.abs(now() - sentAt) > MAX_SKEW_MS) {
      return c.json({ error: 'stale delivery' }, 401)
    }

    const db = c.get('db')

    switch (delivery.event) {
      case 'membership.removed': {
        const { user_id } = zMembershipData.parse(delivery.data)
        const actors = await db.query<{ id: string; role: string }>(
          `SELECT id, role FROM actor
            WHERE platform_user_id = ? AND kind = 'human'`,
          [user_id],
        )
        if (actors.length === 0) {
          return c.json({ ok: true, handled: false, reason: 'unknown user' })
        }

        let revoked = 0
        for (const actor of actors) {
          await db.run(
            `UPDATE actor SET disabled = 1, disabled_source = 'platform'
              WHERE id = ?`,
            [actor.id],
          )
          // Every credential, not just the browser session: a personal token
          // outlives a session, and an agent token minted by this person keeps
          // working indefinitely. Leaving those is the exact hole this closes.
          //
          // Counted with a SELECT rather than UPDATE ... RETURNING, which
          // nothing else in Acta uses and which the two drivers do not agree
          // on. Two statements that work on both beat one that works on one.
          const rows = await db.query<{ id: string }>(
            `SELECT id FROM auth_token
              WHERE actor_id = ? AND revoked_at IS NULL`,
            [actor.id],
          )
          await db.run(
            `UPDATE auth_token SET revoked_at = ?
              WHERE actor_id = ? AND revoked_at IS NULL`,
            [now(), actor.id],
          )
          revoked += rows.length
        }

        if (actors.some((a) => a.role === 'admin')) {
          const left = await db.query(
            `SELECT id FROM actor
              WHERE kind = 'human' AND role = 'admin' AND disabled = 0 LIMIT 1`,
          )
          if (left.length === 0) {
            // Disabled anyway: the provider is the authority on who has
            // access, and keeping a removed admin's credentials alive is what
            // this route exists to prevent. Adding them back re-enables them.
            console.warn(
              'platform removed the last enabled admin; no one can administer ' +
                'this instance until an admin is re-added on the platform',
            )
          }
        }
        return c.json({ ok: true, handled: true, revoked })
      }

      case 'membership.added': {
        const { user_id } = zMembershipData.parse(delivery.data)
        // Re-enable only what the platform itself disabled. Someone an admin
        // disabled here must stay disabled, and someone removed and re-added
        // on the platform would otherwise stay locked out for good, because
        // sign-in refuses a disabled actor. Their old credentials stay
        // revoked: they sign in again and mint new ones.
        const rows = await db.query<{ id: string }>(
          `SELECT id FROM actor
            WHERE platform_user_id = ? AND kind = 'human'
              AND disabled = 1 AND disabled_source = 'platform'`,
          [user_id],
        )
        await db.run(
          `UPDATE actor SET disabled = 0, disabled_source = NULL
            WHERE platform_user_id = ? AND kind = 'human'
              AND disabled = 1 AND disabled_source = 'platform'`,
          [user_id],
        )
        // Someone who has never signed in has no actor yet, and needs none:
        // sign-in provisions them.
        return c.json({ ok: true, handled: rows.length > 0 })
      }

      case 'user.updated': {
        const data = zUserUpdatedData.parse(delivery.data)
        // Only a delivery that says something about the picture touches it. A
        // later version may send user.updated for other fields, and an absent
        // key must not be read as "no avatar".
        if (!('picture' in delivery.data)) {
          return c.json({ ok: true, handled: false })
        }
        const picture = acceptedPicture(data.picture, issuer)
        // avatar_source guards a picture the person uploaded here, exactly as
        // sign-in does. The provider owns the SSO-seeded one, not that choice.
        const rows = await db.query<{ id: string }>(
          `SELECT id FROM actor
            WHERE platform_user_id = ? AND kind = 'human'
              AND avatar_source != 'upload' AND avatar_url IS NOT ?`,
          [data.user_id, picture],
        )
        await db.run(
          `UPDATE actor SET avatar_url = ?
            WHERE platform_user_id = ? AND kind = 'human'
              AND avatar_source != 'upload' AND avatar_url IS NOT ?`,
          [picture, data.user_id, picture],
        )
        // Someone who has never signed in has no actor. Their first sign-in
        // reads the claim, so nothing is lost by ignoring this.
        return c.json({ ok: true, handled: rows.length > 0 })
      }

      default:
        // subscription.changed, and anything the provider adds later.
        // Answered 200 so a new event type is not treated as a failed
        // delivery: the provider disables a hook that keeps erroring.
        return c.json({ ok: true, handled: false })
    }
  })

  return app
}
