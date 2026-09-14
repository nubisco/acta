import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { ISqlDriver } from './db'
import type { IActorCtx } from './core/ctx'
import { bootstrapWorkspace, type IBootstrapOptions } from './core/bootstrap'
import { mcpRoutes } from './mcp'
import { apiRoutes } from './routes/api'
import {
  authRoutes,
  requireAuth,
  requireWorkspace,
  SESSION_COOKIE,
  type TSsoRuntime,
} from './routes/auth'
import { hookRoutes } from './routes/hooks'
import { ingestRoutes } from './routes/ingest'
import { JwksVerifier, type ISsoConfig } from './core/sso'
import { OidcClient, type IOidcConfig } from './core/oidc'
import { AttachmentStore, type IBlobStore } from './services/attachments'
import { startRulesEngine } from './services/rules'
import { startWebhookDispatcher } from './services/webhooks'

export interface IAppEnv {
  Variables: {
    db: ISqlDriver
    workspaceId: string
    actor: IActorCtx
  }
}

export interface IAppOptions {
  bootstrap?: IBootstrapOptions
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
  /** Overridable for tests. */
  fetchImpl?: typeof fetch
  webhookBackoffMs?: number
  /**
   * Acta's own public address. Only used to turn a card key into a link in
   * outbound messages; everything works without it, just without the link.
   */
  baseUrl?: string
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
  startWebhookDispatcher(db, {
    fetchImpl: opts.fetchImpl,
    backoffMs: opts.webhookBackoffMs,
    baseUrl: opts.baseUrl,
  })
  startRulesEngine(db, { fetchImpl: opts.fetchImpl })

  const app = new Hono<IAppEnv>()

  app.use('*', async (c, next) => {
    c.set('db', db)
    c.set('workspaceId', workspaceId)
    await next()
  })

  app.get('/healthz', (c) =>
    c.json({ ok: true, service: 'acta', ts: Date.now() }),
  )

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
  app.route(
    '/api/v1/auth',
    authRoutes(ssoRuntime, { otpFallback: opts.otpFallback }),
  )
  app.route('/api/v1/ingest', ingestRoutes(store))
  // Provider webhooks authenticate by signature, not by session, so they
  // mount before requireAuth.
  app.route('/api/v1/hooks', hookRoutes())
  // Workspace-scoped API: the segment names the workspace, and the middleware
  // resolves who you are inside it. This is the path the app uses.
  app.use('/api/v1/w/:workspace/*', requireWorkspace())
  app.route('/api/v1/w/:workspace', apiRoutes(store))

  // The same API without a workspace segment, meaning "the workspace this
  // token was minted in". Agent tokens, the MCP server and the importers all
  // address Acta this way, and a token is a grant on one workspace, so there
  // is nothing for them to choose.
  app.use('/api/v1/*', requireAuth())
  app.route('/api/v1', apiRoutes(store))

  app.use('/mcp', requireAuth())
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
      const signedOut = !getCookie(c as never, SESSION_COOKIE)
      if (
        ssoRuntime &&
        !otpEnabled &&
        signedOut &&
        !url.searchParams.has('error')
      ) {
        return c.redirect('/api/v1/auth/sso/start', 302)
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
async function fsBlobStore(dir: string): Promise<IBlobStore> {
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
