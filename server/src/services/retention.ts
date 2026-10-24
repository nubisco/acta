/**
 * Retention (LA-401): what the cron deletes so one shared database does not
 * grow without end.
 *
 * Every hosted workspace shares one D1 database with a hard size cap that
 * cannot be raised, and until this nothing was ever deleted from it: every
 * event, every idempotency record, every webhook delivery, every saved
 * version of every page. Reaching the cap fails every workspace at once.
 *
 * What goes, and why it is safe:
 *
 * - Activity (`event`) older than the workspace's history window, with the
 *   notifications that point at those events. The window is a plan fact, so
 *   it comes from `retentionDaysFor`, which the plans card drives.
 * - Idempotency records (`op_log`) after 30 days. A client retries within
 *   seconds, not months. The due-date reminders are the exception: their op id
 *   is what stops an overdue card being announced again on every tick, so
 *   those stay for as long as the card does.
 * - Webhook deliveries after 30 days, and notifications 30 days after they
 *   were read.
 * - AI usage and daily report runs after 400 days, a year and a month.
 * - Saved page versions beyond the last 20, except the last one of each day,
 *   so a page's history thins out with age rather than being cut off.
 *
 * Deletes go in batches of rowids, at most `BATCH` at a time, and a tick has a
 * statement budget. A sweep that runs out of budget does not mark itself done,
 * so the next tick carries on where it stopped.
 */

import { ulid } from '@nubisco/acta-shared'
import type { ISqlDriver } from '../db'
import { now } from '../core/ctx'

/** Rows per delete. Small enough that no single statement runs long on D1. */
export const BATCH = 500

const DAY_MS = 24 * 60 * 60 * 1000

/** How often the daily jobs run. A little under a day, so they do not drift. */
const DAILY_MS = 20 * 60 * 60 * 1000

/** Page versions always kept, newest first, before thinning to one a day. */
export const KEEP_DOC_VERSIONS = 20

export const OP_LOG_DAYS = 30
export const WEBHOOK_DELIVERY_DAYS = 30
export const READ_NOTIFICATION_DAYS = 30
export const USAGE_DAYS = 400

/** The default history window, and the Free plan's (CFO review 2.4). */
export const DEFAULT_HISTORY_DAYS = 90

/**
 * How many days of activity a workspace keeps.
 *
 * One function so the plans card (LA-399) has one place to answer from: Free
 * keeps 90 days and Team a year. Until plans exist every workspace gets the
 * default, which is the Free window.
 */
export function retentionDaysFor(
  _db: ISqlDriver,
  _workspaceId: string,
): Promise<number> {
  return Promise.resolve(DEFAULT_HISTORY_DAYS)
}

/** Statements a tick may still spend, shared by everything the cron runs. */
export interface IBudget {
  left: number
}

/**
 * Delete what `select` finds, a batch at a time, until it finds nothing or the
 * budget runs out. `select` must return the rowids as `id`. `before` runs for
 * each batch ahead of the delete, for the rows that point at these.
 *
 * True when everything matching is gone.
 */
export async function deleteInBatches(
  db: ISqlDriver,
  budget: IBudget,
  table: string,
  select: string,
  params: unknown[],
  before?: (idsJson: string) => Promise<void>,
): Promise<boolean> {
  while (budget.left > 0) {
    const rows = await db.query<{ id: number }>(
      `${select} LIMIT ${BATCH}`,
      params,
    )
    budget.left -= 1
    if (rows.length === 0) return true
    // One JSON parameter rather than a placeholder per row: D1 allows 100
    // bound parameters a statement, and a batch is five times that.
    const ids = JSON.stringify(rows.map((r) => r.id))
    if (before) {
      await before(ids)
      budget.left -= 1
    }
    await db.run(
      `DELETE FROM ${table} WHERE rowid IN (SELECT value FROM json_each(?))`,
      [ids],
    )
    budget.left -= 1
    if (rows.length < BATCH) return true
  }
  return false
}

/** When a daily instance job last finished, or 0. */
export async function jobDoneAt(db: ISqlDriver, name: string): Promise<number> {
  const rows = await db.query<{ done_at: number }>(
    'SELECT done_at FROM instance_job WHERE name = ?',
    [name],
  )
  return rows[0]?.done_at ?? 0
}

export async function markJobDone(
  db: ISqlDriver,
  name: string,
  at: number,
): Promise<void> {
  await db.run(
    `INSERT INTO instance_job (name, done_at) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET done_at = excluded.done_at`,
    [name, at],
  )
}

