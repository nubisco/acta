/**
 * Deleting a workspace, and erasing a person (LA-401).
 *
 * A workspace is deleted in two steps. An admin asks, typing the workspace's
 * address to confirm, and from then on it is read-only: everything can still
 * be opened and exported, nothing can be changed. Thirty days later the cron
 * purges it, every row and every stored file. Until then an admin can change
 * their mind. The workspace that runs the instance cannot be deleted at all,
 * because its admins are the ones told when the instance needs attention.
 *
 * A person is erased when the identity provider says their account is gone
 * (the `user.deleted` webhook). What they wrote stays, because it belongs to
 * the workspaces they wrote it in. Who they were does not: every actor bound
 * to that account becomes "Deleted user", loses its email, picture and
 * provider id, is disabled, and every credential it held is revoked.
 */

import type { ISqlDriver } from '../db'
import { ApiError, now, type ICtx } from '../core/ctx'
import { emitEvent, flushPendingEvents } from '../core/events'
import type { AttachmentStore } from './attachments'
import { deleteInBatches, type IBudget } from './retention'
import { operatorWorkspace } from './storageAlert'

export const GRACE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export interface IDeletionStatus {
  deleted_at: number
  purge_at: number
  deleted_by: string | null
}

export async function deletionStatus(
  db: ISqlDriver,
  workspaceId: string,
): Promise<IDeletionStatus | null> {
  const row = (
    await db.query<{
      deleted_at: number | null
      purge_at: number | null
      deleted_by: string | null
    }>('SELECT deleted_at, purge_at, deleted_by FROM workspace WHERE id = ?', [
      workspaceId,
    ])
  )[0]
  if (!row || row.deleted_at === null || row.purge_at === null) return null
  return {
    deleted_at: row.deleted_at,
    purge_at: row.purge_at,
    deleted_by: row.deleted_by,
  }
}

/** Ask for the workspace to be deleted. Admin only (checked by the route). */
export async function scheduleDeletion(
  ctx: ICtx,
  confirm: string,
  nowMs = now(),
): Promise<IDeletionStatus> {
  const ws = (
    await ctx.db.query<{ slug: string; deleted_at: number | null }>(
      'SELECT slug, deleted_at FROM workspace WHERE id = ?',
      [ctx.workspaceId],
    )
  )[0]
  if (!ws) throw new ApiError(404, 'workspace not found')
  if (confirm.trim() !== ws.slug)
    throw new ApiError(
      400,
      `type the workspace's address, ${ws.slug}, to confirm`,
    )
  if (ws.deleted_at !== null)
    throw new ApiError(409, 'this workspace is already scheduled for deletion')
  if ((await operatorWorkspace(ctx.db)) === ctx.workspaceId)
    throw new ApiError(
      409,
      'the workspace that runs this instance cannot be deleted',
    )
  const by = ctx.actor.onBehalfOf ?? ctx.actor.id
  const purgeAt = nowMs + GRACE_DAYS * DAY_MS
  await ctx.db.run(
    'UPDATE workspace SET deleted_at = ?, deleted_by = ?, purge_at = ? WHERE id = ?',
    [nowMs, by, purgeAt, ctx.workspaceId],
  )
  await emitEvent(
    ctx,
    'workspace.deletion_scheduled',
    'workspace',
    ctx.workspaceId,
    `scheduled this workspace for deletion on ${new Date(purgeAt).toISOString().slice(0, 10)}`,
    { purge_at: purgeAt },
  )
  flushPendingEvents()
  return { deleted_at: nowMs, purge_at: purgeAt, deleted_by: by }
}

