import { Hono } from 'hono'
import type { ISqlDriver } from './db'
import type { IActorCtx } from './core/ctx'
import { bootstrapWorkspace, type IBootstrapOptions } from './core/bootstrap'
import { mcpRoutes } from './mcp'
import { apiRoutes } from './routes/api'
import { authRoutes, requireAuth } from './routes/auth'
import { ingestRoutes } from './routes/ingest'
import { AttachmentStore } from './services/attachments'
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
  /** Directory for attachment content. */
  dataDir?: string
  /** Directory with the built SPA; when set, the server serves it. */
  webDist?: string
  /** Overridable for tests. */
  fetchImpl?: typeof fetch
  webhookBackoffMs?: number
}

export function createApp(
  db: ISqlDriver,
  opts: IAppOptions = {},
): Hono<IAppEnv> {
  const workspaceId = bootstrapWorkspace(db, opts.bootstrap ?? {})
  const store = new AttachmentStore(`${opts.dataDir ?? './data'}/attachments`)
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

  app.route('/api/v1/auth', authRoutes())
  app.route('/api/v1/ingest', ingestRoutes())
  app.use('/api/v1/*', requireAuth())
  app.route('/api/v1', apiRoutes(store))

  app.use('/mcp', requireAuth())
  app.route('/mcp', mcpRoutes(store))

  // Static SPA: assets by path, index.html fallback so vue-router resolves
  // client-side (house pattern: run_worker_first + html_handling none).
  if (opts.webDist) {
    const dist = opts.webDist
    app.get('*', async (c) => {
      const path = new URL(c.req.url).pathname
      if (path.startsWith('/api/') || path === '/mcp') return c.notFound()
      const candidate = Bun.file(`${dist}${path}`)
      if (path !== '/' && (await candidate.exists()))
        return new Response(candidate)
      return new Response(Bun.file(`${dist}/index.html`), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    })
  }

  return app
}
