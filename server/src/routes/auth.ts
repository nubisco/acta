import { Hono, type Context, type MiddlewareHandler } from 'hono'
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
import { JwksVerifier, type ISsoClaims, type ISsoConfig } from '../core/sso'
import { OidcClient, type IOidcConfig } from '../core/oidc'
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

/**
 * The two ways an external provider can sign someone in.
 *
 * `handover` is Acta's original contract: the provider redirects back with a
 * signed JWT in the query. `oidc` is the standard authorization-code flow,
 * which is what every off-the-shelf provider actually speaks. They differ
 * only in how claims are obtained; everything after that (mapping to a
 * member, provisioning, minting the session) is shared.
 */
export type TSsoRuntime =
  | { mode: 'handover'; config: ISsoConfig; verifier: JwksVerifier }
  | { mode: 'oidc'; config: IOidcConfig; client: OidcClient }

const SSO_STATE_COOKIE = 'acta_sso_state'
/** The PKCE verifier and nonce, which must survive the trip to the provider. */
const OIDC_HANDSHAKE_COOKIE = 'acta_oidc_handshake'

/**
 * Everything after "who is this": map the claims to a workspace member,
 * provision one if the instance allows it, and mint the session.
 *
 * Shared by both provider modes deliberately. The difference between a JWT
 * handed over in the query and one fetched through a code exchange ends at
 * the claims; if provisioning drifted between the two, an instance would get
 * different roles depending on how its provider happened to be wired.
 */
async function signInWithClaims(
  c: Context<IAuthEnv>,
  claims: ISsoClaims,
  autoProvision: boolean,
): Promise<Response> {
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
    if (!autoProvision) return c.redirect('/login?error=not_a_member')
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
    // An instance that delegates identity to a provider seeds no admin of its
    // own (see bootstrap), so without this the first person to sign in to a
    // fresh install becomes a member of a workspace that has no
    // administrator, and nothing can ever be administered. Only ever promotes
    // into a vacuum: the moment one admin exists this is inert, so it cannot
    // be used to escalate on an established workspace.
    const admins = await db.query(
      `SELECT id FROM actor
        WHERE workspace_id = ? AND kind = 'human' AND role = 'admin'
              AND disabled = 0 LIMIT 1`,
      [workspaceId],
    )
    const firstAdmin = admins.length === 0
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, created_at)
       VALUES (?, ?, 'human', ?, ?, ?, ?, ?)`,
      [
        id,
        workspaceId,
        handle,
        claims.name ?? claims.email,
        claims.email,
        claims.role === 'admin' || firstAdmin ? 'admin' : 'member',
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
      firstAdmin
        ? `provisioned @${handle} via SSO as the workspace's first admin`
        : `provisioned member @${handle} via SSO`,
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
}

