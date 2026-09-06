/**
 * Cloudflare Workers entrypoint: D1 for data, R2 for attachment content, the
 * assets binding for the SPA, and executionCtx.waitUntil for deferred work
 * (webhook deliveries, rule runs). The Bun entrypoint is src/index.ts.
 */

import type { Hono } from 'hono'
import { createApp, type IAppEnv } from './app'
import { setDeferrer } from './core/defer'
import { ssoConfigFromEnv } from './core/sso'
import { D1Driver, type ID1Database } from './db'
import type { IBlobStore } from './services/attachments'

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
  ACTA_WORKSPACE?: string
  ACTA_ADMIN_EMAIL?: string
  ACTA_ADMIN_HANDLE?: string
  ACTA_ADMIN_NAME?: string
  ACTA_SSO_ISSUER?: string
  ACTA_SSO_APP_ID?: string
  ACTA_SSO_AUTHORIZE_URL?: string
  ACTA_SSO_AUTO_PROVISION?: string
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

let appPromise: Promise<Hono<IAppEnv>> | null = null

function getApp(env: IWorkerEnv): Promise<Hono<IAppEnv>> {
  appPromise ??= (async () => {
    const driver = new D1Driver(env.DB)
    await driver.migrate()
    return createApp(driver, {
      blobStore: r2BlobStore(env.ATTACHMENTS),
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
      bootstrap: {
        workspaceName: env.ACTA_WORKSPACE ?? 'Workspace',
        adminEmail: env.ACTA_ADMIN_EMAIL,
        adminHandle: env.ACTA_ADMIN_HANDLE,
        adminName: env.ACTA_ADMIN_NAME,
      },
    })
  })()
  return appPromise
}

export default {
  async fetch(
    request: Request,
    env: IWorkerEnv,
    executionCtx: IExecutionContext,
  ): Promise<Response> {
    setDeferrer((work) => executionCtx.waitUntil(work))
    const app = await getApp(env)
    return app.fetch(request)
  },
}
