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
import { now, type IActorCtx } from '../core/ctx'
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

export function authRoutes(): Hono<IAuthEnv> {
  const app = new Hono<IAuthEnv>()

  app.post('/otp', async (c) => {
    const body = z.object({ email: z.email() }).parse(await c.req.json())
    const db = c.get('db')
    const workspaceId = c.get('workspaceId')
    // Only known member emails get a code; respond identically either way.
    const member = db.query<{ id: string }>(
      'SELECT id FROM actor WHERE workspace_id = ? AND email = ? AND disabled = 0',
      [workspaceId, body.email],
    )
    if (member.length > 0) {
      const code = String(Math.floor(100000 + Math.random() * 900000))
      db.run(
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
    const challenge = db.query<{ id: string; attempts: number }>(
      `SELECT id, attempts FROM otp_challenge
        WHERE workspace_id = ? AND email = ? AND code_hash = ? AND expires_at > ? AND attempts < 5
        ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, body.email, codeHash, now()],
    )
    if (challenge.length === 0) {
      db.run(
        'UPDATE otp_challenge SET attempts = attempts + 1 WHERE workspace_id = ? AND email = ?',
        [workspaceId, body.email],
      )
      return c.json({ ok: false, error: 'invalid code' }, 401)
    }
    db.run('DELETE FROM otp_challenge WHERE workspace_id = ? AND email = ?', [
      workspaceId,
      body.email,
    ])
    const actor = db.query<{ id: string }>(
      'SELECT id FROM actor WHERE workspace_id = ? AND email = ? AND disabled = 0',
      [workspaceId, body.email],
    )[0]
    const token = await createToken(
      db,
      workspaceId,
      actor.id,
      'session',
      ['read', 'write', 'admin'],
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
      db.run('UPDATE auth_token SET revoked_at = ? WHERE token_hash = ?', [
        now(),
        await sha256Hex(token),
      ])
    }
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  app.get('/me', requireAuth(), (c) => {
    const actor = c.get('actor')
    return c.json({
      id: actor.id,
      handle: actor.handle,
      kind: actor.kind,
      role: actor.role,
      scopes: actor.scopes,
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
  const admin = db.query<{ id: string }>(
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
