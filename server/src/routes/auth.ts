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
  allowedWhileDeleting,
  workspaceGate,
  workspacesForEmail,
  notePersonSeen,
  allowedWhileFrozen,
  type TOtpSender,
} from '../core/auth'
import { now, type IActorCtx, type ICtx } from '../core/ctx'
import { emitEvent, flushPendingEvents } from '../core/events'
import { JwksVerifier, type ISsoClaims, type ISsoConfig } from '../core/sso'
import { acceptedPicture, isNubiscoPlatform } from '../core/avatar'
import { OidcClient, type IOidcConfig } from '../core/oidc'
import { resolveOauthToken } from '../core/oauth'
import { currentEdition, editionHas, type IEditionDeps } from '../core/edition'
import type { ISqlDriver } from '../db'
import {
  acceptInvitation,
  invitationByToken,
  publicView,
} from '../services/invitations'

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
/**
 * Where to land after the provider is done.
 *
 * The callback used to redirect to "/" unconditionally, which is right for an
 * ordinary sign-in and wrong for anything that sends you to sign in mid-task.
 * The OAuth consent screen is exactly that: bounce to the provider and come
 * back at the workspace home, and the connector's request is gone.
 *
 * Only a local path is ever honoured, because this is a value the caller
 * supplies and an absolute URL here would be an open redirect through our own
 * sign-in.
 */
const SSO_RETURN_COOKIE = 'acta_sso_return'

export function safeReturnPath(raw: string | undefined): string | null {
  if (!raw) return null
  // "//host" and "/\host" are both protocol-relative and leave the site.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) {
    return null
  }
  return raw
}
/** The PKCE verifier and nonce, which must survive the trip to the provider. */
const OIDC_HANDSHAKE_COOKIE = 'acta_oidc_handshake'

/**
 * Set when someone presses Accept on an invitation and is sent to the
 * provider to prove who they are. The callback reads it to know which
 * invitation the sign-in is for. Only the token, never anything the callback
 * trusts on its own: the invitation is looked up and the provider's email
 * must match it.
 */
const INVITE_COOKIE = 'acta_invite'

/**
 * Everything after "who is this": map the claims to a workspace member,
 * accept an invitation if this sign-in carries one, and mint the session.
 *
 * Shared by both provider modes deliberately. The difference between a JWT
 * handed over in the query and one fetched through a code exchange ends at
 * the claims; if provisioning drifted between the two, an instance would get
 * different roles depending on how its provider happened to be wired.
 *
 * Who gets in (LA-397). A valid token from the provider says who someone is,
 * not which workspace they belong to, so it is never enough on its own to
 * create a member:
 *
 *  1. An invitation carried by this sign-in, for this email, is accepted.
 *  2. Otherwise an existing member with this email signs in, preferring the
 *     instance's own workspace, then the oldest they belong to.
 *  3. Otherwise nobody is created, unless the instance opted in with
 *     ACTA_OIDC_AUTO_PROVISION / ACTA_SSO_AUTO_PROVISION=true (off by
 *     default), or the instance's workspace has no administrator at all yet,
 *     which is a fresh install's first sign-in and nothing else.
 */
