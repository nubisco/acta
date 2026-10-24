/**
 * Per-workspace daily email caps.
 *
 * On a shared instance every workspace sends from the same domain, so one
 * workspace mailing thousands of addresses would cost every other one its
 * deliverability. A cap per workspace per UTC day keeps that bounded whatever
 * a workspace's admins do. Counted in `email_quota`, one row per workspace,
 * day and kind, so the check is a single keyed upsert.
 */

import type { ISqlDriver } from '../db'

/** Invitation emails one workspace may send per UTC day. */
export const INVITE_EMAILS_PER_DAY = 20

/** Notification digests one workspace may send per UTC day. */
export const DIGEST_EMAILS_PER_DAY = 300

export type TEmailKind = 'invite' | 'digest'

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

/**
 * Count one email against today's cap and say whether it may go.
 *
 * Counted first and checked second, so two sends racing for the last slot
 * cannot both see room. A refused send still bumps the counter, which is
 * harmless: the day is already full.
 */
export async function takeEmailQuota(
  db: ISqlDriver,
  workspaceId: string,
  kind: TEmailKind,
  cap: number,
  ts: number = Date.now(),
): Promise<boolean> {
  const day = utcDay(ts)
  await db.run(
    `INSERT INTO email_quota (workspace_id, day, kind, count) VALUES (?, ?, ?, 1)
       ON CONFLICT (workspace_id, day, kind) DO UPDATE SET count = count + 1`,
    [workspaceId, day, kind],
  )
  const row = (
    await db.query<{ count: number }>(
      'SELECT count FROM email_quota WHERE workspace_id = ? AND day = ? AND kind = ?',
      [workspaceId, day, kind],
    )
  )[0]
  return (row?.count ?? 0) <= cap
}

/** Emails of a kind a workspace has left today. */
export async function emailQuotaLeft(
  db: ISqlDriver,
  workspaceId: string,
  kind: TEmailKind,
  cap: number,
  ts: number = Date.now(),
): Promise<number> {
  const row = (
    await db.query<{ count: number }>(
      'SELECT count FROM email_quota WHERE workspace_id = ? AND day = ? AND kind = ?',
      [workspaceId, utcDay(ts), kind],
    )
  )[0]
  return Math.max(0, cap - (row?.count ?? 0))
}
