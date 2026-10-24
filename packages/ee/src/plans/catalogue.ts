// Copyright (c) Nubisco, Lda. All Rights Reserved.
// Acta Enterprise Edition. See packages/ee/LICENSE.

/**
 * The adopted Acta tiers (G-13, decided 2026-10-23).
 *
 * Billed limits (spaces, members, storage) come from the licenses service in
 * the entitlement, because Paddle is where they are sold. Everything else a
 * plan caps lives in the plan_limit table, seeded from PLAN_LIMIT_SEED, so it
 * can change without a catalogue edit.
 */

import type { ISqlDriver } from '../../../../server/src/db'

export const MB = 1024 * 1024
export const GB = 1024 * MB

/** What a workspace the licenses service has never seen is held to. */
export const FREE_BILLED = { spaces: 3, members: 5, storage_gb: 1 } as const

/** Rows of plan_limit: plan, resource, value (null is unlimited). */
export const PLAN_LIMIT_SEED: [string, string, number | null][] = [
  ['free', 'file_bytes', 10 * MB],
  ['free', 'agents', 2],
  ['free', 'rules', 10],
  ['free', 'webhooks', 3],
  ['free', 'items', 50_000],
  ['free', 'history_days', 90],
  ['team', 'file_bytes', 25 * MB],
  ['team', 'agents', 20],
  ['team', 'rules', 100],
  ['team', 'webhooks', 25],
  ['team', 'items', 50_000],
  ['team', 'history_days', 365],
  // Members on Team: 10 come with the plan, extra ones are bought up to 50.
  ['team', 'members_included', 10],
  ['team', 'members_max', 50],
  // A sales deal: limits come from the override, the rest is open, except
  // the anti-abuse cap every tier has.
  ['enterprise', 'file_bytes', 25 * MB],
  ['enterprise', 'agents', null],
  ['enterprise', 'rules', null],
  ['enterprise', 'webhooks', null],
  ['enterprise', 'items', 50_000],
  ['enterprise', 'history_days', null],
]

/** What Paddle charges, for the Purchase analytics event (USD list, ex VAT). */
export const LIST_PRICE_USD = {
  monthly: { base: 39, member: 4 },
  yearly: { base: 390, member: 40 },
} as const

/** Adds the adopted values. A value an operator changed is kept. */
export async function seedPlanLimits(db: ISqlDriver): Promise<void> {
  for (const [plan, resource, value] of PLAN_LIMIT_SEED) {
    await db.run(
      'INSERT OR IGNORE INTO plan_limit (plan, resource, value) VALUES (?, ?, ?)',
      [plan, resource, value],
    )
  }
}

/** One plan's plan_limit rows. A plan with none reads as Free's. */
export async function planLimitsOf(
  db: ISqlDriver,
  plan: string,
): Promise<Record<string, number | null>> {
  let rows = await db.query<{ resource: string; value: number | null }>(
    'SELECT resource, value FROM plan_limit WHERE plan = ?',
    [plan],
  )
  if (rows.length === 0 && plan !== 'free')
    rows = await db.query(
      'SELECT resource, value FROM plan_limit WHERE plan = ?',
      ['free'],
    )
  return Object.fromEntries(rows.map((r) => [r.resource, r.value]))
}
