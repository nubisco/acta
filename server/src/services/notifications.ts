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
 *
 * A notification also carries a deadline. `remind_at` is when it stops being
 * only a bell and becomes something that chases the person: an email today,
 * a Slack message later. That timestamp is stamped here, from the recipient's
 * own setting, and `notificationSweep` is what acts on it.
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
 * What a write can say about who it concerns, beyond who happens to be on
 * the card already.
 *
 * `body` is the text that was just typed, so mentions in it can be found.
 * `to` names people the event is about by identity rather than by
 * involvement: the person just assigned, the person just unassigned, the
 * author of a comment somebody else resolved. Involvement cannot express any
 * of those, and the unassigned case proves it, because by the time the event
 * is emitted they are no longer on the card at all.
 */
export interface INotifyHints {
  body?: string
  to?: Array<{ actorId: string; reason: TNotifyReason }>
}

/**
 * Verbs worth a notification.
 *
 * Deliberately not every verb: a card you are on moving between lists three
 * times while someone grooms the backlog is not three things you need to
 * know. What is here is what people act on, plus the two dependency verbs,
 * because "you are unblocked, you can start" is the most actionable sentence
 * this product can say to anyone.
 */
const NOTIFIABLE = new Set([
  'comment.created',
  'comment.updated',
  'comment.resolved',
  'item.assigned',
  'item.unassigned',
  'item.created',
  'item.updated',
  'item.archived',
  'item.restored',
  'item.completed',
  'item.reopened',
  'item.moved',
  'item.blocked',
  'item.unblocked',
  'item.due_soon',
  'item.overdue',
  'doc.created',
  'doc.updated',
  'member.updated',
])

/**
 * Verbs where taking part in the thing is reason enough to hear about it.
 *
 * Everything else notifies on being named only. The distinction is what
 * keeps documents usable: a mention inside a page must reach you, and a page
 * you once commented on being saved for the ninth time this morning must
 * not. Items are more forgiving because a card is a small, bounded thing
 * with a handful of people on it.
 */
/*
 * Due dates are deliberately not here. A date is the problem of whoever is
 * holding the card, and telling everyone who once commented on it that
 * somebody else's work is late is the kind of message people learn to skip.
 * The sweep names the assignees instead.
 */
