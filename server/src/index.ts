import { mkdirSync } from 'node:fs'
import { bunAssetReader, createApp } from './app'
import { ssoConfigFromEnv } from './core/sso'
import { oidcConfigFromEnv } from './core/oidc'
import { openDb } from './db'
import {
  channelsFromEnv,
  notificationSweep,
} from './services/notificationSweep'

const DATA_DIR = process.env.ACTA_DATA_DIR ?? './data'
const PORT = Number(process.env.ACTA_PORT ?? 4460)
const WEB_DIST = process.env.ACTA_WEB_DIST

mkdirSync(DATA_DIR, { recursive: true })

const db = await openDb(`${DATA_DIR}/acta.sqlite`)
const app = await createApp(db, {
  dataDir: DATA_DIR,
  baseUrl: process.env.ACTA_BASE_URL,
  serveAsset: WEB_DIST ? bunAssetReader(WEB_DIST) : undefined,
  sso: ssoConfigFromEnv(process.env) ?? undefined,
  oidc: oidcConfigFromEnv(process.env) ?? undefined,
  otpFallback: process.env.ACTA_OTP_FALLBACK === 'true',
  platformWebhookSecret: process.env.PLATFORM_WEBHOOK_SECRET,
  bootstrap: {
    workspaceName: process.env.ACTA_WORKSPACE ?? 'Nubisco',
    adminEmail: process.env.ACTA_ADMIN_EMAIL,
    adminHandle: process.env.ACTA_ADMIN_HANDLE,
    adminName: process.env.ACTA_ADMIN_NAME,
  },
})

/**
 * The time-driven half of notifications: due dates arriving, and unread
 * notifications going unread for long enough to be worth an email. On
 * Cloudflare a cron trigger does this; here it is an interval, so a
 * self-hosted instance has the same feature rather than a documented one it
 * does not actually have.
 *
 * A minute, against a sweep whose shortest window is ten. Cheap because both
 * queries are indexed and return nothing almost every time, and the slack
 * means a due date lands close to when it was set rather than up to a
 * window late. Errors are logged and swallowed: a failing sweep must not
 * take the process down with it.
 */
const SWEEP_INTERVAL_MS = 60_000
const channels = channelsFromEnv(process.env)
setInterval(() => {
  void notificationSweep(db, {
    channels,
    baseUrl: process.env.ACTA_BASE_URL,
  }).catch((err) => console.error('notification sweep failed', err))
}, SWEEP_INTERVAL_MS)

export default {
  port: PORT,
  fetch: app.fetch,
}

console.log(`acta server listening on :${PORT} (data: ${DATA_DIR})`)