async function signInWithClaims(
  c: Context<IAuthEnv>,
  claims: ISsoClaims,
  autoProvision: boolean,
  issuer?: string,
  edition?: IEditionDeps,
): Promise<Response> {
  const db = c.get('db')
  const bootWorkspaceId = c.get('workspaceId')
  let workspaceId = bootWorkspaceId
  let member: { id: string; disabled: number } | undefined
  // Where to land: the workspace just joined, when this sign-in accepted an
  // invitation, otherwise wherever the person was going.
  let landing: string | null = null

  const inviteToken = getCookie(c, INVITE_COOKIE)
  if (inviteToken) {
    deleteCookie(c, INVITE_COOKIE, { path: '/' })
    const accepted = await acceptInvitation(db, inviteToken, claims.email)
    if (!accepted.ok) {
      return c.redirect(`/login?error=invite_${accepted.reason}`)
    }
    workspaceId = accepted.workspace.id
    member = { id: accepted.actorId, disabled: 0 }
    landing = `/${accepted.workspace.slug}`
  }

  if (!member) {
    // Enabled rows first, the instance's own workspace before any other, then
    // the oldest. A person disabled here but a member elsewhere still gets in
    // elsewhere, and only someone disabled everywhere is told so.
    const found = (
      await db.query<{ id: string; disabled: number; workspace_id: string }>(
        `SELECT id, disabled, workspace_id FROM actor
          WHERE lower(email) = lower(?) AND kind = 'human'
          ORDER BY disabled ASC, (workspace_id = ?) DESC, created_at ASC
          LIMIT 1`,
        [claims.email, bootWorkspaceId],
      )
    )[0]
    if (found?.disabled === 1) return c.redirect('/login?error=disabled')
    if (found) {
      member = found
      workspaceId = found.workspace_id
    }
  }

  if (!member) {
    // An instance that delegates identity to a provider seeds no admin of its
    // own (see bootstrap), so without this the first person to sign in to a
    // fresh install could never get in, and nothing could ever be
    // administered. Only ever promotes into a vacuum: the moment one admin
    // exists this is inert, so it cannot be used to join, let alone escalate
    // on, an established workspace. Operators of a shared instance close even
    // that window by setting ACTA_ADMIN_EMAIL.
    const admins = await db.query(
      `SELECT id FROM actor
        WHERE workspace_id = ? AND kind = 'human' AND role = 'admin'
              AND disabled = 0 LIMIT 1`,
      [workspaceId],
    )
    const firstAdmin = admins.length === 0
    if (!autoProvision && !firstAdmin) {
      // Nobody to sign in as. An edition with signup (the EE, LA-398) takes
      // the person on to create a workspace of their own. Without one, or if
      // it declines, they are refused exactly as before.
      const hook = currentEdition().onUnknownSignIn
      const taken =
        hook && edition
          ? await hook(
              c,
              {
                email: claims.email,
                name: claims.name,
                sub: claims.sub,
                picture: acceptedPicture(claims.picture, issuer) ?? undefined,
              },
              edition,
            )
          : null
      return taken ?? c.redirect('/login?error=not_a_member')
    }
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
  // The provider vouched for this address just now, so it is confirmed and
  // may be emailed. Kept on first confirmation, never moved.
  await db.run(
    `UPDATE actor SET email_confirmed_at = ?
      WHERE id = ? AND email_confirmed_at IS NULL`,
    [now(), member.id],
  )
  // Bind the provider's own id for this person. Email is how the member was
  // found above and is a poor key afterwards: the platform's webhooks name a
  // user by id, and an email address can change.
  await db.run(
    `UPDATE actor SET platform_user_id = ?
      WHERE id = ? AND platform_user_id IS NOT ?`,
    [claims.sub, member.id, claims.sub],
  )

  // Every sign-in refreshes the avatar, because the webhook that reports a
  // change is delivered once and never retried. An absent claim clears it: the
  // provider omits `picture` for someone with no avatar, and never sends null
  // or an empty string.
  //
  // A picture the person uploaded here is theirs and survives: avatar_source
  // records that choice, and the seed path in routes/api.ts makes the same
  // exception. Take that away and every sign-in would quietly undo it.
  await db.run(
    `UPDATE actor SET avatar_url = ?
      WHERE id = ? AND avatar_source != 'upload' AND avatar_url IS NOT ?`,
    [
      acceptedPicture(claims.picture, issuer),
      member.id,
      acceptedPicture(claims.picture, issuer),
    ],
  )

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
  const ret = landing ?? safeReturnPath(getCookie(c, SSO_RETURN_COOKIE))
  deleteCookie(c, SSO_RETURN_COOKIE, { path: '/' })
  return c.redirect(ret ?? '/', 302)
}

export function authRoutes(
  sso?: TSsoRuntime,
  opts: {
    otpFallback?: boolean
    /** What the registered edition is handed (core/edition.ts). */
    edition?: IEditionDeps
    /** Where the analytics tracker is served from, when there is one. */
    analyticsUrl?: string
  } = {},
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
      // Whether sign-in goes through Nubisco Platform, which decides whether
      // the account menu shows account actions, Profile and the platform
      // lockup. An instance pointed at its own provider has neither page, and
      // must not be told about infrastructure it is not using.
      nubisco_platform: isNubiscoPlatform(sso?.config.issuer),
      // Where Profile opens. Only for Nubisco Platform.
      platform_url: isNubiscoPlatform(sso?.config.issuer)
        ? sso!.config.issuer.replace(/\/$/, '')
        : undefined,
      // Where the account menu lists and removes the browser's signed-in
      // accounts. Not the issuer: Accord keeps the issuer as an identifier
      // and holds browser sessions on its auth host. The issuer when unset.
      platform_auth_url: isNubiscoPlatform(sso?.config.issuer)
        ? ((sso!.mode === 'handover' ? sso!.config.authOrigin : undefined) ??
          sso!.config.issuer.replace(/\/$/, ''))
        : undefined,
      // Whether a person with no workspace can create one here. Only where
      // the edition offers it, so a self-hosted instance never shows a
      // "Create a workspace" that leads nowhere.
      signup: editionHas('signup'),
      // The tracker, where this instance has one (ACTA_ANALYTICS_URL).
      analytics_url: opts.analyticsUrl,
    }),
  )

  /** The redirect the provider must be configured to allow, built from the
      request so a deployment behind any hostname works without being told. */
  const redirectUriOf = (url: string) =>
    new URL('/api/v1/auth/sso/callback', url).toString()

  app.get('/sso/start', async (c) => {
    if (!sso) return c.json({ error: 'sso not configured' }, 404)

    const oidcReturn = safeReturnPath(c.req.query('to'))
    if (oidcReturn) {
      setCookie(c, SSO_RETURN_COOKIE, oidcReturn, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: 600,
      })
    }
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

    const ret = safeReturnPath(c.req.query('to'))
    if (ret) {
      setCookie(c, SSO_RETURN_COOKIE, ret, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: 600,
      })
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
    // Switching and adding accounts from the account menu. Both are forwarded
    // only in the shapes the provider understands, so the query string here
    // cannot be used to smuggle other parameters into the authorize URL.
    const prompt = c.req.query('prompt')
    if (prompt === 'login' || prompt === 'select_account') {
      url.searchParams.set('prompt', prompt)
    }
    const loginHint = c.req.query('login_hint')
    if (
      typeof loginHint === 'string' &&
      loginHint.length <= 254 &&
      /^[^\s@]+@[^\s@]+$/.test(loginHint)
    ) {
      url.searchParams.set('login_hint', loginHint)
    }
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
    return signInWithClaims(
      c,
      claims,
      sso.config.autoProvision,
      sso.config.issuer,
      opts.edition,
    )
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
    // A code sent to this address was just entered, which proves it.
    await db.run(
      `UPDATE actor SET email_confirmed_at = ?
        WHERE id = ? AND email_confirmed_at IS NULL`,
      [now(), actor.id],
    )
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

  /**
   * Invitations, from the invitee's side. Public: the person holding the link
   * is not a member of anything yet. The token is the only key, and it says
   * no more than the email already did.
   */
  app.get('/invitations/:token', async (c) => {
    const inv = await invitationByToken(c.get('db'), c.req.param('token'))
    if (!inv) return c.json({ error: 'invitation not found' }, 404)
    return c.json({
      ...publicView(inv),
      // How accepting proves who you are, so the page can say so.
      proof: sso ? 'provider' : 'link',
    })
  })

  /**
   * Accept. A POST behind a button, never the GET of the link: mail scanners
   * fetch every link in a message, and an invitation that accepted itself
   * when a scanner looked at it would prove nothing.
   */
  app.post('/invitations/:token/accept', async (c) => {
    const db = c.get('db')
    const token = c.req.param('token')
    const inv = await invitationByToken(db, token)
    if (!inv) return c.json({ error: 'invitation not found' }, 404)
    if (inv.status === 'revoked' || inv.status === 'expired')
      return c.json({ error: `this invitation has ${inv.status}` }, 410)

    if (sso) {
      // The provider proves the address: remember which invitation this is
      // and send them through it. The callback does the rest.
      setCookie(c, INVITE_COOKIE, token, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: 600,
      })
      return c.json({ next: '/api/v1/auth/sso/start' })
    }

    // No provider: the link was only ever sent to the invited address, so
    // holding it is the proof. Once only, though. An accepted link that kept
    // signing people in would be a password that never expires.
    if (inv.status === 'accepted')
      return c.json(
        {
          error: 'this invitation was already accepted, so sign in with a code',
        },
        409,
      )
    const accepted = await acceptInvitation(db, token, inv.row.email)
    if (!accepted.ok) return c.json({ error: accepted.reason }, 409)
    const session = await createToken(
      db,
      accepted.workspace.id,
      accepted.actorId,
      'session',
      accepted.role === 'admin'
        ? ['read', 'write', 'admin']
        : ['read', 'write'],
      SESSION_TTL,
    )
    setCookie(c, SESSION_COOKIE, session, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL / 1000,
    })
    return c.json({ next: `/${accepted.workspace.slug}` })
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
        avatar_url: string | null
        platform_user_id: string | null
        onboarded_at: number | null
      }>(
        `SELECT email, name, avatar_url, platform_user_id, onboarded_at
           FROM actor WHERE id = ?`,
        [actor.id],
      )
    )[0]
    return c.json({
      id: actor.id,
      handle: actor.handle,
      kind: actor.kind,
      role: actor.role,
      scopes: actor.scopes,
      email: row?.email ?? undefined,
      name: row?.name ?? undefined,
      // Absent rather than null when there is no avatar, so the account menu
      // falls back to initials on the same test everywhere else uses.
      picture: row?.avatar_url ?? undefined,
      // Lets the account menu mark which of the browser's signed-in accounts
      // this session belongs to.
      platform_user_id: row?.platform_user_id ?? undefined,
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

  /**
   * Applications this person has connected over OAuth: the claude.ai
   * connector, ChatGPT, an MCP client. Grouped by client rather than listed
   * per token, because "Claude" re-authorising produces a second row for
   * what the person thinks of as one connection, and a revoke that leaves a
   * live sibling grant behind is a revoke that did not work.
   *
   * Personal to the signed-in actor, exactly like /me/tokens: an admin has
   * no business seeing, or cutting, what someone else connected.
   */
  app.get('/me/apps', requireAuth(), async (c) => {
    const actor = c.get('actor')
    const rows = await c.get('db').query<{
      client_id: string
      name: string
      scope: string
      created_at: number
      last_used_at: number | null
      expires_at: number
    }>(
      `SELECT t.client_id,
              c.name,
              GROUP_CONCAT(DISTINCT t.scope) AS scope,
              MIN(t.created_at) AS created_at,
              MAX(t.last_used_at) AS last_used_at,
              MAX(t.refresh_expires_at) AS expires_at
         FROM oauth_token t
         JOIN oauth_client c ON c.id = t.client_id
        WHERE t.actor_id = ? AND t.revoked_at IS NULL
          AND t.refresh_expires_at > ?
        GROUP BY t.client_id, c.name
        ORDER BY created_at DESC`,
      [actor.id, now()],
    )
    return c.json({
      apps: rows.map((r) => ({
        client_id: r.client_id,
        name: r.name,
        // GROUP_CONCAT of comma-joined scope strings re-splits cleanly, and
        // the set is what matters, not which grant carried which scope.
        scopes: [...new Set(r.scope.split(',').filter(Boolean))].sort(),
        created_at: r.created_at,
        last_used_at: r.last_used_at ?? undefined,
        expires_at: r.expires_at,
      })),
    })
  })

  /**
   * Revokes every live grant for one client. Stamped rather than deleted, so
   * a refresh arriving afterwards is refused as revoked instead of looking
   * like a token that never existed. `refreshGrant` already reads that.
   */
  app.delete('/me/apps/:clientId', requireAuth(), async (c) => {
    const actor = c.get('actor')
    await c.get('db').run(
      `UPDATE oauth_token SET revoked_at = ?
          WHERE client_id = ? AND actor_id = ? AND revoked_at IS NULL`,
      [now(), c.req.param('clientId'), actor.id],
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
   * Which walkthroughs this person has been through, and how each ended.
   * The app reads the whole map once, and settings resets one at a time so
   * it plays again the next time whatever starts it happens.
   */
  app.get('/me/walkthroughs', requireAuth(), async (c) => {
    return c.json({
      walkthroughs: await walkthroughsOf(c.get('db'), c.get('actor').id),
    })
  })

  app.put('/me/walkthroughs/:id', requireAuth(), async (c) => {
    const id = c.req.param('id')
    if (!WALKTHROUGH_ID.test(id))
      return c.json({ error: 'bad walkthrough id' }, 400)
    const parsed = zWalkthroughRecord.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!parsed.success) return c.json({ error: 'bad walkthrough record' }, 400)
    const db = c.get('db')
    const actor = c.get('actor')
    const all = await walkthroughsOf(db, actor.id)
    all[id] = parsed.data
    // A handful exist. The cap only stops a client from growing the row.
    if (Object.keys(all).length > 64)
      return c.json({ error: 'too many walkthroughs' }, 400)
    await db.run('UPDATE actor SET walkthroughs = ? WHERE id = ?', [
      JSON.stringify(all),
      actor.id,
    ])
    return c.json({ ok: true })
  })

  app.delete('/me/walkthroughs/:id', requireAuth(), async (c) => {
    const db = c.get('db')
    const actor = c.get('actor')
    const all = await walkthroughsOf(db, actor.id)
    delete all[c.req.param('id')]
    await db.run('UPDATE actor SET walkthroughs = ? WHERE id = ?', [
      JSON.stringify(all),
      actor.id,
    ])
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

/**
 * Auth middleware: Bearer token (agent, personal or OAuth) or session cookie.
 *
 * `resourceMetadata` adds the RFC 9728 pointer to the 401. It is what turns a
 * refusal into an instruction: without it a connector sees a bare 401, has no
 * idea an authorization server exists, and reports that it cannot determine
 * how the server signs in. Only the MCP endpoint needs it; the REST API's
 * clients already know how they authenticate.
 */
export function requireAuth(
  opts: { resourceMetadata?: boolean } = {},
): MiddlewareHandler<IAuthEnv> {
  return async (c, next) => {
    const db = c.get('db')
    const authed = await authedFrom(c)
    if (!authed) {
      if (opts.resourceMetadata) {
        const origin = new URL(c.req.url).origin
        return c.json({ error: 'unauthorized' }, 401, {
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        })
      }
      return c.json({ error: 'unauthorized' }, 401)
    }
    const gate = await workspaceGate(db, authed.workspaceId)
    if (gate.suspended) return c.json({ error: 'workspace suspended' }, 403)
    if (
      gate.purgeAt !== null &&
      !allowedWhileDeleting(c.req.method, c.req.path)
    )
      return c.json(
        { error: 'workspace scheduled for deletion', purge_at: gate.purgeAt },
        403,
      )
    if (authed.tokenKind === 'session')
      await notePersonSeen(db, authed.workspaceId, gate)
    else if (gate.frozenAt !== null && !allowedWhileFrozen(c.req.method))
      return c.json({ error: 'workspace is read-only while idle' }, 403)
    c.set('actor', authed)
    // Without a workspace segment the request means "the one the token was
    // minted in", which keeps the unprefixed endpoints working.
    c.set('workspaceId', authed.workspaceId)
    await next()
  }
}

/** The token on the request, from either the bearer header or the cookie. */
const WALKTHROUGH_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** One walkthrough's outcome, as @nubisco/ui's walkthrough storage writes it. */
const zWalkthroughRecord = z.object({
  version: z.number().int().min(0).max(1_000_000),
  outcome: z.enum(['finish', 'skip']),
  completedAt: z.string().max(40),
})

type TWalkthroughs = Record<string, z.infer<typeof zWalkthroughRecord>>

async function walkthroughsOf(
  db: ISqlDriver,
  actorId: string,
): Promise<TWalkthroughs> {
  const row = (
    await db.query<{ walkthroughs: string | null }>(
      'SELECT walkthroughs FROM actor WHERE id = ?',
      [actorId],
    )
  )[0]
  if (!row?.walkthroughs) return {}
  try {
    const parsed = JSON.parse(row.walkthroughs) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as TWalkthroughs) : {}
  } catch {
    return {}
  }
}

/**
 * Who is signed in on this request, from the bearer header or the session
 * cookie, or null. For routes outside the workspace API (the EE's signup) that
 * need to know who is asking without requiring a workspace.
 */
export async function authedFrom(c: {
  get: (k: 'db') => ISqlDriver
  req: { header: (n: string) => string | undefined }
}) {
  const header = c.req.header('authorization')
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined
  const token = bearer ?? getCookie(c as never, SESSION_COOKIE)
  if (!token) return null
  // Tokens minted by the OAuth server live in their own table and carry their
  // own expiry and rotation, so they are resolved first. Everything after this
  // point cannot tell the difference, which is the point: a connector acts as
  // the member who approved it.
  const oauth = await resolveOauthToken(c.get('db'), token)
  if (oauth) return oauth
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
    // After the membership check, so a stranger cannot learn that a
    // workspace exists by being told it is suspended.
    if (workspace.suspended_at !== null)
      return c.json({ error: 'workspace suspended' }, 403)
    if (
      workspace.purge_at !== null &&
      !allowedWhileDeleting(c.req.method, c.req.path)
    )
      return c.json(
        {
          error: 'workspace scheduled for deletion',
          purge_at: workspace.purge_at,
        },
        403,
      )

    const seen = {
      frozenAt: workspace.frozen_at,
      lastSeenAt: workspace.last_seen_at,
    }
    if (authed.tokenKind === 'session')
      await notePersonSeen(db, workspace.id, seen)
    else if (seen.frozenAt !== null && !allowedWhileFrozen(c.req.method))
      return c.json({ error: 'workspace is read-only while idle' }, 403)

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

/**
 * Sign someone in on this response: a session for the actor, in the cookie the
 * app reads. The one shape every sign-in path issues, so a session started by
 * the EE's signup is indistinguishable from one started here.
 */
export async function startSession(
  c: Context,
  db: ISqlDriver,
  workspaceId: string,
  actorId: string,
  role: 'admin' | 'member',
): Promise<void> {
  const token = await createToken(
    db,
    workspaceId,
    actorId,
    'session',
    role === 'admin' ? ['read', 'write', 'admin'] : ['read', 'write'],
    SESSION_TTL,
  )
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL / 1000,
  })
}

export { SESSION_COOKIE, randomToken }
