/**
 * The database size alert (LA-401).
 *
 * D1 caps one database at 10 GB and the cap cannot be raised. Every hosted
 * workspace lives in that one database, so reaching it would stop all of them
 * at once. Past `STORAGE_ALERT_BYTES` the admins of the instance's first
 * workspace, the one that runs it, are told through the bell and whatever
 * channel their notifications reach them by, at most once a day.
 *
 * Once a day comes from the op id, which carries the UTC date: the same
 * envelope every other write uses, so the event and the record that it was
 * sent commit together and a retried tick cannot send it twice.
 */

import type { ISqlDriver } from '../db'
import type { ICtx } from '../core/ctx'
import { now } from '../core/ctx'
import { emitEvent } from '../core/events'
import { withOp } from '../core/ops'

/** Half of D1's 10 GB: early enough to move workspaces out calmly. */
export const STORAGE_ALERT_BYTES = 5 * 1024 * 1024 * 1024

export interface IStorageAlertOptions {
  nowMs?: number
  /** The size to judge, for tests. Defaults to what the driver reports. */
  sizeBytes?: number | null
  thresholdBytes?: number
}

function gigabytes(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1)
}

/**
 * The workspace that runs this instance: the first one made, which is the
 * one bootstrap creates. Its admins are the operators.
 */
export async function operatorWorkspace(
  db: ISqlDriver,
): Promise<string | null> {
  const rows = await db.query<{ id: string }>(
    'SELECT id FROM workspace ORDER BY created_at, id LIMIT 1',
  )
  return rows[0]?.id ?? null
}

/** True when an alert was sent on this call. */
export async function storageAlert(
  db: ISqlDriver,
  opts: IStorageAlertOptions = {},
): Promise<boolean> {
  const size =
    opts.sizeBytes !== undefined
      ? opts.sizeBytes
      : ((await db.sizeBytes?.()) ?? null)
  const threshold = opts.thresholdBytes ?? STORAGE_ALERT_BYTES
  if (size === null || size < threshold) return false

  const workspaceId = await operatorWorkspace(db)
  if (!workspaceId) return false
  const system = (
    await db.query<{ id: string; handle: string }>(
      "SELECT id, handle FROM actor WHERE workspace_id = ? AND kind = 'system' LIMIT 1",
      [workspaceId],
    )
  )[0]
  if (!system) return false
  const admins = await db.query<{ id: string }>(
    `SELECT id FROM actor
      WHERE workspace_id = ? AND kind = 'human' AND role = 'admin' AND disabled = 0`,
    [workspaceId],
  )
  if (admins.length === 0) return false

  const day = new Date(opts.nowMs ?? now()).toISOString().slice(0, 10)
  const ctx: ICtx = {
    db,
    workspaceId,
    actor: {
      id: system.id,
      kind: 'system',
      handle: system.handle,
      role: 'member',
      scopes: ['read', 'write'],
    },
  }
  const opId = `storage-alert:${day}`
  const already = await db.query<{ op_id: string }>(
    'SELECT op_id FROM op_log WHERE workspace_id = ? AND op_id = ?',
    [workspaceId, opId],
  )
  if (already.length > 0) return false

  const out = await withOp(ctx, opId, async () => {
    await emitEvent(
      ctx,
      'instance.storage_high',
      'workspace',
      workspaceId,
      `The database is at ${gigabytes(size)} GB of D1's 10 GB limit. Move busy workspaces to their own database before it fills.`,
      { size_bytes: size, threshold_bytes: threshold },
      { to: admins.map((a) => ({ actorId: a.id, reason: 'involved' })) },
    )
    return { id: workspaceId }
  })
  return out.ok
}
