/**
 * Cloudflare Workers entrypoint: D1 for data, R2 for attachment content, the
 * assets binding for the SPA, and executionCtx.waitUntil for deferred work
 * (webhook deliveries, rule runs). The Bun entrypoint is src/index.ts.
 */

import type { Hono } from 'hono'
import { createApp, reportRunOptions, type IAppEnv } from './app'
import { dailyReportTick } from './services/dailyReport'
import { setDeferrer } from './core/defer'
import { sharedStartup } from './core/startup'
import { ssoConfigFromEnv } from './core/sso'
import { oidcConfigFromEnv } from './core/oidc'
import { D1Driver, type ID1Database } from './db'
import { emailSenderFromEnv } from './core/email'
import { pruneOauthClients } from './core/oauth'
import { rateLimitersFromBindings } from './core/rateLimit'
import { hubLive, type IHubNamespace } from './live-hub'
import { AttachmentStore, type IBlobStore } from './services/attachments'
import { maintenanceTick } from './services/maintenance'
import { currentEdition } from './core/edition'
import {
  channelsFromEnv,
  notificationSweep,
} from './services/notificationSweep'

interface IR2Body {
  arrayBuffer(): Promise<ArrayBuffer>
}

interface IR2Bucket {
  put(key: string, value: Uint8Array): Promise<unknown>
  get(key: string): Promise<IR2Body | null>
  delete(key: string): Promise<void>
}

interface IAssetsBinding {
  fetch(request: Request): Promise<Response>
}

interface IWorkerEnv {
  DB: ID1Database
  ATTACHMENTS: IR2Bucket
  ASSETS: IAssetsBinding
  /** The live-updates hub, one per workspace (see live-hub.ts). */
  LIVE: IHubNamespace
  /** Set by the deploy workflow (--var), reported by /healthz. */
  ACTA_BUILD_SHA?: string
  ACTA_WORKSPACE?: string
  ACTA_ADMIN_EMAIL?: string
  ACTA_ADMIN_HANDLE?: string
  ACTA_ADMIN_NAME?: string
  ACTA_SSO_ISSUER?: string
  ACTA_SSO_APP_ID?: string
  ACTA_SSO_AUTHORIZE_URL?: string
  ACTA_SSO_AUTO_PROVISION?: string
  /** Standard OpenID Connect. Preferred over the ACTA_SSO_* handover contract. */
  ACTA_OIDC_ISSUER?: string
  ACTA_OIDC_CLIENT_ID?: string
  ACTA_OIDC_CLIENT_SECRET?: string
  ACTA_OIDC_SCOPES?: string
  ACTA_OIDC_AUTO_PROVISION?: string
  ACTA_OIDC_LABEL?: string
  ACTA_SSO_LABEL?: string
  /** Keep one-time codes alongside a configured provider. Off by default. */
  ACTA_OTP_FALLBACK?: string
  /** Public address, used to link back from outbound messages. */
  ACTA_BASE_URL?: string
  /** What workspace AI provider keys are encrypted under. A secret. */
  ACTA_AI_ENCRYPTION_KEY?: string
  /**
   * Shared secret the identity provider signs webhook deliveries with. A
   * secret, so it is set with `wrangler secret put PLATFORM_WEBHOOK_SECRET`
   * and never in wrangler.toml. Unset means the webhook answers 404.
   */
  PLATFORM_WEBHOOK_SECRET?: string
  /**
   * Resend key for notification digests. A secret, so it is set with
   * `wrangler secret put ACTA_RESEND_API_KEY` and never in wrangler.toml.
   * Unset means notifications stay in the bell and nothing is emailed, which
   * is the self-hosted default.
   */
  ACTA_RESEND_API_KEY?: string
  /** The From address on those emails. Must be a verified Resend sender. */
  ACTA_EMAIL_FROM?: string
  /** Where the Nubisco Analytics tracker is served from. Unset, none loads. */
  ACTA_ANALYTICS_URL?: string
}

/** What a cron trigger hands the scheduled handler. */
interface IScheduledEvent {
  cron: string
  scheduledTime: number
}

interface IExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

function r2BlobStore(bucket: IR2Bucket): IBlobStore {
  return {
    put: async (id, bytes) => {
      await bucket.put(id, bytes)
    },
    get: async (id) => {
      const object = await bucket.get(id)
      if (!object) return null
      return new Uint8Array(await object.arrayBuffer())
    },
    delete: async (id) => {
      await bucket.delete(id)
    },
  }
}

/** Durable Object classes have to be exported by the worker's main module. */
export { LiveHub } from './live-hub'

/**
 * How long the first request may spend migrating and building the app. Long
 * enough for a real migration, short enough that a D1 call hung by a provider
 * incident turns into an error and the next request tries again, rather than
 * every request waiting on it for the life of the isolate (see core/startup).
 */
const STARTUP_TIMEOUT_MS = 20_000

/**
 * The migrated driver the app is built on. Held separately so the cron
 * handler can use the same one rather than opening a second: not because two
 * are expensive, but because only this one is known to have migrated, and a
 * sweep is the wrong place to discover that.
 */
