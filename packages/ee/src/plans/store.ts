// Copyright (c) Nubisco, Lda. All Rights Reserved.
// Acta Enterprise Edition. See packages/ee/LICENSE.

/**
 * The local copy of each workspace's entitlement (workspace_plan).
 *
 * Limit checks read only this. It is kept fresh three ways: the signed
 * webhook pushes every change, a missing or day-old row is fetched on use,
 * and the billing page fetches when it opens. A newer version always wins and
 * an older one is ignored. A network error never drops a workspace to Free:
 * the row it had stays.
 */

import type { ISqlDriver } from '../../../../server/src/db'
import { plansConfig } from './config'
import { fetchEntitlement, type IEntitlement } from './client'

export const STALE_MS = 24 * 60 * 60 * 1000

export interface IPlanRow {
  plan: string
  state: IEntitlement['state']
  source: IEntitlement['source']
  limits: Record<string, number | null>
  subscription: IEntitlement['subscription']
  version: number
  fetched_at: number
}

export async function cachedPlan(
  db: ISqlDriver,
  workspaceId: string,
): Promise<IPlanRow | null> {
  const rows = await db.query<{
    plan: string
    state: IEntitlement['state']
    source: IEntitlement['source']
    limits: string
    subscription: string | null
    version: number
    fetched_at: number
  }>(
    'SELECT plan, state, source, limits, subscription, version, fetched_at FROM workspace_plan WHERE workspace_id = ?',
    [workspaceId],
  )
  const r = rows[0]
  if (!r) return null
  return {
    ...r,
    limits: JSON.parse(r.limits) as Record<string, number | null>,
    subscription: r.subscription
      ? (JSON.parse(r.subscription) as IEntitlement['subscription'])
      : null,
  }
}

export type TApplyOutcome = 'applied' | 'stale' | 'unknown_workspace'

/**
 * Stores an entitlement unless the copy held is newer. An equal version only
 * refreshes fetched_at, so a fetch still counts as fresh. Answers what it did
 * and the row held before, for whoever reacts to a change.
 */
export async function applyEntitlement(
  db: ISqlDriver,
  e: IEntitlement,
  nowMs: number,
): Promise<{ outcome: TApplyOutcome; before: IPlanRow | null }> {
  const ws = await db.query('SELECT id FROM workspace WHERE id = ?', [
    e.workspace_id,
  ])
  if (ws.length === 0) return { outcome: 'unknown_workspace', before: null }
  const before = await cachedPlan(db, e.workspace_id)
  if (before && e.version < before.version) return { outcome: 'stale', before }
  if (before && e.version === before.version) {
    await db.run(
      'UPDATE workspace_plan SET fetched_at = ? WHERE workspace_id = ?',
      [nowMs, e.workspace_id],
    )
    return { outcome: 'stale', before }
  }
  await db.run(
    `INSERT INTO workspace_plan
       (workspace_id, plan, state, source, limits, subscription, version, grace_until, ends_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id) DO UPDATE SET
       plan = excluded.plan, state = excluded.state, source = excluded.source,
       limits = excluded.limits, subscription = excluded.subscription,
       version = excluded.version, grace_until = excluded.grace_until,
       ends_at = excluded.ends_at, fetched_at = excluded.fetched_at`,
    [
      e.workspace_id,
      e.plan,
      e.state,
      e.source,
      JSON.stringify(e.limits ?? {}),
      e.subscription ? JSON.stringify(e.subscription) : null,
      e.version,
      e.subscription?.grace_until ?? null,
      e.subscription?.ends_at ?? null,
      nowMs,
    ],
  )
  return { outcome: 'applied', before }
}

/**
 * The workspace's plan for a limit check: the cached row, refreshed from
 * licenses when missing, day-old or `force`d. Null means Free (no row and
 * licenses could not be asked). Errors are swallowed on purpose.
 */
export async function planFor(
  db: ISqlDriver,
  workspaceId: string,
  opts: { force?: boolean; nowMs?: number } = {},
): Promise<IPlanRow | null> {
  const cfg = plansConfig()
  const nowMs = opts.nowMs ?? Date.now()
  const held = await cachedPlan(db, workspaceId)
  const fresh = held && nowMs - held.fetched_at < STALE_MS
  if (!cfg || (fresh && !opts.force)) return held
  try {
    const e = await fetchEntitlement(cfg, workspaceId)
    await applyEntitlement(db, e, nowMs)
    return await cachedPlan(db, workspaceId)
  } catch (err) {
    console.error(
      `plans: could not refresh the entitlement of ${workspaceId}, keeping what is held`,
      err instanceof Error ? err.message : err,
    )
    return held
  }
}
