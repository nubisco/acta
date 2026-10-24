// Copyright (c) Nubisco, Lda. All Rights Reserved.
// Acta Enterprise Edition. See packages/ee/LICENSE.

/**
 * Calls to the licenses service (licenses/docs/billing.md). Acta never calls
 * Paddle and never holds a Paddle key: licenses starts the checkout, opens the
 * portal and changes seats, and pushes the result back as an entitlement.
 */

import type { IPlansConfig } from './config'

/** The entitlement exactly as licenses sends it. */
export interface IEntitlement {
  app: string
  workspace_id: string
  plan: string
  state: 'trialing' | 'active' | 'grace' | 'restricted' | 'free'
  source: 'subscription' | 'override' | 'free'
  limits: Record<string, number | null>
  subscription: {
    id: string
    status: string
    plan: string
    billing: 'monthly' | 'yearly' | null
    extra_members: number
    current_period_end: string | null
    ends_at: string | null
    grace_until: string | null
  } | null
  override: unknown
  version: number
  computed_at: string
}

/** A refusal from licenses, with its error code. */
export class LicensesError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const TIMEOUT_MS = 5_000

async function call<T>(
  cfg: IPlansConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await cfg.fetchImpl(`${cfg.licensesUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.serviceToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok)
    throw new LicensesError(
      res.status,
      typeof json.error === 'string' ? json.error : 'error',
      typeof json.message === 'string' ? json.message : `HTTP ${res.status}`,
    )
  return json as T
}

export function fetchEntitlement(
  cfg: IPlansConfig,
  workspaceId: string,
): Promise<IEntitlement> {
  return call(
    cfg,
    'GET',
    `/v1/entitlements/acta/${encodeURIComponent(workspaceId)}`,
  )
}

export function startCheckout(
  cfg: IPlansConfig,
  body: {
    workspace_id: string
    billing: 'monthly' | 'yearly'
    extra_members: number
    owner_sub?: string
  },
): Promise<{ transaction_id: string; checkout_url: string | null }> {
  return call(cfg, 'POST', '/v1/billing/checkout', {
    app: 'acta',
    plan: 'team',
    ...body,
  })
}

export function openPortal(
  cfg: IPlansConfig,
  workspaceId: string,
): Promise<{ url: string }> {
  return call(cfg, 'POST', '/v1/billing/portal', {
    app: 'acta',
    workspace_id: workspaceId,
  })
}

export function setSeats(
  cfg: IPlansConfig,
  workspaceId: string,
  extraMembers: number,
): Promise<{ ok: true; extra_members: number; entitlement?: IEntitlement }> {
  return call(cfg, 'POST', '/v1/billing/seats', {
    app: 'acta',
    workspace_id: workspaceId,
    extra_members: extraMembers,
  })
}