const PARTICIPANT_VERBS = new Set([
  'comment.created',
  'item.assigned',
  'item.created',
  'item.updated',
  'item.archived',
  'item.restored',
  'item.completed',
  'item.reopened',
  'item.moved',
  'item.blocked',
  'item.unblocked',
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

/**
 * The mentions that are new in this text, as a body a notifier can scan.
 *
 * Editing a description must not ring for everyone named in it every time.
 * Only handles that were not there before are worth telling, so the diff is
 * taken here and the result handed on as if it were freshly written text.
 */
export function newMentions(before: string, after: string): string {
  const had = new Set(
    extractRefs(before)
      .filter((r) => r.type === 'actor')
      .map((r) => r.target.toLowerCase()),
  )
  return extractRefs(after)
    .filter((r) => r.type === 'actor')
    .filter((r) => !had.has(r.target.toLowerCase()))
    .map((r) => `[[@${r.target}]]`)
    .join(' ')
}

/** Everyone already part of a card: assigned to it, or has commented on it. */
async function itemParticipants(
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
 * Everyone already part of a conversation on a page.
 *
 * Commenters only, not everyone who has ever edited it. A document with a
 * long revision history would otherwise notify half the workspace every time
 * somebody replied to a thread, and having typed in a page once is a much
 * weaker claim on your attention than having said something in it.
 */
async function docParticipants(
  ctx: ICtx,
  documentId: string,
): Promise<string[]> {
  const rows = await ctx.db.query<{ actor_id: string }>(
    `SELECT DISTINCT c.actor_id FROM doc_comment c
       JOIN actor a ON a.id = c.actor_id
      WHERE c.document_id = ? AND a.kind = 'human' AND a.disabled = 0`,
    [documentId],
  )
  return rows.map((r) => r.actor_id)
}

/** How long each of these people lets an unread notification sit. */
async function reminderDelays(
  ctx: ICtx,
  actorIds: string[],
): Promise<Map<string, number>> {
  if (actorIds.length === 0) return new Map()
  const rows = await ctx.db.query<{
    id: string
    kind: string
    email: string | null
    notify_after_seconds: number | null
  }>(
    `SELECT id, kind, email, notify_after_seconds FROM actor
      WHERE id IN (${actorIds.map(() => '?').join(',')})`,
    actorIds,
  )
  const out = new Map<string, number>()
  for (const row of rows) {
    // Nobody to reach. An agent has no inbox and a person with no address on
    // file cannot be emailed, so the bell is the whole story for them and
    // stamping a deadline would only give the sweep rows it can never clear.
    if (row.kind !== 'human' || !row.email) continue
    const seconds = row.notify_after_seconds ?? 0
    if (seconds > 0) out.set(row.id, seconds * 1000)
  }
  return out
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
  hints?: string | INotifyHints,
): Promise<number> {
  if (!NOTIFIABLE.has(event.verb)) return 0
  const notify: INotifyHints =
    typeof hints === 'string' ? { body: hints } : (hints ?? {})

  const found = new Map<string, TNotifyReason>()
  const add = (actorId: string, reason: TNotifyReason) => {
    if (actorId === ctx.actor.id) return
    const seen = found.get(actorId)
    if (seen === undefined || REASON_RANK[reason] < REASON_RANK[seen]) {
      found.set(actorId, reason)
    }
  }

  if (notify.body)
    for (const id of await mentioned(ctx, notify.body)) add(id, 'mention')
  for (const one of notify.to ?? []) add(one.actorId, one.reason)

  let itemKey: string | null = null
  let docSlug: string | null = null
  const wantsParticipants = PARTICIPANT_VERBS.has(event.verb)

  if (event.entity === 'item') {
    const row = (
      await ctx.db.query<{ id: string; key: string }>(
        'SELECT id, key FROM item WHERE id = ? OR key = ?',
        [event.entity_id, event.entity_id],
      )
    )[0]
    if (row) {
      itemKey = row.key
      if (wantsParticipants) {
        const { assigned, involved } = await itemParticipants(ctx, row.id)
        for (const id of assigned) add(id, 'assigned')
        for (const id of involved) add(id, 'involved')
      }
    }
  } else if (event.entity === 'doc') {
    const row = (
      await ctx.db.query<{ id: string; slug: string }>(
        'SELECT id, slug FROM document WHERE id = ? OR slug = ?',
        [event.entity_id, event.entity_id],
      )
    )[0]
    if (row) {
      docSlug = row.slug
      if (wantsParticipants) {
        for (const id of await docParticipants(ctx, row.id)) add(id, 'involved')
      }
    }
  }

  if (found.size === 0) return 0

  const ts = now()
  const delays = await reminderDelays(ctx, [...found.keys()])
  for (const [actorId, reason] of found) {
    const delay = delays.get(actorId)
    // OR IGNORE for the unique (actor, event): a retried op must not ring
    // twice for one thing happening once.
    await ctx.db.run(
      `INSERT OR IGNORE INTO notification
         (id, workspace_id, actor_id, event_id, reason, verb, summary, item_key, doc_slug, created_at, remind_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId('ntf'),
        ctx.workspaceId,
        actorId,
        event.id,
        reason,
        event.verb,
        event.summary,
        itemKey,
        docSlug,
        ts,
        delay === undefined ? null : ts + delay,
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
  doc_slug: string | null
  created_at: number
  read_at: number | null
  /** Who caused it, so the inbox can put a face on the row. */
  actor_handle: string | null
  actor_name: string | null
  actor_avatar_url: string | null
}

const INBOX_SELECT = `SELECT n.id, n.reason, n.verb, n.summary, n.item_key, n.doc_slug,
         n.created_at, n.read_at,
         a.handle AS actor_handle, a.name AS actor_name, a.avatar_url AS actor_avatar_url
    FROM notification n
    -- The event, and through it the person, rather than a copy of their name
    -- on the notification: someone who changes their display name changes it
    -- everywhere, including in what they did last week.
    LEFT JOIN event e ON e.id = n.event_id
    LEFT JOIN actor a ON a.id = e.actor_id`

export async function notificationList(
  ctx: ICtx,
  limit = 50,
): Promise<{ notifications: INotificationRow[]; unread: number }> {
  const notifications = await ctx.db.query<INotificationRow>(
    `${INBOX_SELECT}
      WHERE n.actor_id = ?
      -- id breaks the tie: two notifications from one write share a
      -- millisecond, and ordering by time alone leaves their order to the
      -- query planner. Ids are monotonic, so newest stays newest.
      ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
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

/**
 * How long this person's unread notifications wait before we chase them,
 * in seconds. 0 is off.
 *
 * The options are deliberately few and coarse. This is a question about
 * temperament, not a duration anybody wants to type, and a free number would
 * only invite someone to set four minutes and then wonder why the sweep runs
 * on fives.
 */
export const REMINDER_DELAYS = [0, 600, 3600, 14400, 86400] as const

export async function notificationPrefs(
  ctx: ICtx,
): Promise<{ notify_after_seconds: number }> {
  const row = (
    await ctx.db.query<{ notify_after_seconds: number | null }>(
      'SELECT notify_after_seconds FROM actor WHERE id = ?',
      [ctx.actor.id],
    )
  )[0]
  return { notify_after_seconds: row?.notify_after_seconds ?? 0 }
}

export async function notificationPrefsSet(
  ctx: ICtx,
  seconds: number,
): Promise<{ notify_after_seconds: number }> {
  await ctx.db.run('UPDATE actor SET notify_after_seconds = ? WHERE id = ?', [
    seconds,
    ctx.actor.id,
  ])
  // Switching off clears what is already queued, because "stop emailing me"
  // has to mean the email that was about to go out too. Switching on does
  // not retime what is already there: a week of unread notifications would
  // all come due at once and arrive as one enormous digest a minute after
  // somebody changed a setting, which is a bad first impression of a feature
  // whose entire job is not being annoying.
  if (seconds === 0) {
    await ctx.db.run(
      'UPDATE notification SET remind_at = NULL WHERE actor_id = ? AND reminded_at IS NULL',
      [ctx.actor.id],
    )
  }
  return { notify_after_seconds: seconds }
}