export function authRoutes(
  sso?: TSsoRuntime,
  opts: { otpFallback?: boolean } = {},
): Hono<IAuthEnv> {
  const app = new Hono<IAuthEnv>()

  /**
   * One-time codes are the way in when nothing else is, and a liability when
   * something else is.
   *
   * A configured provider owns identity: offering a second door beside it
   * means an account that provider has disabled can still be signed in to,
   * and the default sender prints the code to the log, so anyone who can read
   * the logs can sign in as anyone. So a provider turns codes OFF, and
   * ACTA_OTP_FALLBACK=true turns them back on for whoever decides they want
   * both.
   *
   * With no provider, codes are the only way in and are always on. That is
   * the self-hosted case.
   */
  const otpEnabled = sso === undefined || opts.otpFallback === true

  /** Codes are not merely hidden when off: the endpoints are not there. */
  const otpGate = (c: { json: (b: unknown, s?: 200 | 404) => Response }) =>
    otpEnabled
      ? null
      : c.json({ error: 'otp is disabled on this instance' }, 404)

  app.get('/config', (c) =>
    c.json({
      sso: sso !== undefined,
      otp: otpEnabled,
      // What to call the provider on the button. Hardcoding "Nubisco
      // Platform" told every self-hosted instance to sign in with a product
      // its users have no account on.
      sso_label: sso?.config.label ?? 'single sign-on',
    }),
  )

  /** The redirect the provider must be configured to allow, built from the
      request so a deployment behind any hostname works without being told. */
  const redirectUriOf = (url: string) =>
    new URL('/api/v1/auth/sso/callback', url).toString()

  app.get('/sso/start', async (c) => {
    if (!sso) return c.json({ error: 'sso not configured' }, 404)

    if (sso.mode === 'oidc') {
      let authorize
      try {
        authorize = await sso.client.authorizeUrl(redirectUriOf(c.req.url))
      } catch (err) {
        // Discovery is a network call to someone else's server, so it fails
        // in ways a sign-in page cannot act on. Log the reason and send the
        // person somewhere that says so.
        console.error('oidc discovery failed:', (err as Error).message)
        return c.redirect('/login?error=sso_discovery')
      }
      // The verifier never leaves this browser, which is what makes PKCE
      // worth having: an intercepted code cannot be exchanged without it.
      setCookie(c, OIDC_HANDSHAKE_COOKIE, JSON.stringify(authorize.handshake), {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: 600,
      })
      return c.redirect(authorize.url, 302)
    }

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
    url.searchParams.set('redirect_uri', redirectUriOf(c.req.url))
    url.searchParams.set('state', state)
    return c.redirect(url.toString(), 302)
  })

  app.get('/sso/callback', async (c) => {
    if (!sso) return c.json({ error: 'sso not configured' }, 404)
    const error = c.req.query('error')
    if (error) return c.redirect(`/login?error=${encodeURIComponent(error)}`)

    let claims: ISsoClaims
    if (sso.mode === 'oidc') {
      const raw = getCookie(c, OIDC_HANDSHAKE_COOKIE)
      deleteCookie(c, OIDC_HANDSHAKE_COOKIE, { path: '/' })
      const code = c.req.query('code')
      const state = c.req.query('state')
      if (!raw || !code || !state) return c.redirect('/login?error=sso_state')
      let handshake
      try {
        handshake = JSON.parse(raw) as {
          state: string
          nonce: string
          verifier: string
        }
      } catch {
        return c.redirect('/login?error=sso_state')
      }
      if (state !== handshake.state) return c.redirect('/login?error=sso_state')
      try {
        claims = await sso.client.exchange(
          code,
          redirectUriOf(c.req.url),
          handshake,
        )
      } catch (err) {
        // Same reasoning as the handover path: the browser learns nothing,
        // the log learns everything. An exchange can fail for a wrong secret,
        // a redirect_uri the provider does not have registered, a rotated
        // key or a replayed nonce, and they are indistinguishable from here.
        console.error('oidc exchange failed:', (err as Error).message)
        return c.redirect('/login?error=sso_token')
      }
    } else {
      const token = c.req.query('token')
      const state = c.req.query('state')
      const expectedState = getCookie(c, SSO_STATE_COOKIE)
      deleteCookie(c, SSO_STATE_COOKIE, { path: '/' })
      if (!token || !state || !expectedState || state !== expectedState) {
        return c.redirect('/login?error=sso_state')
      }
      try {
        claims = await sso.verifier.verify(token)
      } catch (err) {
        // The reason never reaches the browser (it would tell an attacker which
        // half of the check failed), but without it in the log an SSO outage is
        // indistinguishable from a wrong password, and we spent an evening
        // guessing between issuer mismatch, key rotation and a bad signature.
        console.error('sso verify failed:', (err as Error).message)
        return c.redirect('/login?error=sso_token')
      }
    }

    if (!claims.email) return c.redirect('/login?error=sso_no_email')
    return signInWithClaims(c, claims, sso.config.autoProvision)
  })

  app.post('/otp', async (c) => {
    const gate = otpGate(c)
    if (gate) return gate
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
    const gate = otpGate(c)
    if (gate) return gate
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
        onboarded_at: number | null
      }>('SELECT email, name, onboarded_at FROM actor WHERE id = ?', [actor.id])
    )[0]
    return c.json({
      id: actor.id,
      handle: actor.handle,
      kind: actor.kind,
      role: actor.role,
      scopes: actor.scopes,
      email: row?.email ?? undefined,
      name: row?.name ?? undefined,
      onboarded: row?.onboarded_at !== null && row?.onboarded_at !== undefined,
    })
  })

  /**
   * Mark the welcome as done. Separate from the settings it collects, which
   * each write through their own endpoint, so closing the welcome is recorded
   * even when the person changed nothing in it: having been asked is the fact
   * worth keeping, not what they answered.
   *
   * Idempotent, and never un-sets: a second call keeps the original moment.
   */
  /**
   * Personal access tokens: MCP and the API as yourself.
   *
   * Acta already had agent tokens, but those are admin-minted and create a
   * separate actor, so work done through one is attributed to a bot rather
   * than to the person driving it. That is right for an autonomous agent and
   * wrong for the ordinary case, which is someone pointing their own editor
   * at their own workspace. These act as the person who minted them.
   *
   * Deliberately never admin, even for an admin. Administration (minting
   * agent tokens, changing members) should take a browser session and a
   * deliberate visit, not a header that lives in a config file. A personal
   * token is for content work.
   */
  app.get('/me/tokens', requireAuth(), async (c) => {
    const actor = c.get('actor')
    const rows = await c.get('db').query<{
      id: string
      label: string | null
      scopes: string
      created_at: number
      last_used_at: number | null
    }>(
      `SELECT id, label, scopes, created_at, last_used_at
         FROM auth_token
        WHERE actor_id = ? AND kind = 'personal' AND revoked_at IS NULL
        ORDER BY created_at DESC`,
      [actor.id],
    )
    return c.json({
      tokens: rows.map((r) => ({
        id: r.id,
        label: r.label ?? 'Unnamed',
        scopes: r.scopes.split(','),
        created_at: r.created_at,
        // What makes an old token safe to revoke: nobody remembers what they
        // pasted a token into a year ago, but "never used" is decisive.
        last_used_at: r.last_used_at ?? undefined,
      })),
    })
  })

  app.post('/me/tokens', requireAuth(), async (c) => {
    const actor = c.get('actor')
    // A token that can mint tokens cannot be contained: revoking the leaked
    // one would achieve nothing, because whoever held it has already minted a
    // replacement nobody has seen. Checking actor.kind does not do this, since
    // a personal token's actor is the same human as the session's.
    // Returned rather than thrown: these routes mount before the API's error
    // handler, so an ApiError here surfaces as a 500.
    if (actor.kind !== 'human' || actor.tokenKind !== 'session') {
      return c.json({ error: 'minting a token takes a signed-in session' }, 403)
    }
    const body = z
      .object({
        label: z.string().min(1).max(100),
        scopes: z.array(z.enum(['read', 'write'])).default(['read', 'write']),
      })
      .parse(await c.req.json())
    const token = await createToken(
      c.get('db'),
      c.get('workspaceId'),
      actor.id,
      'personal',
      // Read is implied by write; asking for write alone and silently getting
      // less is the kind of thing that is debugged at the far end.
      body.scopes.includes('write') ? ['read', 'write'] : ['read'],
      undefined,
      body.label,
    )
    return c.json({ token, label: body.label, scopes: body.scopes }, 201)
  })

  app.delete('/me/tokens/:id', requireAuth(), async (c) => {
    const actor = c.get('actor')
    await c.get('db').run(
      `UPDATE auth_token SET revoked_at = ?
          WHERE id = ? AND actor_id = ? AND kind = 'personal' AND revoked_at IS NULL`,
      [now(), c.req.param('id'), actor.id],
    )
    return c.json({ ok: true })
  })

  app.post('/me/onboarded', requireAuth(), async (c) => {
    const actor = c.get('actor')
    await c
      .get('db')
      .run(
        'UPDATE actor SET onboarded_at = ? WHERE id = ? AND onboarded_at IS NULL',
        [now(), actor.id],
      )
    return c.json({ ok: true })
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
