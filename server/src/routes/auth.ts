import { Hono, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { newId } from '@nubisco/acta-shared'
import {
  consoleOtpSender,
  createToken,
  randomToken,
  resolveToken,
  sha256Hex,
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
    const workspaceId = c.get('workspaceId')
    // Only known member emails get a code; respond identically either way.
    const member = await db.query<{ id: string }>(
      'SELECT id FROM actor WHERE workspace_id = ? AND email = ? AND disabled = 0',
      [workspaceId, body.email],
    )
    if (member.length > 0) {
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
    const workspaceId = c.get('workspaceId')
    const codeHash = await sha256Hex(body.code)
    const challenge = await db.query<{ id: string; attempts: number }>(
      `SELECT id, attempts FROM otp_challenge
        WHERE workspace_id = ? AND email = ? AND code_hash = ? AND expires_at > ? AND attempts < 5
        ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, body.email, codeHash, now()],
    )
    if (challenge.length === 0) {
      await db.run(
        'UPDATE otp_challenge SET attempts = attempts + 1 WHERE workspace_id = ? AND email = ?',
        [workspaceId, body.email],
      )
      return c.json({ ok: false, error: 'invalid code' }, 401)
    }
    await db.run(
      'DELETE FROM otp_challenge WHERE workspace_id = ? AND email = ?',
      [workspaceId, body.email],
    )
    const actor = (
      await db.query<{ id: string; role: string }>(
        'SELECT id, role FROM actor WHERE workspace_id = ? AND email = ? AND disabled = 0',
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

  return app
}

/** Auth middleware: Bearer token (agents) or session cookie (humans). */
export function requireAuth(): MiddlewareHandler<IAuthEnv> {
  return async (c, next) => {
    const db = c.get('db')
    const header = c.req.header('authorization')
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined
    const token = bearer ?? getCookie(c, SESSION_COOKIE)
    if (!token) return c.json({ error: 'unauthorized' }, 401)
    const actor = await resolveToken(db, token)
    if (!actor) return c.json({ error: 'unauthorized' }, 401)
    c.set('actor', actor)
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
