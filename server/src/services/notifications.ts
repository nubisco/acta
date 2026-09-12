/**
 * Who needs telling, and about what.
 *
 * The rule is the one every tool of this kind converges on: you hear about
 * work you are part of. Being mentioned, being assigned, or having already
 * taken part makes a card yours; everything else is noise, and a bell that
 * rings for the whole workspace is a bell people turn off.
 *
 * Recipients are worked out at write time, not at read time. "Did this
 * concern me" depends on who was assigned and who had commented AT THAT
 * MOMENT, and a query run later sees only the world as it ended up.
 */
import { extractRefs, newId } from '@nubisco/acta-shared'
import { now, type ICtx } from '../core/ctx'
import type { IEvent } from '../core/events'

/** Why someone is being told. Narrower reasons win when several apply. */
export type TNotifyReason = 'mention' | 'assigned' | 'involved'

const REASON_RANK: Record<TNotifyReason, number> = {
  mention: 0,
  assigned: 1,
  involved: 2,
}

/**
 * Verbs worth a notification.
 *
 * Deliberately not every verb: a card you are on moving between lists three
 * times while someone grooms the backlog is not three things you need to
 * know. Comments, assignment, lifecycle and due dates are the ones people
 * act on.
 */
const NOTIFIABLE = new Set([
  'comment.created',
  'item.assigned',
  'item.created',
  'item.updated',
  'item.archived',
  'item.restored',
  'item.completed',
  'item.reopened',
  'item.moved',
  'doc.comment_created',
])

/** Handles named as `[[@handle]]` in a body, resolved to actors. */
async function mentioned(ctx: ICtx, body: string): Promise<string[]> {
  const handles = extractRefs(body)
    .filter((r) => r.type === 'actor')
    .map((r) => r.target.toLowerCase())
  if (handles.length === 0) return []
  const rows = await ctx.db.query<{ id: string }>(
    `SELECT id FROM actor
      WHERE workspace_id = ? AND disabled = 0
        AND lower(handle) IN (${handles.map(() => '?').join(',')})`,
    [ctx.workspaceId, ...handles],
  )
  return rows.map((r) => r.id)
}

/** Everyone already part of a card: assigned to it, or has commented on it. */
async function participants(
  ctx: ICtx,
  itemId: string,
): Promise<{ assigned: string[]; involved: string[] }> {
  const assigned = (
    await ctx.db.query<{ actor_id: string }>(
      'SELECT actor_id FROM item_assignee WHERE item_id = ?',
      [itemId],
    )
  ).map((r) => r.actor_id)
  const involved = (
    await ctx.db.query<{ actor_id: string }>(
      `SELECT DISTINCT c.actor_id FROM comment c
         JOIN actor a ON a.id = c.actor_id
        WHERE c.item_id = ? AND a.kind = 'human' AND a.disabled = 0`,
      [itemId],
    )
  ).map((r) => r.actor_id)
  return { assigned, involved }
}

/**
 * Record a notification per recipient for an event that has just happened.
 *
 * Never notifies the actor about their own action: being told what you just
 * did is the fastest way to teach someone to ignore the bell.
 */
export async function notifyForEvent(
  ctx: ICtx,
  event: IEvent,
  body?: string,
): Promise<number> {
  if (!NOTIFIABLE.has(event.verb)) return 0

  const found = new Map<string, TNotifyReason>()
  const add = (actorId: string, reason: TNotifyReason) => {
    if (actorId === ctx.actor.id) return
    const seen = found.get(actorId)
    if (seen === undefined || REASON_RANK[reason] < REASON_RANK[seen]) {
      found.set(actorId, reason)
    }
  }

  if (body) for (const id of await mentioned(ctx, body)) add(id, 'mention')

  let itemKey: string | null = null
  if (event.entity === 'item') {
    const row = (
      await ctx.db.query<{ id: string; key: string }>(
        'SELECT id, key FROM item WHERE id = ? OR key = ?',
        [event.entity_id, event.entity_id],
      )
    )[0]
    if (row) {
      itemKey = row.key
      const { assigned, involved } = await participants(ctx, row.id)
      for (const id of assigned) add(id, 'assigned')
      for (const id of involved) add(id, 'involved')
    }
  }

  if (found.size === 0) return 0

  const ts = now()
  for (const [actorId, reason] of found) {
    // OR IGNORE for the unique (actor, event): a retried op must not ring
    // twice for one thing happening once.
    await ctx.db.run(
      `INSERT OR IGNORE INTO notification
         (id, workspace_id, actor_id, event_id, reason, verb, summary, item_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId('ntf'),
        ctx.workspaceId,
        actorId,
        event.id,
        reason,
        event.verb,
        event.summary,
        itemKey,
        ts,
      ],
    )
  }
  return found.size
}

export interface INotificationRow {
  id: string
  reason: TNotifyReason
  verb: string
  summary: string
  item_key: string | null
  created_at: number
  read_at: number | null
}

export async function notificationList(
  ctx: ICtx,
  limit = 50,
): Promise<{ notifications: INotificationRow[]; unread: number }> {
  const notifications = await ctx.db.query<INotificationRow>(
    `SELECT id, reason, verb, summary, item_key, created_at, read_at
       FROM notification WHERE actor_id = ?
      -- id breaks the tie: two notifications from one write share a
      -- millisecond, and ordering by time alone leaves their order to the
      -- query planner. Ids are monotonic, so newest stays newest.
      ORDER BY created_at DESC, id DESC LIMIT ?`,
    [ctx.actor.id, limit],
  )
  const unread = (
    await ctx.db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM notification WHERE actor_id = ? AND read_at IS NULL',
      [ctx.actor.id],
    )
  )[0].n
  return { notifications, unread }
}

/** Marks one as read, or everything when no id is given. */
export async function notificationRead(
  ctx: ICtx,
  id?: string,
): Promise<{ ok: true }> {
  if (id) {
    await ctx.db.run(
      'UPDATE notification SET read_at = ? WHERE actor_id = ? AND id = ? AND read_at IS NULL',
      [now(), ctx.actor.id, id],
    )
  } else {
    await ctx.db.run(
      'UPDATE notification SET read_at = ? WHERE actor_id = ? AND read_at IS NULL',
      [now(), ctx.actor.id],
    )
  }
  return { ok: true }
}
