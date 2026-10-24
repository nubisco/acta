import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { ISqlDriver } from './db'
import type { IActorCtx } from './core/ctx'
import { bootstrapWorkspace, type IBootstrapOptions } from './core/bootstrap'
import { currentEdition, type IEditionDeps } from './core/edition'
import { mcpRateLimited, mcpRoutes } from './mcp'
import { apiRoutes } from './routes/api'
import {
  authRoutes,
  requireAuth,
  requireWorkspace,
  SESSION_COOKIE,
  type TSsoRuntime,
} from './routes/auth'
import { hookRoutes } from './routes/hooks'
import { platformWebhookRoutes } from './routes/platform-webhook'
import {
  oauthRoutes,
  protectedResourceMetadata,
  authorizationServerMetadata,
} from './routes/oauth'
import { OAUTH_CORS } from './core/oauth'
import { ingestRoutes } from './routes/ingest'
import { JwksVerifier, type ISsoConfig } from './core/sso'
import { OidcClient, type IOidcConfig } from './core/oidc'
import { AttachmentStore, type IBlobStore } from './services/attachments'
import { outboundFetchDeps, type IFetchDeps } from './core/safeFetch'
import {
  memoryRateLimiters,
  rateLimit,
  clientIp,
  WRITE_METHODS,
  type TRateLimiters,
} from './core/rateLimit'
import type { TEmailSender } from './core/email'
import { startRulesEngine } from './services/rules'
import { startWebhookDispatcher } from './services/webhooks'
import { onEvent } from './core/events'
import { liveFrame, type ILiveTransport } from './core/live'
import type { IRunOptions } from './services/dailyReport'
import { exportByToken } from './services/workspaceExport'

export interface IAppEnv {
  Variables: {
    db: ISqlDriver
    workspaceId: string
    actor: IActorCtx
  }
}

export interface IAppOptions {
  bootstrap?: IBootstrapOptions
  /**
   * The commit this build came from, reported by /healthz.
   *
   * Without it every instance answers "dev" and there is no way to tell a
   * deploy that landed from one that silently did not, which cost us most of
   * a day of guessing.
   */
  buildSha?: string
  /** Attachment content store. Defaults to the filesystem under dataDir. */
  blobStore?: IBlobStore
  /** Directory for the default filesystem blob store. */
  dataDir?: string
  /**
   * Serves the SPA for non-API GETs. Bun passes a file reader; the Workers
   * entrypoint passes the assets binding.
   */
  serveAsset?: (path: string) => Promise<Response | null>
  /**
   * External identity provider. When set it owns sign-in, and one-time codes
   * are off unless `otpFallback` asks for them back.
   */
  sso?: ISsoConfig
  /**
   * Standard OpenID Connect provider. Takes precedence over `sso`, which is
   * the older JWT-handover contract that only Nubisco Platform implements.
   */
  oidc?: IOidcConfig
  /**
   * Keep one-time codes alongside a configured provider. Off by default: a
   * second door beside the provider lets an account it has disabled still
   * sign in, and the default sender prints the code to the log.
   */
  otpFallback?: boolean
  /**
   * Shared secret the identity provider signs its webhook deliveries with
   * (PLATFORM_WEBHOOK_SECRET). Unset means the webhook endpoint answers 404,
   * which is the self-hosted default: an instance with no provider has
   * nothing to receive.
   */
  platformWebhookSecret?: string
  /** Overridable for tests. */
  fetchImpl?: typeof fetch
  /**
   * Resolver and fetch behind the SSRF guard, for requests to addresses users
   * supply (imported images). Overridable for tests.
   */
  remoteFetchDeps?: IFetchDeps
  webhookBackoffMs?: number
  /**
   * Acta's own public address. Only used to turn a card key into a link in
   * outbound messages; everything works without it, just without the link.
   */
  baseUrl?: string
  /**
   * Who holds the tabs' live sockets (see core/live.ts). Unset, the socket
   * endpoint answers 404 and the app falls back to the in-process stream,
   * which is right for tests and for anything running as one process.
   */
  live?: ILiveTransport
  /**
   * The secret workspace AI provider keys are encrypted under
   * (ACTA_AI_ENCRYPTION_KEY). Unset, a key cannot be stored, unless
   * `aiDevSecret` lets a local instance use a built-in one.
   */
  aiEncryptionKey?: string
  aiDevSecret?: boolean
  /**
   * Request rate limits (core/rateLimit.ts). On Workers, the native
   * `[[ratelimits]]` bindings. Everywhere else, in-process counters, which is
   * also the default.
   */
  rateLimiters?: TRateLimiters
  /**
   * Hostname resolver behind the SSRF guard on outbound webhooks and rule
   * actions. Tests pass one that answers with a public address, so no test
   * touches DNS. Defaults to the real resolver.
   */
  outboundResolve?: (hostname: string) => Promise<string[]>
  /**
   * Sends invitation emails. Unset means an invitation hands its link back to
   * the admin who made it, which is the self-hosted default with no email.
   */
  emailSender?: TEmailSender
  /**
   * The deployment's variables, handed to the Enterprise Edition so its
   * features read their own settings (core/edition.ts). The core reads none.
   */
  editionEnv?: Record<string, string | undefined>
  /**
   * Where the Nubisco Analytics tracker is served from (ACTA_ANALYTICS_URL).
   * Unset, the SPA loads no tracker, which is the self-hosted default.
   */
  analyticsUrl?: string
}

