import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { ISqlDriver } from '../db'
import type { IActorCtx } from '../core/ctx'
import { resolveToken } from '../core/auth'
import {
  OAUTH_CORS,
  authorizationServerMetadata,
  exchangeCode,
  issueCode,
  protectedResourceMetadata,
  refreshToken,
  registerClient,
  validateAuthorize,
} from '../core/oauth'

/**
 * The OAuth surface: discovery, registration, consent and token.
 *
 * The consent screen itself is a page of the app (web/src/views/
 * OAuthConsentView.vue), built from the design system like every other
 * surface, so it looks like Acta and keeps looking like it as the system
 * moves. This file keeps every decision that matters: /oauth/context says
 * whether the request is well formed and who is asking, and the approval
 * posts back to POST /oauth/authorize, which revalidates from scratch.
 *
 * An SPA-routed consent page used to be unreachable, because a signed-out
 * visitor was handed to the identity provider and came back at "/" with the
 * OAuth parameters gone. The sign-in redirect now carries ?to=, so the
 * parameters survive the round trip and the page can live in the app.
 */

const SESSION_COOKIE = 'acta_session'

export interface IOauthEnv {
  Variables: {
    db: ISqlDriver
    workspaceId: string
    actor: IActorCtx
  }
}

export function oauthRoutes(): Hono<IOauthEnv> {
  const app = new Hono<IOauthEnv>()

  app.options(
    '/*',
    () =>
      new Response(null, {
        status: 204,
        headers: { ...OAUTH_CORS, 'access-control-max-age': '86400' },
      }),
  )

  // ── Registration ──
  app.post('/register', async (c) => {
    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json(
        {
          error: 'invalid_client_metadata',
          error_description: 'Body must be JSON',
        },
        400,
        OAUTH_CORS,
      )
    }
    const out = await registerClient(c.get('db'), body)
    if (!out.ok) {
      return c.json(
        { error: out.error, error_description: out.description },
        400,
        OAUTH_CORS,
      )
    }
    return c.json(
      {
        client_id: out.id,
        client_name: out.name,
        redirect_uris: out.uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201,
      OAUTH_CORS,
    )
  })

  // ── Consent ──

  /**
   * GET /oauth/authorize — hands the request to the app's consent route.
   *
   * A malformed request that still names a registered client and one of its
   * redirect addresses is answered the way the spec asks, by sending the
   * error back to the client rather than showing a person a page about it.
   * Everything else goes to the screen, which asks /oauth/context what to
   * say.
   */
  app.get('/authorize', async (c) => {
    const url = new URL(c.req.url)
    const check = await validateAuthorize(
      c.get('db'),
      (k) => url.searchParams.get(k) ?? '',
    )
    if (!check.ok && check.kind === 'redirect') return c.redirect(check.to, 302)
    return c.redirect(`/oauth/consent?${url.searchParams.toString()}`, 302)
  })

  /**
   * GET /oauth/context — what the consent screen needs to render honestly:
   * is this a well-formed request from a registered client, what is that
   * client called, and is there a person signed in to approve it. Validation
   * only; approving revalidates all of it at POST time.
   */
  app.get('/context', async (c) => {
    const url = new URL(c.req.url)
    const check = await validateAuthorize(
      c.get('db'),
      (k) => url.searchParams.get(k) ?? '',
    )
    // Neither refusal shape is usable by the SPA (one is an error page, the
    // other a redirect to the client), so both collapse to one renderable no.
    if (!check.ok)
      return c.json({
        ok: false,
        reason:
          check.kind === 'refuse'
            ? check.message
            : 'That request cannot be approved',
      })

    const token = getCookie(c, SESSION_COOKIE)
    const actor = token ? await resolveToken(c.get('db'), token) : null
    const human = actor && actor.kind === 'human' ? actor : null
    return c.json({
      ok: true,
      clientName: check.p.clientName,
      handle: human?.handle ?? null,
    })
  })

  /**
   * The decision. Everything is revalidated from scratch: the form is state
   * the client held, so none of it can be trusted on the way back.
   *
   * CSRF rests on the session cookie being SameSite=Lax. A cross-site form
   * post cannot carry it, so a forged approval arrives with no session and
   * dies at the same check an anonymous request does.
   */
  app.post('/authorize', async (c) => {
    const form = await c.req.formData().catch(() => null)
    if (!form) return c.text('Expected a form post', 400)
    const get = (k: string) => String(form.get(k) ?? '')

    const check = await validateAuthorize(c.get('db'), get)
    if (!check.ok) {
      if (check.kind === 'redirect') return c.redirect(check.to, 302)
      return c.text(check.message, 400)
    }

    const token = getCookie(c, SESSION_COOKIE)
    const actor = token ? await resolveToken(c.get('db'), token) : null
    if (!actor || actor.kind !== 'human') {
      const params = new URLSearchParams()
      for (const k of [
        'client_id',
        'redirect_uri',
        'state',
        'code_challenge',
        'code_challenge_method',
        'response_type',
        'scope',
      ]) {
        const v = form.get(k)
        if (typeof v === 'string' && v) params.set(k, v)
      }
      return c.redirect(`/oauth/consent?${params.toString()}`, 302)
    }

    if (get('decision') !== 'approve') {
      const to = new URL(check.p.redirectUri)
      if (check.p.state) to.searchParams.set('state', check.p.state)
      to.searchParams.set('error', 'access_denied')
      return c.redirect(to.href, 302)
    }

    const href = await issueCode(
      c.get('db'),
      check.p,
      actor.workspaceId,
      actor.id,
    )
    return c.redirect(href, 302)
  })

  // ── Token ──
  app.post('/token', async (c) => {
    const form = await c.req.formData().catch(() => null)
    if (!form) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Expected application/x-www-form-urlencoded',
        },
        400,
        OAUTH_CORS,
      )
    }
    const get = (k: string) => String(form.get(k) ?? '')
    const grant = get('grant_type')
    const out =
      grant === 'authorization_code'
        ? await exchangeCode(c.get('db'), get)
        : grant === 'refresh_token'
          ? await refreshToken(c.get('db'), get)
          : ({ ok: false, error: 'unsupported_grant_type' } as const)

    if (!out.ok) return c.json({ error: out.error }, 400, OAUTH_CORS)
    return c.json(out.pair, 200, { ...OAUTH_CORS, 'cache-control': 'no-store' })
  })

  return app
}

export { protectedResourceMetadata, authorizationServerMetadata }
