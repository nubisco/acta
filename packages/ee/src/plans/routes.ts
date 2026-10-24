// Copyright (c) Nubisco, Lda. All Rights Reserved.
// Acta Enterprise Edition. See packages/ee/LICENSE.

/**
 * Plans and billing over HTTP (LA-399).
 *
 * - POST /api/v1/billing/entitlement: the signed entitlement.updated webhook
 *   from licenses. Authenticated by its HMAC, so it sits ahead of the API's
 *   auth.
 * - /billing, /billing/checkout, /billing/portal, /billing/seats inside the
 *   workspace API: workspace admins only. The page reads the plan, usage and
 *   what Paddle.js needs; the actions go through licenses, never to Paddle.
 */

import type { Hono } from 'hono'
import { z } from 'zod'
import type { IAppEnv } from '../../../../server/src/app'
import { ApiError, type ICtx } from '../../../../server/src/core/ctx'
import type { IEditionDeps } from '../../../../server/src/core/edition'
import { usageSummary } from '../../../../server/src/core/usage'
import type { IAuthEnv } from '../../../../server/src/routes/auth'
import { signatureMatches } from '../../../../server/src/routes/platform-webhook'
import { billingEvents, sendBillingEvents } from './analytics'
import { planLimitsOf } from './catalogue'
import {
  LicensesError,
  openPortal,
  setSeats,
  startCheckout,
  type IEntitlement,
} from './client'
import { plansConfig } from './config'
import { TRIAL_SEAT_MESSAGE, planLimits } from './limits'
import { applyEntitlement, planFor } from './store'

const zEntitlementDelivery = z.object({
  event: z.literal('entitlement.updated'),
  timestamp: z.string(),
  data: z
    .object({
      app: z.string(),
      workspace_id: z.string().min(1),
      plan: z.string(),
      state: z.enum(['trialing', 'active', 'grace', 'restricted', 'free']),
      source: z.enum(['subscription', 'override', 'free']),
      limits: z.record(z.string(), z.number().nullable()),
      version: z.number().int(),
    })
    .passthrough(),
})

/** Applies a pushed or fetched entitlement, and reports what changed. */
async function receive(
  deps: IEditionDeps,
  e: IEntitlement,
): Promise<'applied' | 'stale' | 'unknown_workspace'> {
  const { outcome, before } = await applyEntitlement(deps.db, e, Date.now())
  const cfg = plansConfig()
  if (outcome === 'applied' && cfg)
    await sendBillingEvents(cfg, e.workspace_id, billingEvents(before, e))
  return outcome
}

export function mountEntitlementWebhook(
  app: Hono<IAppEnv>,
  deps: IEditionDeps,
): void {
  app.post('/api/v1/billing/entitlement', async (c) => {
    const secret = plansConfig()?.webhookSecret
    if (!secret) return c.json({ error: 'not found' }, 404)
    // The exact bytes licenses signed. There is no timestamp window: licenses
    // retries a delivery for a day with its first timestamp, and replaying an
    // old one cannot do harm because a lower version is ignored.
    const raw = await c.req.text()
    if (
      !(await signatureMatches(
        secret,
        raw,
        c.req.header('x-nubisco-signature'),
      ))
    )
      return c.json({ error: 'bad signature' }, 401)
    let delivery: z.infer<typeof zEntitlementDelivery>
    try {
      delivery = zEntitlementDelivery.parse(JSON.parse(raw))
    } catch {
      return c.json({ error: 'malformed delivery' }, 400)
    }
    if (delivery.data.app !== 'acta')
      return c.json({ error: 'not an Acta entitlement' }, 400)
    const outcome = await receive(
      deps,
      delivery.data as unknown as IEntitlement,
    )
    // 2xx either way: a workspace deleted here must not be retried for a day.
    return c.json({ ok: true, outcome })
  })
}

function ctxOf(c: {
  get: (k: 'db' | 'workspaceId' | 'actor') => unknown
}): ICtx {
  return {
    db: c.get('db') as ICtx['db'],
    workspaceId: c.get('workspaceId') as string,
    actor: c.get('actor') as ICtx['actor'],
  }
}

function requireAdmin(ctx: ICtx): void {
  if (!ctx.actor.scopes.includes('admin'))
    throw new ApiError(403, 'only workspace admins manage billing')
}

