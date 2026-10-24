// Copyright (c) Nubisco, Lda. All Rights Reserved.
// Acta Enterprise Edition. See packages/ee/LICENSE.

/**
 * The Free inactivity ladder (CFO review 2.4, LA-398).
 *
 * A Free workspace nobody has opened for 180 days gets its admins an email.
 * Thirty days later, still unopened, it becomes read-only. Thirty days after
 * that it is scheduled for deletion through the ordinary path (LA-401), which
 * gives its admins another thirty days to export it or change their mind.
 * Opening the workspace in a browser at any point lifts the freeze and the
 * warning and starts the ladder again (core/auth.ts, notePersonSeen).
 *
 * Never applied to:
 * - a workspace on a paid plan. The plans module (LA-399) answers that, and
 *   until it exists every workspace counts as paid, so this job does nothing;
 * - the workspace that runs the instance;
 * - a workspace already suspended or scheduled for deletion.
 *
 * Each rung is spaced from the one before it, not only from the last visit,
 * so a workspace that was idle long before this job existed still gets the
 * whole ladder rather than a warning and a deletion in the same week. Every
 * step is logged and recorded as an event in the workspace.
 */

import { now, type ICtx } from '../../../../server/src/core/ctx'
import {
  escapeHtml,
  type TEmailSender,
} from '../../../../server/src/core/email'
import {
  emitEvent,
  flushPendingEvents,
} from '../../../../server/src/core/events'
import type { ISqlDriver } from '../../../../server/src/db'
import {
  jobDoneAt,
  markJobDone,
} from '../../../../server/src/services/retention'
import { operatorWorkspace } from '../../../../server/src/services/storageAlert'
import { scheduleDeletion } from '../../../../server/src/services/workspaceDeletion'
import type { TFreePlanCheck } from '../modules'

const DAY_MS = 24 * 60 * 60 * 1000
export const WARN_AFTER_DAYS = 180
export const FREEZE_AFTER_DAYS = 210
export const DELETE_AFTER_DAYS = 240
/** The gap between rungs, whenever the ladder started. */
const RUNG_DAYS = 30
const JOB = 'signup-inactivity'
/** Workspaces looked at per run. The rest wait for tomorrow. */
const BATCH = 50

export interface IInactivityDeps {
  db: ISqlDriver
  isFreePlan: TFreePlanCheck
  send?: TEmailSender
  baseUrl?: string
  nowMs?: number
  /** Run even if today's run already happened (tests). */
  force?: boolean
}

export type TInactivityAction = 'warned' | 'frozen' | 'deletion_scheduled'

interface ICandidate {
  id: string
  name: string
  slug: string
  idle_since: number
  inactivity_warned_at: number | null
  frozen_at: number | null
}

async function systemCtx(
  db: ISqlDriver,
  workspaceId: string,
): Promise<ICtx | null> {
  const system = (
    await db.query<{ id: string; handle: string }>(
      "SELECT id, handle FROM actor WHERE workspace_id = ? AND kind = 'system' LIMIT 1",
      [workspaceId],
    )
  )[0]
  if (!system) return null
  return {
    db,
    workspaceId,
    actor: {
      id: system.id,
      kind: 'system',
      handle: system.handle,
      role: 'admin',
      scopes: ['read', 'write', 'admin'],
    },
  }
}

async function adminEmails(
  db: ISqlDriver,
  workspaceId: string,
): Promise<string[]> {
  const rows = await db.query<{ email: string }>(
    `SELECT email FROM actor
      WHERE workspace_id = ? AND kind = 'human' AND role = 'admin'
        AND disabled = 0 AND email IS NOT NULL AND email_confirmed_at IS NOT NULL`,
    [workspaceId],
  )
  return rows.map((r) => r.email)
}