export async function cancelDeletion(ctx: ICtx): Promise<void> {
  const status = await deletionStatus(ctx.db, ctx.workspaceId)
  if (!status)
    throw new ApiError(409, 'this workspace is not scheduled for deletion')
  await ctx.db.run(
    'UPDATE workspace SET deleted_at = NULL, deleted_by = NULL, purge_at = NULL WHERE id = ?',
    [ctx.workspaceId],
  )
  await emitEvent(
    ctx,
    'workspace.deletion_cancelled',
    'workspace',
    ctx.workspaceId,
    'cancelled the deletion of this workspace',
  )
  flushPendingEvents()
}

/**
 * The order rows leave in, children before what they point at. `?` is the
 * workspace id. A test checks every table in the schema is either here or
 * instance-wide, and a purge test runs with foreign keys enforced, so a table
 * added later cannot be forgotten or deleted out of order.
 */
export const PURGE_ORDER: [string, string][] = [
  [
    'notification',
    'SELECT rowid AS id FROM notification WHERE workspace_id = ?',
  ],
  [
    'goal_follower',
    'SELECT f.rowid AS id FROM goal_follower f JOIN goal g ON g.id = f.goal_id WHERE g.workspace_id = ?',
  ],
  ['goal_item', 'SELECT rowid AS id FROM goal_item WHERE workspace_id = ?'],
  ['goal_update', 'SELECT rowid AS id FROM goal_update WHERE workspace_id = ?'],
  [
    'item_dependency',
    'SELECT rowid AS id FROM item_dependency WHERE workspace_id = ?',
  ],
  [
    'item_key_alias',
    'SELECT rowid AS id FROM item_key_alias WHERE workspace_id = ?',
  ],
  [
    'external_link',
    'SELECT rowid AS id FROM external_link WHERE workspace_id = ?',
  ],
  [
    'item_label',
    'SELECT l.rowid AS id FROM item_label l JOIN item i ON i.id = l.item_id WHERE i.workspace_id = ?',
  ],
  [
    'item_assignee',
    'SELECT a.rowid AS id FROM item_assignee a JOIN item i ON i.id = a.item_id WHERE i.workspace_id = ?',
  ],
  [
    'checklist_item',
    'SELECT ci.rowid AS id FROM checklist_item ci JOIN checklist c ON c.id = ci.checklist_id WHERE c.workspace_id = ?',
  ],
  ['checklist', 'SELECT rowid AS id FROM checklist WHERE workspace_id = ?'],
  ['comment', 'SELECT rowid AS id FROM comment WHERE workspace_id = ?'],
  ['doc_comment', 'SELECT rowid AS id FROM doc_comment WHERE workspace_id = ?'],
  [
    'doc_version',
    'SELECT v.rowid AS id FROM doc_version v JOIN document d ON d.id = v.document_id WHERE d.workspace_id = ?',
  ],
  ['attachment', 'SELECT rowid AS id FROM attachment WHERE workspace_id = ?'],
  ['link', 'SELECT rowid AS id FROM link WHERE workspace_id = ?'],
  ['space_star', 'SELECT rowid AS id FROM space_star WHERE workspace_id = ?'],
  [
    'ingest_token',
    'SELECT rowid AS id FROM ingest_token WHERE workspace_id = ?',
  ],
  ['connection', 'SELECT rowid AS id FROM connection WHERE workspace_id = ?'],
  [
    'webhook_delivery',
    'SELECT d.rowid AS id FROM webhook_delivery d JOIN webhook w ON w.id = d.webhook_id WHERE w.workspace_id = ?',
  ],
  ['webhook', 'SELECT rowid AS id FROM webhook WHERE workspace_id = ?'],
  ['rule', 'SELECT rowid AS id FROM rule WHERE workspace_id = ?'],
  ['oauth_code', 'SELECT rowid AS id FROM oauth_code WHERE workspace_id = ?'],
  ['oauth_token', 'SELECT rowid AS id FROM oauth_token WHERE workspace_id = ?'],
  ['auth_token', 'SELECT rowid AS id FROM auth_token WHERE workspace_id = ?'],
  ['invitation', 'SELECT rowid AS id FROM invitation WHERE workspace_id = ?'],
  [
    'otp_challenge',
    'SELECT rowid AS id FROM otp_challenge WHERE workspace_id = ?',
  ],
  ['email_quota', 'SELECT rowid AS id FROM email_quota WHERE workspace_id = ?'],
  ['op_log', 'SELECT rowid AS id FROM op_log WHERE workspace_id = ?'],
  ['ai_settings', 'SELECT rowid AS id FROM ai_settings WHERE workspace_id = ?'],
  [
    'ai_usage_log',
    'SELECT rowid AS id FROM ai_usage_log WHERE workspace_id = ?',
  ],
  [
    'daily_report_run',
    'SELECT rowid AS id FROM daily_report_run WHERE workspace_id = ?',
  ],
  [
    'daily_report',
    'SELECT rowid AS id FROM daily_report WHERE workspace_id = ?',
  ],
  [
    'workspace_export',
    'SELECT rowid AS id FROM workspace_export WHERE workspace_id = ?',
  ],
  ['event', 'SELECT rowid AS id FROM event WHERE workspace_id = ?'],
  ['goal', 'SELECT rowid AS id FROM goal WHERE workspace_id = ?'],
  ['item', 'SELECT rowid AS id FROM item WHERE workspace_id = ?'],
  ['document', 'SELECT rowid AS id FROM document WHERE workspace_id = ?'],
  ['label', 'SELECT rowid AS id FROM label WHERE workspace_id = ?'],
  ['label_group', 'SELECT rowid AS id FROM label_group WHERE workspace_id = ?'],
  ['list', 'SELECT rowid AS id FROM list WHERE workspace_id = ?'],
  ['space', 'SELECT rowid AS id FROM space WHERE workspace_id = ?'],
  ['actor', 'SELECT rowid AS id FROM actor WHERE workspace_id = ?'],
]