function configured() {
  const cfg = plansConfig()
  if (!cfg) throw new ApiError(404, 'billing is not set up on this instance')
  return cfg
}

/** licenses' refusals, in words a workspace admin can act on. */
function fromLicenses(err: unknown): never {
  if (err instanceof LicensesError) {
    if (err.code === 'trial_seat_change')
      throw new ApiError(409, TRIAL_SEAT_MESSAGE, {
        error: 'trial_seat_change',
      })
    if (err.code === 'conflict')
      throw new ApiError(
        409,
        'This workspace already has a subscription. Use Manage billing to change it.',
        { error: 'conflict' },
      )
    if (err.status === 400) throw new ApiError(400, err.message)
  }
  console.error('plans: licenses call failed', err)
  throw new ApiError(
    502,
    'Billing could not be reached just now. Try again in a minute.',
  )
}

const zCheckout = z.object({
  billing: z.enum(['monthly', 'yearly']),
  extra_members: z.number().int().min(0).max(40).default(0),
})

const zSeats = z.object({
  extra_members: z.number().int().min(0).max(40),
})

export function mountBillingRoutes(app: Hono<IAuthEnv>): void {
  /** The page: plan, state, usage against the caps, and checkout settings. */
  app.get('/billing', async (c) => {
    const ctx = ctxOf(c)
    requireAdmin(ctx)
    const cfg = configured()
    // Fetch on open, so someone back from checkout sees the new plan even
    // when the webhook is late.
    const row = await planFor(ctx.db, ctx.workspaceId, { force: true })
    const plan = row?.plan ?? 'free'
    const team = await planLimitsOf(ctx.db, 'team')
    return c.json(
      {
        plan,
        state: row?.state ?? 'free',
        source: row?.source ?? 'free',
        subscription: row?.subscription ?? null,
        limits: await planLimits(ctx.db, ctx.workspaceId),
        usage: await usageSummary(ctx.db, ctx.workspaceId),
        team: {
          members_included: team.members_included ?? 10,
          members_max: team.members_max ?? 50,
        },
        paddle: { env: cfg.paddleEnv, client_token: cfg.paddleClientToken },
        sales_url: cfg.salesUrl,
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  app.post('/billing/checkout', async (c) => {
    const ctx = ctxOf(c)
    requireAdmin(ctx)
    const cfg = configured()
    const body = zCheckout.parse(await c.req.json())
    const me = await ctx.db.query<{ platform_user_id: string | null }>(
      'SELECT platform_user_id FROM actor WHERE id = ?',
      [ctx.actor.id],
    )
    try {
      const res = await startCheckout(cfg, {
        workspace_id: ctx.workspaceId,
        billing: body.billing,
        extra_members: body.extra_members,
        ...(me[0]?.platform_user_id
          ? { owner_sub: me[0].platform_user_id }
          : {}),
      })
      return c.json({
        transaction_id: res.transaction_id,
        paddle: { env: cfg.paddleEnv, client_token: cfg.paddleClientToken },
      })
    } catch (err) {
      fromLicenses(err)
    }
  })

  app.post('/billing/portal', async (c) => {
    const ctx = ctxOf(c)
    requireAdmin(ctx)
    const cfg = configured()
    try {
      const res = await openPortal(cfg, ctx.workspaceId)
      return c.json({ url: res.url })
    } catch (err) {
      if (err instanceof LicensesError && err.status === 404)
        throw new ApiError(
          404,
          'This workspace has no subscription to manage yet.',
        )
      fromLicenses(err)
    }
  })

  app.post('/billing/seats', async (c) => {
    const ctx = ctxOf(c)
    requireAdmin(ctx)
    const cfg = configured()
    const body = zSeats.parse(await c.req.json())
    try {
      const res = await setSeats(cfg, ctx.workspaceId, body.extra_members)
      if (res.entitlement)
        await applyEntitlement(ctx.db, res.entitlement, Date.now())
      return c.json({
        ok: true,
        extra_members: res.extra_members,
        limits: await planLimits(ctx.db, ctx.workspaceId),
      })
    } catch (err) {
      fromLicenses(err)
    }
  })
}