/**
 * What the AI settings and the daily report run with, from the app options.
 * The cron builds the same thing, so a scheduled report and a preview from
 * Settings use one secret and one address.
 */
export function reportRunOptions(
  opts: Pick<
    IAppOptions,
    'aiEncryptionKey' | 'aiDevSecret' | 'baseUrl' | 'fetchImpl'
  >,
): IRunOptions {
  return {
    secret: { secret: opts.aiEncryptionKey, devSecret: opts.aiDevSecret },
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
  }
}

export async function createApp(
  db: ISqlDriver,
  opts: IAppOptions = {},
): Promise<Hono<IAppEnv>> {
  const workspaceId = await bootstrapWorkspace(db, opts.bootstrap ?? {})
  const store = new AttachmentStore(
    opts.blobStore ??
      (await fsBlobStore(`${opts.dataDir ?? './data'}/attachments`)),
  )
  // Every outbound POST to an address a workspace typed in goes through the
  // SSRF guard (LA-397), webhooks and rule actions alike.
  const outbound = outboundFetchDeps(opts.fetchImpl, opts.outboundResolve)
  startWebhookDispatcher(db, {
    fetchDeps: outbound,
    backoffMs: opts.webhookBackoffMs,
    baseUrl: opts.baseUrl,
  })
  startRulesEngine(db, { fetchDeps: outbound })
  const limiters = opts.rateLimiters ?? memoryRateLimiters()
  const publish = opts.live?.publish
  if (publish)
    onEvent((event) =>
      publish(event.workspace_id, liveFrame(event)).catch(() => {
        // A tab that misses a frame catches up when it reconnects, so a
        // failed publish is never worth failing anything else over.
      }),
    )

  const app = new Hono<IAppEnv>()
  const reportOpts = reportRunOptions(opts)

  app.use('*', async (c, next) => {
    c.set('db', db)
    c.set('workspaceId', workspaceId)
    await next()
  })

  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      service: 'acta',
      build: opts.buildSha ?? 'dev',
      edition: currentEdition().name,
      ts: Date.now(),
    }),
  )

  /**
   * OAuth discovery. Mounted before everything else because a connector asks
   * these questions unauthenticated, and the SPA fallback below would
   * otherwise hand it the sign-in redirect and end the handshake.
   *
   * The openid-configuration alias is deliberate: Acta is not an OpenID
   * provider, but several clients try that path first and treat a 404 as "no
   * authorization server here".
   */
  const asMeta = (c: {
    req: { url: string }
    json: (b: unknown, s?: number, h?: Record<string, string>) => Response
  }) =>
    c.json(
      authorizationServerMetadata(new URL(c.req.url).origin),
      200,
      OAUTH_CORS,
    )
  const prMeta = (c: {
    req: { url: string }
    json: (b: unknown, s?: number, h?: Record<string, string>) => Response
  }) =>
    c.json(
      protectedResourceMetadata(new URL(c.req.url).origin),
      200,
      OAUTH_CORS,
    )

  /**
   * Both the plain and the path-inserted spellings.
   *
   * RFC 8414 builds the metadata path by inserting .well-known between the
   * issuer's host and its path, so a client discovering the resource
   * https://host/mcp asks for /.well-known/oauth-authorization-server/mcp as
   * well as the bare path, and tries the OpenID spelling of both. Clients
   * differ in which they try first and several try all of them.
   *
   * Answering only the bare path is what broke the claude.ai connector: the
   * path-inserted probes fell through to the SPA, which redirected them into
   * the sign-in flow, so the client followed a 302 into an HTML page instead
   * of reading metadata, and reported that it could not reach the server at
   * all. Our issuer has no path component, so every spelling describes the
   * same server and returns the same document.
   */
  app.get('/.well-known/oauth-authorization-server', asMeta)
  app.get('/.well-known/oauth-authorization-server/*', asMeta)
  app.get('/.well-known/openid-configuration', asMeta)
  app.get('/.well-known/openid-configuration/*', asMeta)
  app.get('/mcp/.well-known/oauth-authorization-server', asMeta)
  app.get('/.well-known/oauth-protected-resource', prMeta)
  app.get('/.well-known/oauth-protected-resource/*', prMeta)
  app.get('/mcp/.well-known/oauth-protected-resource', prMeta)
  // Registration is unauthenticated by design (RFC 7591), so it is limited
  // per address, tightly. See core/oauth.ts for the rest of its guard.
  app.use(
    '/oauth/register',
    rateLimit({
      name: 'oauth_register',
      limiter: limiters.oauth_register,
      methods: ['POST'],
      key: (c) => `ip:${clientIp(c.req.header.bind(c.req))}`,
    }),
  )
  app.route('/oauth', oauthRoutes())

  // Two provider modes, one runtime. OIDC wins when both are configured: it
  // is the standard one, and an instance that has gone to the trouble of
  // configuring a real provider did not mean to keep the bespoke contract.
  const ssoRuntime: TSsoRuntime | undefined = opts.oidc
    ? {
        mode: 'oidc',
        config: opts.oidc,
        client: new OidcClient(opts.oidc, { fetchImpl: opts.fetchImpl }),
      }
    : opts.sso
      ? {
          mode: 'handover',
          config: opts.sso,
          verifier: new JwksVerifier(opts.sso.issuer, {
            fetchImpl: opts.fetchImpl,
          }),
        }
      : undefined
  // One rule, read in two places: the auth routes gate the endpoints with it
  // and the SPA fallback decides whether there is anything to show but a
  // redirect.
  const otpEnabled = ssoRuntime === undefined || opts.otpFallback === true

  // Rate limits (LA-397). Mounted before the routes they guard.
  //
  // Sign-in codes and invitation acceptance: by address, since nobody is
  // signed in yet. Each one sends an email or checks a secret.
  app.use(
    '/api/v1/auth/*',
    rateLimit({
      name: 'auth',
      limiter: limiters.auth,
      methods: ['POST'],
      key: (c) => `ip:${clientIp(c.req.header.bind(c.req))}`,
      skip: (path) =>
        !(
          path === '/api/v1/auth/otp' ||
          path === '/api/v1/auth/verify' ||
          path.startsWith('/api/v1/auth/invitations/') ||
          path.startsWith('/api/v1/auth/signup/')
        ),
    }),
  )
  // The public ingest endpoint (a contact form): by address.
  app.use(
    '/api/v1/ingest/*',
    rateLimit({
      name: 'ingest',
      limiter: limiters.ingest,
      methods: ['POST'],
      key: (c) => `ip:${clientIp(c.req.header.bind(c.req))}`,
    }),
  )
  // Every other write, by credential. Provider webhooks are left alone: they
  // are signature-authenticated, GitHub delivers in bursts, and a limit there
  // would drop events rather than slow anyone down.
  app.use(
    '/api/v1/*',
    rateLimit({
      name: 'write',
      limiter: limiters.write,
      methods: WRITE_METHODS,
      skip: (path) =>
        path.startsWith('/api/v1/hooks/') ||
        path.startsWith('/api/v1/platform/') ||
        path.startsWith('/api/v1/ingest/') ||
        path.startsWith('/api/v1/auth/invitations/') ||
        path === '/api/v1/auth/otp' ||
        path === '/api/v1/auth/verify',
    }),
  )
  // What an Enterprise Edition is handed: its routes, its sign-in hook.
  const editionDeps: IEditionDeps = {
    db,
    baseUrl: opts.baseUrl,
    emailSender: opts.emailSender,
    env: opts.editionEnv,
  }
  app.route(
    '/api/v1/auth',
    authRoutes(ssoRuntime, {
      otpFallback: opts.otpFallback,
      edition: editionDeps,
      analyticsUrl: opts.analyticsUrl,
    }),
  )
  app.route('/api/v1/ingest', ingestRoutes(store))
  // Provider webhooks authenticate by signature, not by session, so they
  // mount before requireAuth.
  app.route('/api/v1/hooks', hookRoutes())
  // An emailed export link (LA-401). The token in it is the credential, so it
  // mounts before requireAuth, and anything not exactly right is a 404.
  app.get('/api/v1/exports/:id', async (c) => {
    const found = await exportByToken(
      db,
      store,
      c.req.param('id'),
      c.req.query('token') ?? '',
    )
    if (!found) return c.json({ error: 'not found' }, 404)
    return new Response(new Uint8Array(found.bytes), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${found.filename}"`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      },
    })
  })
  // Identity-provider events (avatar changes, membership). Signature
  // authenticated for the same reason, and 404 when no secret is set.
  app.route(
    '/api/v1/platform',
    platformWebhookRoutes(
      opts.platformWebhookSecret,
      ssoRuntime?.config.issuer,
    ),
  )
  // Enterprise Edition routes (core/edition.ts), when one is registered. Ahead
  // of the workspace API and its auth middleware, so each authenticates for
  // itself. The core edition adds nothing.
  currentEdition().mountRoutes?.(app, editionDeps)

  // Workspace-scoped API: the segment names the workspace, and the middleware
  // resolves who you are inside it. This is the path the app uses.
  app.use('/api/v1/w/:workspace/*', requireWorkspace())
  app.route(
    '/api/v1/w/:workspace',
    apiRoutes(store, {
      remoteFetchDeps: opts.remoteFetchDeps,
      liveSocket: opts.live?.socket,
      report: reportOpts,
      invites: { send: opts.emailSender, baseUrl: opts.baseUrl },
    }),
  )

  // The same API without a workspace segment, meaning "the workspace this
  // token was minted in". Agent tokens, the MCP server and the importers all
  // address Acta this way, and a token is a grant on one workspace, so there
  // is nothing for them to choose.
  app.use('/api/v1/*', requireAuth())
  app.route(
    '/api/v1',
    apiRoutes(store, {
      remoteFetchDeps: opts.remoteFetchDeps,
      liveSocket: opts.live?.socket,
      report: reportOpts,
      invites: { send: opts.emailSender, baseUrl: opts.baseUrl },
    }),
  )

  /**
   * CORS for the MCP endpoint.
   *
   * A connector UI runs in a browser, so before it ever sees the 401 it sends
   * a preflight. That preflight cannot carry credentials and must not be
   * authenticated: answering it with 401 and no CORS headers fails the request
   * at the network layer, which is why a connector reported that it could not
   * even connect, let alone work out how to sign in.
   *
   * Exposing www-authenticate matters just as much. A browser cannot read a
   * response header unless it is listed here, so without it the RFC 9728
   * pointer is present, correct and invisible to the only kind of client that
   * needs it.
   */
  const MCP_CORS: Record<string, string> = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers':
      'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
    'access-control-expose-headers':
      'WWW-Authenticate, MCP-Protocol-Version, Mcp-Session-Id',
  }
  app.options(
    '/mcp',
    () =>
      new Response(null, {
        status: 204,
        headers: { ...MCP_CORS, 'access-control-max-age': '86400' },
      }),
  )
  app.use('/mcp', async (c, next) => {
    await next()
    for (const [k, v] of Object.entries(MCP_CORS)) c.res.headers.set(k, v)
  })
  // By credential, inside the CORS wrapper so a refusal is still readable
  // from a browser-based connector. A refused tool call comes back as a
  // result the model can read (AGENTS.md "MCP servers"), not a dead socket.
  app.use(
    '/mcp',
    rateLimit({
      name: 'mcp',
      limiter: limiters.mcp,
      methods: ['POST'],
      refuse: mcpRateLimited,
    }),
  )
  app.use('/mcp', requireAuth({ resourceMetadata: true }))
  app.route('/mcp', mcpRoutes(store))

  // Static SPA: assets by path, index.html fallback so vue-router resolves
  // client-side (house pattern: run_worker_first + html_handling none).
  const serveAsset = opts.serveAsset
  if (serveAsset) {
    app.get('*', async (c) => {
      const url = new URL(c.req.url)
      const path = url.pathname
      if (path.startsWith('/api/') || path === '/mcp') return c.notFound()
      if (path !== '/') {
        const asset = await serveAsset(path)
        if (asset) return asset
      }

      /**
       * Hand a signed-out visitor to the provider here, not in the browser.
       *
       * Deciding this client-side means serving the app, booting it, asking
       * /auth/config and only then navigating away, so Acta's own sign-in
       * page is always painted first. No amount of client code removes that
       * flash: by the time the client can decide, the page is on screen.
       *
       * Only where the provider is the sole way in, because otherwise there
       * is a real choice to present. `error` is exempt or a failed sign-in
       * would bounce straight back out and loop.
       */
      /**
       * A machine-readable discovery path must never be answered with a
       * human sign-in redirect. Anything under /.well-known that we do not
       * serve is simply absent, so a client can rule it out and move on
       * rather than following a 302 into a login page.
       */
      if (path.startsWith('/.well-known/')) return c.notFound()

      /**
       * An invitation link opens the accept page as it is, signed in or not.
       * The page explains what is about to happen and sends the person to the
       * provider itself, carrying which invitation this is. Bouncing straight
       * to the provider here would lose that, and the sign-in would end at
       * "not a member" for someone who was invited.
       */
      const invitePage = path.startsWith('/invite/')

      const signedOut = !getCookie(c as never, SESSION_COOKIE)
      if (
        ssoRuntime &&
        !otpEnabled &&
        signedOut &&
        !invitePage &&
        !url.searchParams.has('error')
      ) {
        // Carry where they were going. Without this, anyone sent to sign in
        // mid-task lands at the workspace home instead, which silently breaks
        // the OAuth consent screen: the connector's request is gone.
        const to = url.pathname + url.search
        return c.redirect(
          to === '/'
            ? '/api/v1/auth/sso/start'
            : `/api/v1/auth/sso/start?to=${encodeURIComponent(to)}`,
          302,
        )
      }
      const index = await serveAsset('/index.html')
      if (!index) return c.notFound()
      return new Response(index.body, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    })
  }

  return app
}

/** Bun-only filesystem blob store; the Workers entrypoint supplies R2. */
export async function fsBlobStore(dir: string): Promise<IBlobStore> {
  const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } =
    await import('node:fs')
  const { join } = await import('node:path')
  mkdirSync(dir, { recursive: true })
  return {
    put: (id, bytes) => {
      writeFileSync(join(dir, id), bytes)
      return Promise.resolve()
    },
    get: (id) => {
      const path = join(dir, id)
      if (!existsSync(path)) return Promise.resolve(null)
      return Promise.resolve(new Uint8Array(readFileSync(path)))
    },
    delete: (id) => {
      rmSync(join(dir, id), { force: true })
      return Promise.resolve()
    },
  }
}

/** Bun-only static file reader for the SPA. */
export function bunAssetReader(
  dist: string,
): (path: string) => Promise<Response | null> {
  return async (path) => {
    const file = Bun.file(`${dist}${path}`)
    if (!(await file.exists())) return null
    return new Response(file)
  }
}