function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** The two emails, warning and read-only, in the house template. */
export function inactivityEmail(opts: {
  workspace: string
  url: string
  step: 'warned' | 'frozen'
  nextDate: string
}): { subject: string; html: string; text: string } {
  const subject =
    opts.step === 'warned'
      ? `${opts.workspace} on Acta has not been opened in six months`
      : `${opts.workspace} on Acta is now read-only`
  const lines =
    opts.step === 'warned'
      ? [
          `Nobody has opened ${opts.workspace} in six months. Free workspaces that stay unused are made read-only, then deleted.`,
          `If nobody opens it, it becomes read-only on ${opts.nextDate}. Opening it once is enough to keep it.`,
        ]
      : [
          `${opts.workspace} has not been opened in seven months, so it is now read-only. Nothing in it has been deleted.`,
          `If nobody opens it, it will be scheduled for deletion on ${opts.nextDate}, with thirty more days to export it. Opening it once makes it writable again.`,
        ]
  const html = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /></head>
  <body style="margin:0;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;">
      <tr>
        <td style="background:#1a1a1a;padding:24px 32px;border-radius:8px 8px 0 0;">
          <span style="color:#fff;font-size:18px;font-weight:700;letter-spacing:-0.3px;">${escapeHtml(opts.workspace)}</span>
        </td>
      </tr>
      <tr>
        <td style="background:#fff;padding:24px 32px 0;">
          ${lines
            .map(
              (l) =>
                `<p style="margin:0 0 12px;font-size:15px;color:#555;line-height:1.6;">${escapeHtml(l)}</p>`,
            )
            .join('\n          ')}
        </td>
      </tr>
      <tr>
        <td style="background:#fff;padding:12px 32px 32px;">
          <a href="${escapeHtml(opts.url)}"
             style="display:inline-block;background:#5b4fe0;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600;">
            Open ${escapeHtml(opts.workspace)}
          </a>
        </td>
      </tr>
      <tr>
        <td style="background:#f7f6f5;padding:16px 32px;border-radius:0 0 8px 8px;border-top:1px solid #e8e7e6;">
          <p style="margin:0;font-size:12px;color:#999;">
            You get this because you are an admin of this workspace. Paid workspaces are never deleted for being idle.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`
  const text = [
    ...lines,
    '',
    `Open it: ${opts.url}`,
    '',
    'You get this because you are an admin of this workspace. Paid workspaces are never deleted for being idle.',
  ].join('\n')
  return { subject, html, text }
}

async function tell(
  deps: IInactivityDeps,
  ws: ICandidate,
  step: 'warned' | 'frozen',
  nextDate: string,
): Promise<void> {
  if (!deps.send) return
  const url = deps.baseUrl
    ? `${deps.baseUrl.replace(/\/$/, '')}/${ws.slug}`
    : `/${ws.slug}`
  const message = inactivityEmail({
    workspace: ws.name,
    url,
    step,
    nextDate,
  })
  for (const to of await adminEmails(deps.db, ws.id)) {
    try {
      await deps.send({ to, ...message })
    } catch (err) {
      console.error(`inactivity: email to an admin of ${ws.slug} failed`, err)
    }
  }
}

/** One rung for one workspace, or nothing. */
async function climb(
  deps: IInactivityDeps,
  ws: ICandidate,
  at: number,
): Promise<TInactivityAction | null> {
  const idleDays = (at - ws.idle_since) / DAY_MS
  const ctx = await systemCtx(deps.db, ws.id)
  if (!ctx) return null

  if (ws.inactivity_warned_at === null) {
    if (idleDays < WARN_AFTER_DAYS) return null
    await deps.db.run(
      'UPDATE workspace SET inactivity_warned_at = ? WHERE id = ?',
      [at, ws.id],
    )
    await emitEvent(
      ctx,
      'workspace.inactivity_warned',
      'workspace',
      ws.id,
      `warned the admins: not opened in ${Math.floor(idleDays)} days`,
    )
    await tell(deps, ws, 'warned', dateOf(at + RUNG_DAYS * DAY_MS))
    return 'warned'
  }

  if (ws.frozen_at === null) {
    if (idleDays < FREEZE_AFTER_DAYS) return null
    if (at - ws.inactivity_warned_at < RUNG_DAYS * DAY_MS) return null
    await deps.db.run('UPDATE workspace SET frozen_at = ? WHERE id = ?', [
      at,
      ws.id,
    ])
    await emitEvent(
      ctx,
      'workspace.frozen',
      'workspace',
      ws.id,
      `made read-only: not opened in ${Math.floor(idleDays)} days`,
    )
    await tell(deps, ws, 'frozen', dateOf(at + RUNG_DAYS * DAY_MS))
    return 'frozen'
  }

  if (idleDays < DELETE_AFTER_DAYS) return null
  if (at - ws.frozen_at < RUNG_DAYS * DAY_MS) return null
  // The ordinary deletion: thirty more days, export and cancel still open,
  // and the instance's own workspace refused there too.
  await scheduleDeletion(ctx, ws.slug, at)
  return 'deletion_scheduled'
}

/** Once a day. Returns what it did, for the log and for tests. */
export async function inactivitySweep(
  deps: IInactivityDeps,
): Promise<{ id: string; action: TInactivityAction }[]> {
  const at = deps.nowMs ?? now()
  if (!deps.force && at - (await jobDoneAt(deps.db, JOB)) < DAY_MS) return []
  const operator = await operatorWorkspace(deps.db)
  const candidates = await deps.db.query<ICandidate>(
    `SELECT id, name, slug, COALESCE(last_seen_at, created_at) AS idle_since,
            inactivity_warned_at, frozen_at
       FROM workspace
      WHERE COALESCE(last_seen_at, created_at) < ?
        AND deleted_at IS NULL AND suspended_at IS NULL AND id != ?
      ORDER BY COALESCE(last_seen_at, created_at)
      LIMIT ?`,
    [at - WARN_AFTER_DAYS * DAY_MS, operator ?? '', BATCH],
  )
  const done: { id: string; action: TInactivityAction }[] = []
  for (const ws of candidates) {
    try {
      if (!(await deps.isFreePlan(deps.db, ws.id))) continue
      const action = await climb(deps, ws, at)
      if (action) {
        done.push({ id: ws.id, action })
        console.log(`inactivity: ${ws.slug} ${action}`)
      }
    } catch (err) {
      console.error(`inactivity: ${ws.slug} failed`, err)
    }
  }
  flushPendingEvents()
  await markJobDone(deps.db, JOB, at)
  return done
}