export interface IRetentionOptions {
  /** Overridable in tests. */
  nowMs?: number
  /** Run even if the daily run already happened (tests). */
  force?: boolean
  budget?: IBudget
}

export interface IRetentionResult {
  ran: boolean
  /** False when the budget ran out first. The next tick carries on. */
  finished: boolean
}

/** The daily retention run. Cheap on the ticks where it is not due. */
export async function retentionSweep(
  db: ISqlDriver,
  opts: IRetentionOptions = {},
): Promise<IRetentionResult> {
  const ts = opts.nowMs ?? now()
  if (!opts.force && ts - (await jobDoneAt(db, 'retention')) < DAILY_MS)
    return { ran: false, finished: true }
  const budget = opts.budget ?? { left: 300 }

  const workspaces = await db.query<{ id: string }>(
    'SELECT id FROM workspace ORDER BY created_at',
  )
  for (const ws of workspaces) {
    const cutoff = ts - (await retentionDaysFor(db, ws.id)) * DAY_MS
    const done = await deleteInBatches(
      db,
      budget,
      'event',
      // Event ids are ULIDs, which begin with their creation time, so a
      // bound on the id is a range on idx_event_ws. The ts check keeps it
      // honest for any event whose id and time disagree.
      'SELECT rowid AS id FROM event WHERE workspace_id = ? AND id < ? AND ts < ?',
      [ws.id, `evt_${ulid(cutoff).slice(0, 10)}`, cutoff],
      // notification.event_id references the event, so the notifications
      // about these go first.
      (ids) =>
        db.run(
          `DELETE FROM notification WHERE event_id IN
             (SELECT id FROM event WHERE rowid IN (SELECT value FROM json_each(?)))`,
          [ids],
        ),
    )
    if (!done) return { ran: true, finished: false }
  }

  const steps: [string, string, unknown[]][] = [
    [
      'op_log',
      `SELECT rowid AS id FROM op_log WHERE created_at < ? AND op_id NOT LIKE 'due:%'`,
      [ts - OP_LOG_DAYS * DAY_MS],
    ],
    [
      // A due-date record outlives the window, but not the card it is about.
      'op_log',
      `SELECT o.rowid AS id FROM op_log o
        WHERE o.op_id LIKE 'due:%' AND o.created_at < ?
          AND NOT EXISTS (SELECT 1 FROM item i
                           WHERE i.id = substr(o.op_id, 5, instr(substr(o.op_id, 5), ':') - 1))`,
      [ts - OP_LOG_DAYS * DAY_MS],
    ],
    [
      'webhook_delivery',
      'SELECT rowid AS id FROM webhook_delivery WHERE created_at < ?',
      [ts - WEBHOOK_DELIVERY_DAYS * DAY_MS],
    ],
    [
      'notification',
      'SELECT rowid AS id FROM notification WHERE read_at IS NOT NULL AND read_at < ?',
      [ts - READ_NOTIFICATION_DAYS * DAY_MS],
    ],
    [
      'ai_usage_log',
      'SELECT rowid AS id FROM ai_usage_log WHERE created_at < ?',
      [ts - USAGE_DAYS * DAY_MS],
    ],
    [
      'daily_report_run',
      'SELECT rowid AS id FROM daily_report_run WHERE created_at < ?',
      [ts - USAGE_DAYS * DAY_MS],
    ],
    [
      // Codes live fifteen minutes. A day is generous.
      'otp_challenge',
      'SELECT rowid AS id FROM otp_challenge WHERE expires_at < ?',
      [ts - DAY_MS],
    ],
    [
      // The newest KEEP_DOC_VERSIONS of each page stay, and of the older ones
      // the last of each day.
      'doc_version',
      `SELECT rid AS id FROM (
         SELECT v.rowid AS rid,
                ROW_NUMBER() OVER (PARTITION BY v.document_id ORDER BY v.rev DESC) AS rn,
                ROW_NUMBER() OVER (PARTITION BY v.document_id, v.created_at / ${DAY_MS}
                                   ORDER BY v.rev DESC) AS day_rn
           FROM doc_version v)
        WHERE rn > ? AND day_rn > 1`,
      [KEEP_DOC_VERSIONS],
    ],
  ]
  for (const [table, select, params] of steps) {
    if (!(await deleteInBatches(db, budget, table, select, params)))
      return { ran: true, finished: false }
  }

  await markJobDone(db, 'retention', ts)
  return { ran: true, finished: true }
}
