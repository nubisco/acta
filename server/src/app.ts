import { Hono } from 'hono'
import type { ISqlDriver } from './db'
import type { IActorCtx } from './core/ctx'
import { bootstrapWorkspace, type IBootstrapOptions } from './core/bootstrap'
import { mcpRoutes } from './mcp'
import { apiRoutes } from './routes/api'
import { authRoutes, requireAuth, type ISsoRuntime } from './routes/auth'
import { ingestRoutes } from './routes/ingest'
import { JwksVerifier, type ISsoConfig } from './core/sso'
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
  /** External SSO configuration; local OTP stays available regardless. */
  sso?: ISsoConfig
  /** Overridable for tests. */
  fetchImpl?: typeof fetch
  webhookBackoffMs?: number
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

  const ssoRuntime: ISsoRuntime | undefined = opts.sso
    ? {
        config: opts.sso,
        verifier: new JwksVerifier(opts.sso.issuer, {
          fetchImpl: opts.fetchImpl,
        }),
      }
    : undefined
  app.route('/api/v1/auth', authRoutes(ssoRuntime))
  app.route('/api/v1/ingest', ingestRoutes())
  app.use('/api/v1/*', requireAuth())
  app.route('/api/v1', apiRoutes(store))

  app.use('/mcp', requireAuth())
  app.route('/mcp', mcpRoutes(store))

  // Static SPA: assets by path, index.html fallback so vue-router resolves
  // client-side (house pattern: run_worker_first + html_handling none).
  const serveAsset = opts.serveAsset
  if (serveAsset) {
    app.get('*', async (c) => {
      const path = new URL(c.req.url).pathname
      if (path.startsWith('/api/') || path === '/mcp') return c.notFound()
      if (path !== '/') {
        const asset = await serveAsset(path)
        if (asset) return asset
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