/** Tables that belong to no workspace, and so are never purged. */
export const INSTANCE_TABLES = new Set([
  'schema_state',
  'instance_job',
  'ai_price_list',
  'link_preview',
  'oauth_client',
  'workspace',
  // A signup in progress belongs to a person, not yet to any workspace.
  'signup_intent',
])

/**
 * References inside a table to its own rows, cleared before the table is
 * deleted a batch at a time: a batch that removed a parent and left its child
 * for the next one would break the foreign key in between.
 */
const SELF_REFERENCES = [
  'UPDATE goal SET parent_id = NULL WHERE workspace_id = ? AND parent_id IS NOT NULL',
  'UPDATE item SET parent_id = NULL WHERE workspace_id = ? AND parent_id IS NOT NULL',
  'UPDATE document SET parent_id = NULL WHERE workspace_id = ? AND parent_id IS NOT NULL',
  'UPDATE actor SET on_behalf_of = NULL WHERE workspace_id = ? AND on_behalf_of IS NOT NULL',
]

/**
 * Remove everything one workspace holds. Resumable: whatever the budget did
 * not reach is still there for the next tick. True when nothing is left.
 */
export async function purgeWorkspace(
  db: ISqlDriver,
  store: AttachmentStore,
  workspaceId: string,
  budget: IBudget,
): Promise<boolean> {
  if (db.supportsFts) {
    // Every index row carries its workspace, so the purge takes exactly this
    // workspace's rows and never another's that shares a key or slug.
    const fts: [string, unknown[]][] = [
      ['SELECT rowid AS id FROM fts WHERE workspace_id = ?', [workspaceId]],
    ]
    for (const [select, params] of fts)
      if (!(await deleteInBatches(db, budget, 'fts', select, params)))
        return false
  }

  for (const statement of SELF_REFERENCES) {
    if (budget.left <= 0) return false
    await db.run(statement, [workspaceId])
    budget.left -= 1
  }

  for (const [table, select] of PURGE_ORDER) {
    // Stored files go with their rows: uploads, and the export zips.
    const before =
      table === 'attachment' || table === 'workspace_export'
        ? async (ids: string) => {
            const rows = await db.query<{ id: string; kind?: string }>(
              `SELECT id${table === 'attachment' ? ', kind' : ''} FROM ${table}
                WHERE rowid IN (SELECT value FROM json_each(?))`,
              [ids],
            )
            for (const r of rows)
              if (table !== 'attachment' || r.kind === 'file')
                await store.remove(r.id)
          }
        : undefined
    if (
      !(await deleteInBatches(db, budget, table, select, [workspaceId], before))
    )
      return false
  }
  if (budget.left <= 0) return false
  await db.run('DELETE FROM workspace WHERE id = ?', [workspaceId])
  budget.left -= 1
  return true
}

