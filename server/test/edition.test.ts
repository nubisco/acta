import { afterEach, describe, expect, it } from 'bun:test'
import { createApp } from '../src/app'
import { openDb } from '../src/db'
import type { ICtx } from '../src/core/ctx'
import {
  PlanLimitError,
  UNLIMITED,
  assertWithinLimit,
  currentEdition,
  getLimits,
  registerEdition,
  resetEdition,
  type IEdition,
} from '../src/core/edition'

async function ctxOn(): Promise<ICtx> {
  const db = await openDb(':memory:')
  return {
    db,
    workspaceId: 'ws_test',
    actor: {
      id: 'act_1',
      kind: 'human',
      handle: 'a',
      role: 'admin',
      scopes: [],
    },
  }
}

afterEach(() => resetEdition())

// The self-hosted case: nothing registers an edition, so nothing is limited
// and nothing extra is served (LA-400).
describe('core edition', () => {
  it('is what runs when nothing is registered', async () => {
    expect(currentEdition().name).toBe('core')
    const ctx = await ctxOn()
    expect(await getLimits(ctx.db, ctx.workspaceId)).toEqual({ ...UNLIMITED })
  })

  it('never refuses, however much a workspace holds', async () => {
    const ctx = await ctxOn()
    await assertWithinLimit(ctx, 'spaces', 1_000_000)
    await assertWithinLimit(ctx, 'storage_bytes', 1e15, 1e12)
  })

  it('reports itself on /healthz', async () => {
    const db = await openDb(':memory:')
    const app = await createApp(db, { dataDir: '/tmp/acta-test-edition-core' })
    const body = (await (await app.request('/healthz')).json()) as {
      edition: string
    }
    expect(body.edition).toBe('core')
  })
})

describe('a registered edition', () => {
  const capped: IEdition = {
    name: 'enterprise',
    getLimits: async () => ({ ...UNLIMITED, spaces: 3 }),
    mountRoutes: (app) => {
      app.get('/api/v1/ee/ping', (c) => c.json({ ee: true }))
    },
  }

  it('supplies the limits', async () => {
    registerEdition(capped)
    const ctx = await ctxOn()
    expect((await getLimits(ctx.db, ctx.workspaceId)).spaces).toBe(3)
    expect((await getLimits(ctx.db, ctx.workspaceId)).members).toBeNull()
  })

  it('refuses past the cap with a 402 that says what and how many', async () => {
    registerEdition(capped)
    const ctx = await ctxOn()
    await assertWithinLimit(ctx, 'spaces', 2)
    const err = await assertWithinLimit(ctx, 'spaces', 3).catch((e) => e)
    expect(err).toBeInstanceOf(PlanLimitError)
    expect(err.status).toBe(402)
    expect(err.current).toEqual({
      error: 'plan_limit',
      resource: 'spaces',
      limit: 3,
      current: 3,
    })
    expect(err.message).toContain('allows 3 spaces')
    // Uncapped resources stay open.
    await assertWithinLimit(ctx, 'members', 500)
  })

  it('mounts its routes ahead of the workspace auth, and names itself', async () => {
    registerEdition(capped)
    const db = await openDb(':memory:')
    const app = await createApp(db, { dataDir: '/tmp/acta-test-edition-ee' })
    const ping = await app.request('/api/v1/ee/ping')
    expect(ping.status).toBe(200)
    expect(await ping.json()).toEqual({ ee: true })
    const health = (await (await app.request('/healthz')).json()) as {
      edition: string
    }
    expect(health.edition).toBe('enterprise')
  })

  it('leaves no route behind once the core edition is back', async () => {
    const db = await openDb(':memory:')
    const app = await createApp(db, { dataDir: '/tmp/acta-test-edition-none' })
    expect((await app.request('/api/v1/ee/ping')).status).not.toBe(200)
  })
})
