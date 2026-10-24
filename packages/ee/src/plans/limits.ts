// Copyright (c) Nubisco, Lda. All Rights Reserved.
// Acta Enterprise Edition. See packages/ee/LICENSE.

/**
 * What a workspace may hold, from its cached plan (LA-399).
 *
 * - getLimits: the billed caps from the entitlement (no row means Free) plus
 *   the plan's other caps from plan_limit.
 * - raiseLimit: on Acta Team, the 11th member onwards buys one more member,
 *   billed at the next renewal, up to 50.
 * - writeBlock: after a downgrade nothing is deleted. Spaces and people over
 *   the caps become read-only instead: the oldest spaces stay writable, and
 *   the people an admin chose, then admins, then the earliest to join.
 * - historyDays and isFreePlan for retention and the inactivity job.
 */

import { ApiError } from '../../../../server/src/core/ctx'
import {
  PlanLimitError,
  UNLIMITED,
  type IWriteTarget,
  type TLimitedResource,
  type TPlanLimits,
} from '../../../../server/src/core/edition'
import type { ISqlDriver } from '../../../../server/src/db'
import { FREE_BILLED, GB, planLimitsOf, seedPlanLimits } from './catalogue'
import { LicensesError, setSeats } from './client'
import { plansConfig } from './config'
import { applyEntitlement, planFor, type IPlanRow } from './store'

const seeded = new WeakSet<ISqlDriver>()

async function ensureSeeded(db: ISqlDriver): Promise<void> {
  if (seeded.has(db)) return
  await seedPlanLimits(db)
  seeded.add(db)
}

/** States that keep the paid limits. */
const PAID_STATES = new Set(['trialing', 'active', 'grace'])

function billedOf(row: IPlanRow | null): Record<string, number | null> {
  return row ? row.limits : { ...FREE_BILLED }
}

export async function planLimits(
  db: ISqlDriver,
  workspaceId: string,
): Promise<TPlanLimits> {
  if (!plansConfig()) return { ...UNLIMITED }
  await ensureSeeded(db)
  const row = await planFor(db, workspaceId)
  const plan = row?.plan ?? 'free'
  const billed = billedOf(row)
  const rest = await planLimitsOf(db, plan)
  const num = (v: number | null | undefined) => (v === undefined ? null : v)
  const storageGb = num(billed.storage_gb)
  return {
    spaces: num(billed.spaces),
    members: num(billed.members),
    storage_bytes: storageGb === null ? null : storageGb * GB,
    file_bytes: num(rest.file_bytes),
    agents: num(rest.agents),
    rules: num(rest.rules),
    webhooks: num(rest.webhooks),
    items: num(rest.items),
  }
}

export async function isFreePlan(
  db: ISqlDriver,
  workspaceId: string,
): Promise<boolean> {
  // Without billing set up there are no plans, so nothing counts as Free.
  if (!plansConfig()) return false
  const row = await planFor(db, workspaceId)
  return (row?.plan ?? 'free') === 'free'
}

/** Days of history: 90 on Free, a year on Team, ten years where unlimited. */
export async function historyDays(
  db: ISqlDriver,
  workspaceId: string,
): Promise<number | null> {
  if (!plansConfig()) return null
  await ensureSeeded(db)
  const row = await planFor(db, workspaceId)
  const rest = await planLimitsOf(db, row?.plan ?? 'free')
  if (!('history_days' in rest)) return null
  return rest.history_days ?? 3650
}

/** Paddle's own words for this case are not for people: these are. */
export const TRIAL_SEAT_MESSAGE =
  'During the free trial the number of extra members can change, but extra members cannot be added for the first time. Add them when the trial ends, or choose them when you subscribe.'

/**
 * Buys members on Acta Team when one more is needed. With dryRun, only says
 * whether it could. Anything that is not a members cap on a paid Team
 * subscription below 50 answers false, and the caller refuses with 402.
 */
export async function raiseLimit(
  db: ISqlDriver,
  workspaceId: string,
  resource: TLimitedResource,
  needed: number,
  opts: { dryRun: boolean },
  nowMs = Date.now(),
): Promise<boolean> {
  const cfg = plansConfig()
  if (!cfg || resource !== 'members') return false
  await ensureSeeded(db)
  const row = await planFor(db, workspaceId)
  if (!row || row.source !== 'subscription' || !PAID_STATES.has(row.state))
    return false
  const rest = await planLimitsOf(db, row.plan)
  const included = rest.members_included
  const max = rest.members_max
  if (typeof included !== 'number' || typeof max !== 'number') return false
  if (needed > max) return false
  const sub = row.subscription
  const current = sub?.extra_members ?? 0
  const extra = Math.max(needed - included, current)
  if (extra === current) return true
  if (sub?.status === 'trialing' && current === 0)
    throw new ApiError(409, TRIAL_SEAT_MESSAGE, {
      error: 'trial_seat_change',
    })
  if (opts.dryRun) return true
  try {
    const res = await setSeats(cfg, workspaceId, extra)
    if (res.entitlement) await applyEntitlement(db, res.entitlement, nowMs)
    return true
  } catch (err) {
    if (err instanceof LicensesError && err.code === 'trial_seat_change')
      throw new ApiError(409, TRIAL_SEAT_MESSAGE, {
        error: 'trial_seat_change',
      })
    console.error('plans: could not add a member to the subscription', err)
    throw new ApiError(
      502,
      'The member could not be added to the subscription just now. Try again in a minute.',
    )
  }
}

/** Ids allowed to write when `limit` of the rows ordered by `order` are kept. */
async function keptIds(
  db: ISqlDriver,
  sql: string,
  workspaceId: string,
  limit: number,
): Promise<{ kept: Set<string>; total: number }> {
  const rows = await db.query<{ id: string }>(sql, [workspaceId])
  return {
    kept: new Set(rows.slice(0, limit).map((r) => r.id)),
    total: rows.length,
  }
}

export async function writeBlock(
  db: ISqlDriver,
  workspaceId: string,
  target: IWriteTarget,
): Promise<PlanLimitError | null> {
  if (!plansConfig()) return null
  const limits = await planLimits(db, workspaceId)
  if (target.spaceId && limits.spaces !== null) {
    const spaces = await keptIds(
      db,
      'SELECT id FROM space WHERE workspace_id = ? AND archived = 0 ORDER BY created_at, id',
      workspaceId,
      limits.spaces,
    )
    if (spaces.total > limits.spaces && !spaces.kept.has(target.spaceId))
      return new PlanLimitError('spaces', limits.spaces, spaces.total)
  }
  if (target.actorKind === 'human' && limits.members !== null) {
    const people = await keptIds(
      db,
      `SELECT id FROM actor
        WHERE workspace_id = ? AND kind = 'human' AND disabled = 0
        ORDER BY keeps_write DESC, role = 'admin' DESC, created_at, id`,
      workspaceId,
      limits.members,
    )
    if (people.total > limits.members && !people.kept.has(target.actorId))
      return new PlanLimitError('members', limits.members, people.total)
  }
  return null
}