/** Purge every workspace whose thirty days are up. */
export async function purgeDueWorkspaces(
  db: ISqlDriver,
  store: AttachmentStore,
  budget: IBudget,
  nowMs = now(),
): Promise<number> {
  const due = await db.query<{ id: string }>(
    'SELECT id FROM workspace WHERE purge_at IS NOT NULL AND purge_at <= ? ORDER BY purge_at',
    [nowMs],
  )
  let purged = 0
  for (const ws of due) {
    if (!(await purgeWorkspace(db, store, ws.id, budget))) break
    console.log('workspace purged', ws.id)
    purged += 1
  }
  return purged
}

/**
 * Erase a person the identity provider has deleted, everywhere they are a
 * member. Returns how many actors were anonymised.
 */
export async function anonymiseAccount(
  db: ISqlDriver,
  platformUserId: string,
  nowMs = now(),
): Promise<number> {
  const actors = await db.query<{ id: string; email: string | null }>(
    `SELECT id, email FROM actor WHERE platform_user_id = ? AND kind = 'human'`,
    [platformUserId],
  )
  for (const actor of actors) {
    // Agents acting for this person stop with them.
    const agents = await db.query<{ id: string }>(
      'SELECT id FROM actor WHERE on_behalf_of = ?',
      [actor.id],
    )
    for (const id of [actor.id, ...agents.map((a) => a.id)]) {
      await db.run(
        'UPDATE auth_token SET revoked_at = ? WHERE actor_id = ? AND revoked_at IS NULL',
        [nowMs, id],
      )
      await db.run(
        'UPDATE oauth_token SET revoked_at = ? WHERE actor_id = ? AND revoked_at IS NULL',
        [nowMs, id],
      )
    }
    await db.run(
      "UPDATE actor SET disabled = 1, disabled_source = 'platform' WHERE on_behalf_of = ?",
      [actor.id],
    )
    // The handle has to stay unique in its workspace, and say nothing.
    await db.run(
      `UPDATE actor
          SET name = 'Deleted user', handle = ?, email = NULL, avatar_url = NULL,
              platform_user_id = NULL, disabled = 1, disabled_source = 'platform',
              email_confirmed_at = NULL, walkthroughs = NULL, home_layout = NULL
        WHERE id = ?`,
      [`deleted-${actor.id.slice(-10)}`, actor.id],
    )
    // Their inbox and their place on things are about them, not the work.
    await db.run('DELETE FROM notification WHERE actor_id = ?', [actor.id])
    await db.run('DELETE FROM space_star WHERE actor_id = ?', [actor.id])
    await db.run('DELETE FROM goal_follower WHERE actor_id = ?', [actor.id])
    await db.run('DELETE FROM item_assignee WHERE actor_id = ?', [actor.id])
    if (actor.email) {
      await db.run(
        'DELETE FROM invitation WHERE lower(email) = lower(?) AND accepted_at IS NULL',
        [actor.email],
      )
      await db.run('DELETE FROM otp_challenge WHERE lower(email) = lower(?)', [
        actor.email,
      ])
    }
  }
  return actors.length
}
