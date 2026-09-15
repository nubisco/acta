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
 * The consent screen is rendered here rather than by the SPA, on purpose.
 * app.ts hands a signed-out visitor to the identity provider before any HTML
 * is served, so an SPA-routed consent page would be bounced to sign-in and
 * come back at "/" with the OAuth parameters gone. Serving it from the server
 * keeps the whole handshake in one place and keeps it working when the SPA
 * does not.
 */

const SESSION_COOKIE = 'acta_session'

export interface IOauthEnv {
  Variables: {
    db: ISqlDriver
    workspaceId: string
    actor: IActorCtx
  }
}

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/**
 * Deliberately one small self-contained page. It is an authentication surface:
 * it must render with no build step, no bundle and no network beyond itself.
 */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Acta</title>
<style>
  :root { color-scheme: light dark;
    --bg:#f2f2f2; --card:#fff; --text:#16253a; --muted:#5b6b80;
    --line:#dfe4ea; --accent:#3a6ede; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#0b101c; --card:#16253a; --text:#eef2f7; --muted:#9fb0c4;
    --line:#24364f; --accent:#5fa4f5; } }
  * { box-sizing: border-box }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    background:var(--bg); color:var(--text);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; padding:24px }
  .card { width:100%; max-width:29rem; background:var(--card); border:1px solid var(--line);
    border-radius:14px; padding:28px 28px 22px }
  h1 { margin:0 0 6px; font-size:1.2rem; letter-spacing:-0.01em }
  p { margin:0 0 14px; color:var(--muted) }
  strong { color:var(--text) }
  ul { margin:0 0 18px; padding-left:20px; color:var(--muted) }
  li { margin:3px 0 }
  .row { display:flex; gap:10px; justify-content:flex-end; margin-top:22px }
  button, .btn { font:inherit; padding:9px 16px; border-radius:9px; border:1px solid var(--line);
    background:transparent; color:var(--text); cursor:pointer; text-decoration:none }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.9em }
</style>
</head><body><div class="card">${body}</div></body></html>`
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
  app.get('/authorize', async (c) => {
    const url = new URL(c.req.url)
    const check = await validateAuthorize(
      c.get('db'),
      (k) => url.searchParams.get(k) ?? '',
    )
    if (!check.ok) {
      if (check.kind === 'redirect') return c.redirect(check.to, 302)
      return c.html(
        page(
          'Request refused',
          `<h1>That request cannot be approved</h1>
           <p>${esc(check.message)}. Nothing has been shared.</p>`,
        ),
        400,
      )
    }

    const token = getCookie(c, SESSION_COOKIE)
    const actor = token ? await resolveToken(c.get('db'), token) : null
    if (!actor || actor.kind !== 'human') {
      // Sign in, then come back here with the parameters intact. Losing them
      // is the failure this route exists to avoid.
      const back = `/oauth/authorize?${url.searchParams.toString()}`
      return c.html(
        page(
          'Sign in',
          `<h1>Sign in to continue</h1>
           <p><strong>${esc(check.p.clientName)}</strong> is asking to connect to Acta.
              Sign in and you will come straight back here.</p>
           <div class="row"><a class="btn" href="/login?to=${encodeURIComponent(back)}">Sign in</a></div>`,
        ),
      )
    }

    const hidden = [
      'client_id',
      'redirect_uri',
      'state',
      'code_challenge',
      'code_challenge_method',
      'response_type',
      'scope',
    ]
      .map(
        (k) =>
          `<input type="hidden" name="${k}" value="${esc(url.searchParams.get(k) ?? '')}">`,
      )
      .join('')

    return c.html(
      page(
        'Connect',
        `<h1>Connect ${esc(check.p.clientName)}?</h1>
         <p>It will act as <strong>@${esc(actor.handle)}</strong> in this workspace, and
            anything it does will be recorded under your name.</p>
         <ul>
           <li>Read spaces, cards, documents and activity</li>
           <li>Create and change them</li>
           <li>No administration: it cannot manage members or mint tokens</li>
         </ul>
         <p>You can revoke it at any time in Settings.</p>
         <form method="post" action="/oauth/authorize">${hidden}
           <div class="row">
             <button type="submit" name="decision" value="deny">Cancel</button>
             <button type="submit" name="decision" value="approve" class="primary">Connect</button>
           </div>
         </form>`,
      ),
    )
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
      return c.redirect(`/oauth/authorize?${params.toString()}`, 302)
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