const getDriver = sharedStartup(
  async (env: IWorkerEnv): Promise<D1Driver> => {
    const driver = new D1Driver(env.DB)
    await driver.migrate()
    return driver
  },
  STARTUP_TIMEOUT_MS,
  'database migration',
)

const getApp = sharedStartup(
  async (env: IWorkerEnv, origin: string): Promise<Hono<IAppEnv>> => {
    const driver = await getDriver(env)
    return createApp(driver, {
      blobStore: r2BlobStore(env.ATTACHMENTS),
      buildSha: env.ACTA_BUILD_SHA,
      // Falls back to the origin of the request that warmed this isolate, so
      // a self-hosted deploy links back to itself with nothing configured.
      baseUrl: env.ACTA_BASE_URL ?? origin,
      serveAsset: async (path) => {
        const res = await env.ASSETS.fetch(
          new Request(new URL(path, 'https://assets.local').toString()),
        )
        return res.status === 404 ? null : res
      },
      sso:
        ssoConfigFromEnv(
          env as unknown as Record<string, string | undefined>,
        ) ?? undefined,
      oidc:
        oidcConfigFromEnv(
          env as unknown as Record<string, string | undefined>,
        ) ?? undefined,
      otpFallback: env.ACTA_OTP_FALLBACK === 'true',
      platformWebhookSecret: env.PLATFORM_WEBHOOK_SECRET,
      aiEncryptionKey: env.ACTA_AI_ENCRYPTION_KEY,
      live: hubLive(env.LIVE),
      // The `[[ratelimits]]` bindings in wrangler.toml, each falling back to
      // an isolate-local counter if its block is missing.
      rateLimiters: rateLimitersFromBindings(
        env as unknown as Record<string, unknown>,
      ),
      emailSender: emailSenderFromEnv(
        env as unknown as Record<string, string | undefined>,
      ),
      // An Enterprise Edition reads its own settings from here (signup's
      // terms version, for one). The core reads none of it.
      editionEnv: env as unknown as Record<string, string | undefined>,
      analyticsUrl: env.ACTA_ANALYTICS_URL,
      bootstrap: {
        workspaceName: env.ACTA_WORKSPACE ?? 'Workspace',
        adminEmail: env.ACTA_ADMIN_EMAIL,
        adminHandle: env.ACTA_ADMIN_HANDLE,
        adminName: env.ACTA_ADMIN_NAME,
      },
    })
  },
  STARTUP_TIMEOUT_MS,
  'app startup',
)

export default {
  async fetch(
    request: Request,
    env: IWorkerEnv,
    executionCtx: IExecutionContext,
  ): Promise<Response> {
    setDeferrer((work) => executionCtx.waitUntil(work))
    const app = await getApp(env, new URL(request.url).origin)
    return app.fetch(request)
  },

  /**
   * The cron trigger (see `[triggers]` in wrangler.toml).
   *
   * It builds the app rather than only a driver, because the sweep emits
   * real events and the listeners those reach, webhooks and rules, are
   * registered by createApp. A sweep running against a bare driver would
   * write notifications and silently skip every integration.
   *
   * There is no request to take an origin from here, so an instance with no
   * ACTA_BASE_URL sends a digest with no links in it rather than links to
   * somewhere wrong.
   */
  async scheduled(
    _event: IScheduledEvent,
    env: IWorkerEnv,
    executionCtx: IExecutionContext,
  ): Promise<void> {
    setDeferrer((work) => executionCtx.waitUntil(work))
    await getApp(env, env.ACTA_BASE_URL ?? '')
    const driver = await getDriver(env)
    await notificationSweep(driver, {
      channels: channelsFromEnv(
        env as unknown as Record<string, string | undefined>,
      ),
      baseUrl: env.ACTA_BASE_URL,
    })
    // The daily report rides the same tick. It is cheap when it is not
    // time, and a failure is logged rather than failing the sweep above.
    await dailyReportTick(
      driver,
      reportRunOptions({
        aiEncryptionKey: env.ACTA_AI_ENCRYPTION_KEY,
        baseUrl: env.ACTA_BASE_URL,
      }),
    ).catch((err) => console.error('daily report tick failed', err))
    // OAuth clients registered and never used (core/oauth.ts).
    await pruneOauthClients(driver).catch((err) =>
      console.error('oauth client prune failed', err),
    )
    // Retention, workspace exports and purges, and the database size alert
    // (LA-401). Last, so a slow purge never delays a reminder.
    await maintenanceTick(driver, {
      store: new AttachmentStore(r2BlobStore(env.ATTACHMENTS)),
      send: emailSenderFromEnv(
        env as unknown as Record<string, string | undefined>,
      ),
      baseUrl: env.ACTA_BASE_URL,
    })
    // The edition's own cron work (signup's Free inactivity job). After the
    // core's, and its failure is the edition's to log, never the core's.
    await currentEdition()
      .scheduled?.({
        db: driver,
        send: emailSenderFromEnv(
          env as unknown as Record<string, string | undefined>,
        ),
        baseUrl: env.ACTA_BASE_URL,
        env: env as unknown as Record<string, string | undefined>,
      })
      .catch((err) => console.error('edition tick failed', err))
  },
}
