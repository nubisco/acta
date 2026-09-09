import { Hono, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { newId } from '@nubisco/acta-shared'
import {
  actorInWorkspace,
  consoleOtpSender,
  createToken,
  randomToken,
  resolveToken,
  sha256Hex,
  workspaceBySlug,
  workspacesForEmail,
  type TOtpSender,
} from '../core/auth'
import { now, type IActorCtx, type ICtx } from '../core/ctx'
import { emitEvent, flushPendingEvents } from '../core/events'
import { JwksVerifier, type ISsoConfig } from '../core/sso'
import type { ISqlDriver } from '../db'

const SESSION_COOKIE = 'acta_session'
const SESSION_TTL = 30 * 24 * 3600 * 1000
const OTP_TTL = 10 * 60 * 1000

export interface IAuthEnv {
  Variables: {
    db: ISqlDriver
    workspaceId: string
    actor: IActorCtx
  }
}

let otpSender: TOtpSender = consoleOtpSender
export function setOtpSender(sender: TOtpSender): void {
  otpSender = sender
}

export interface ISsoRuntime {
  config: ISsoConfig
  verifier: JwksVerifier
}

const SSO_STATE_COOKIE = 'acta_sso_state'

export function authRoutes(sso?: ISsoRuntime): Hono<IAuthEnv> {
  const app = new Hono<IAuthEnv>()

  app.get('/config', (c) => c.json({ sso: sso !== undefined, otp: true }))

  app.get('/sso/start', (c) => {
    if (!sso) return c.json({ error: 'sso not configured' }, 404)
    const state = randomToken(16)
    setCookie(c, SSO_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    })
    const url = new URL(sso.config.authorizeUrl)
    url.searchParams.set('app_id', sso.config.appId)
    url.searchParams.set(
      'redirect_uri',
      new URL('/api/v1/auth/sso/callback', c.req.url).toString(),
    )
    url.searchParams.set('state', state)
    return c.redirect(url.toString(), 302)
  })

  app.get('/sso/callback', async (c) => {
    if (!sso) return c.json({ error: 'sso not configured' }, 404)
    const error = c.req.query('error')
    if (error) return c.redirect(`/login?error=${encodeURIComponent(error)}`)
    const token = c.req.query('token')
    const state = c.req.query('state')
    const expectedState = getCookie(c, SSO_STATE_COOKIE)
    deleteCookie(c, SSO_STATE_COOKIE, { path: '/' })
    if (!token || !state || !expectedState || state !== expectedState) {
      return c.redirect('/login?error=sso_state')
    }
    let claims
    try {
      claims = await sso.verifier.verify(token)
    } catch {
      return c.redirect('/login?error=sso_token')
    }
    const db = c.get('db')
    const workspaceId = c.get('workspaceId')
    let member = (
      await db.query<{ id: string; disabled: number }>(
        "SELECT id, disabled FROM actor WHERE workspace_id = ? AND email = ? AND kind = 'human'",
        [workspaceId, claims.email],
      )
    )[0]
    if (member?.disabled === 1) return c.redirect('/login?error=disabled')
    if (!member) {
      if (!sso.config.autoProvision)
        return c.redirect('/login?error=not_a_member')
      const id = newId('act')
      const base = claims.email
        .split('@')[0]
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-|-$/g, '')
      const clash = await db.query(
        'SELECT id FROM actor WHERE workspace_id = ? AND handle = ?',
        [workspaceId, base],
      )
      const handle = clash.length > 0 ? `${base}-${id.slice(-4)}` : base
      await db.run(
        `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, created_at)
         VALUES (?, ?, 'human', ?, ?, ?, ?, ?)`,
        [
          id,
          workspaceId,
          handle,
          claims.name ?? claims.email,
          claims.email,
          claims.role === 'admin' ? 'admin' : 'member',
          now(),
        ],
      )
      const system = (
        await db.query<{ id: string; handle: string }>(
          "SELECT id, handle FROM actor WHERE workspace_id = ? AND kind = 'system' LIMIT 1",
          [workspaceId],
        )
      )[0]
      const ctx: ICtx = {
        db,
        workspaceId,
        actor: {
          id: system.id,
          kind: 'system',
          handle: system.handle,
          role: 'member',
          scopes: ['write'],
        },
      }
      await emitEvent(
        ctx,
        'member.provisioned',
        'actor',
        id,
        `provisioned member @${handle} via SSO`,
      )
      flushPendingEvents()
      member = { id, disabled: 0 }
    }
    const memberRole = (
      await db.query<{ role: string }>('SELECT role FROM actor WHERE id = ?', [
        member.id,
      ])
    )[0].role
    const session = await createToken(
      db,
      workspaceId,
      member.id,
      'session',
      memberRole === 'admin' ? ['read', 'write', 'admin'] : ['read', 'write'],
      SESSION_TTL,
    )
    setCookie(c, SESSION_COOKIE, session, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL / 1000,
    })
    return c.redirect('/', 302)
  })

  app.post('/otp', async (c) => {
    const body = z.object({ email: z.email() }).parse(await c.req.json())
    const db = c.get('db')
    // Across every workspace, not just one: a person may be a member of
    // somewhere other than the workspace this deployment happens to have
    // bootstrapped, and asking them to know that first would be absurd.
    // The challenge is filed against the first workspace they belong to,
    // because the row needs one, but the code is for the person.
    const member = await db.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM actor
        WHERE lower(email) = lower(?) AND disabled = 0 AND kind = 'human'
        ORDER BY created_at LIMIT 1`,
      [body.email],
    )
    // Only known member emails get a code; respond identically either way.
    if (member.length > 0) {
      const workspaceId = member[0].workspace_id
      const code = String(Math.floor(100000 + Math.random() * 900000))
      await db.run(
        'INSERT INTO otp_challenge (id, workspace_id, email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          newId('act'),
          workspaceId,
          body.email,
          await sha256Hex(code),
          now() + OTP_TTL,
          now(),
        ],
      )
      await otpSender(body.email, code)
    }
    return c.json({ ok: true })
  })

  app.post('/verify', async (c) => {
    const body = z
      .object({ email: z.email(), code: z.string().min(6).max(6) })
      .parse(await c.req.json())
    const db = c.get('db')
    const codeHash = await sha256Hex(body.code)
    // Matched on the email rather than a workspace, for the same reason the
    // code was issued that way.
    const challenge = await db.query<{ id: string; workspace_id: string }>(
      `SELECT id, workspace_id FROM otp_challenge
        WHERE lower(email) = lower(?) AND code_hash = ? AND expires_at > ? AND attempts < 5
        ORDER BY created_at DESC LIMIT 1`,
      [body.email, codeHash, now()],
    )
    if (challenge.length === 0) {
      await db.run(
        'UPDATE otp_challenge SET attempts = attempts + 1 WHERE lower(email) = lower(?)',
        [body.email],
      )
      return c.json({ ok: false, error: 'invalid code' }, 401)
    }
    await db.run('DELETE FROM otp_challenge WHERE lower(email) = lower(?)', [
      body.email,
    ])
    // The session is minted in the workspace the challenge was filed against.
    // Which one that is barely matters now: the token carries the person's
    // email, so every other workspace they belong to is a link away.
    const workspaceId = challenge[0].workspace_id
    const actor = (
      await db.query<{ id: string; role: string }>(
        'SELECT id, role FROM actor WHERE workspace_id = ? AND lower(email) = lower(?) AND disabled = 0',
        [workspaceId, body.email],
      )
    )[0]
    const token = await createToken(
      db,
      workspaceId,
      actor.id,
      'session',
      actor.role === 'admin' ? ['read', 'write', 'admin'] : ['read', 'write'],
      SESSION_TTL,
    )
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL / 1000,
    })
    return c.json({ ok: true })
  })

  app.post('/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE)
    if (token) {
      const db = c.get('db')
      await db.run(
        'UPDATE auth_token SET revoked_at = ? WHERE token_hash = ?',
        [now(), await sha256Hex(token)],
      )
    }
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  app.get('/me', requireAuth(), async (c) => {
    const actor = c.get('actor')
    const row = (
      await c.get('db').query<{
        email: string | null
        name: string
      }>('SELECT email, name FROM actor WHERE id = ?', [actor.id])
    )[0]
    return c.json({
      id: actor.id,
      handle: actor.handle,
      kind: actor.kind,
      role: actor.role,
      scopes: actor.scopes,
      email: row?.email ?? undefined,
      name: row?.name ?? undefined,
    })
  })

  /**
   * The workspaces this person can open. Drives the picker, and lets the app
   * skip it entirely when there is only one, which is the common case.
   */
  app.get('/workspaces', requireAuth(), async (c) => {
    const db = c.get('db')
    const actor = c.get('actor')
    const email = (
      await db.query<{ email: string | null }>(
        'SELECT email FROM actor WHERE id = ?',
        [actor.id],
      )
    )[0]?.email
    if (!email) {
      // An agent token has no person behind it, so it reaches exactly the one
      // workspace it was minted in.
      const own = await db.query<{ id: string; name: string; slug: string }>(
        'SELECT id, name, slug FROM workspace WHERE id = ?',
        [c.get('workspaceId')],
      )
      return c.json({ workspaces: own })
    }
    return c.json({ workspaces: await workspacesForEmail(db, email) })
  })

  return app
}

/** Auth middleware: Bearer token (agents) or session cookie (humans). */
export function requireAuth(): MiddlewareHandler<IAuthEnv> {
  return async (c, next) => {
    const db = c.get('db')
    const authed = await authedFrom(c)
    if (!authed) return c.json({ error: 'unauthorized' }, 401)
    c.set('actor', authed)
    // Without a workspace segment the request means "the one the token was
    // minted in", which keeps the unprefixed endpoints working.
    c.set('workspaceId', authed.workspaceId)
    void db
    await next()
  }
}

/** The token on the request, from either the bearer header or the cookie. */
async function authedFrom(c: {
  get: (k: 'db') => ISqlDriver
  req: { header: (n: string) => string | undefined }
}) {
  const header = c.req.header('authorization')
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined
  const token = bearer ?? getCookie(c as never, SESSION_COOKIE)
  if (!token) return null
  return resolveToken(c.get('db'), token)
}

/**
 * Authenticates a request addressed to a named workspace.
 *
 * The workspace comes from the URL, not from the token, so one session can
 * hold two workspaces open in two tabs. The token proves who you are; this
 * decides what you are inside the workspace you asked for, and refuses when
 * the answer is "nothing".
 */
export function requireWorkspace(): MiddlewareHandler<IAuthEnv> {
  return async (c, next) => {
    const db = c.get('db')
    const authed = await authedFrom(c)
    if (!authed) return c.json({ error: 'unauthorized' }, 401)

    const slug = c.req.param('workspace')
    const workspace = slug ? await workspaceBySlug(db, slug) : null
    // A workspace that does not exist and one you cannot see are the same
    // answer on purpose: enumerating names is not a feature.
    if (!workspace) return c.json({ error: 'workspace not found' }, 404)

    const actor = await actorInWorkspace(db, authed, workspace.id)
    if (!actor) return c.json({ error: 'workspace not found' }, 404)

    c.set('actor', actor)
    c.set('workspaceId', workspace.id)
    await next()
  }
}

/** Dev/bootstrap: mint an admin session token from the CLI (bun run token). */
export async function mintBootstrapToken(
  db: ISqlDriver,
  workspaceId: string,
): Promise<string> {
  const admin = await db.query<{ id: string }>(
    "SELECT id FROM actor WHERE workspace_id = ? AND role = 'admin' AND kind = 'human' ORDER BY created_at LIMIT 1",
    [workspaceId],
  )
  if (admin.length === 0) throw new Error('no admin actor')
  return createToken(
    db,
    workspaceId,
    admin[0].id,
    'session',
    ['read', 'write', 'admin'],
    SESSION_TTL,
  )
}

export { SESSION_COOKIE, randomToken }
