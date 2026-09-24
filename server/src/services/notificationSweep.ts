/**
 * The half of the notification system that time drives rather than people.
 *
 * Everything else in Acta happens because somebody wrote something. Two
 * things do not: a due date arriving, and a notification going unread for
 * long enough that the bell has plainly not been looked at. Both need
 * something outside the request path to notice, which is what this is.
 *
 * One function, two callers. On Cloudflare it is a cron trigger reaching
 * `scheduled()` in worker.ts; on Bun it is an interval in index.ts. Writing
 * it once is the point: a reminder that only fires on the hosted instance
 * would be a feature self-hosters are told they have and do not.
 *
 * Every step here is idempotent, because a sweep that runs twice (two
 * isolates, a retried cron, a restart) must not double-send. Due-date events
 * carry a deterministic op id, and a reminder stamps `reminded_at` in the
 * same statement that selects it.
 */
import { emitEvent } from '../core/events'
import { withOp } from '../core/ops'
import { now, type ICtx } from '../core/ctx'
import type { ISqlDriver } from '../db'
import { digestEmail, resendSender, type TEmailSender } from '../core/email'

/** How far ahead a due date starts being worth mentioning. */
const DUE_SOON_MS = 24 * 60 * 60 * 1000

/**
 * The most notifications one sweep will chase.
 *
 * Unbounded is fine on every ordinary tick and wrong on the first one after
 * an outage, where the query would load every notification written while the
 * cron was down. What is left over is picked up five minutes later, in order,
 * because the query takes the oldest first.
 */
const SWEEP_LIMIT = 2000

/**
 * The most lines one digest prints.
 *
 * Past a screenful the list has stopped being a summary. The count in the
 * subject is still the real one, so the email never understates what is
 * waiting, it only stops enumerating it.
 */
const DIGEST_LINES = 20

/**
 * A way of reaching somebody outside the app.
 *
 * Email is the one that exists. Slack is the one that is coming, and the
 * reason this is an interface rather than a function call: an instant
 * channel that links back into Acta would mark the notification read when
 * the link is followed, and the email would then never be owed at all. That
 * is the whole design, and it only works if the channels share this seam
 * instead of each growing their own copy of the sweep.
 */
export interface INotificationChannel {
  readonly id: string
  /** True when it was delivered, false when this channel cannot reach them. */
  reach(to: IRecipient, notes: IPendingNote[]): Promise<boolean>
}

export interface IRecipient {
  id: string
  name: string | null
  email: string | null
  workspace: string
  /** The workspace's URL segment. Every real route lives under it. */
  workspaceSlug: string | null
  baseUrl: string
}

export interface IPendingNote {
  id: string
  reason: string
  verb: string
  summary: string
  item_key: string | null
  doc_slug: string | null
  /**
   * Who did it. The summaries are written as activity lines with the actor
   * left off, because in the feed the face is already beside them. Out of
   * that context "commented on ST-1" five times is not a digest, it is a
   * list of the same sentence.
   */
  actor_name: string | null
}

export interface ISweepOptions {
  /** Ordered. The first channel that reaches the person wins. */
  channels?: INotificationChannel[]
  /** Acta's own public address, for the links in whatever gets sent. */
  baseUrl?: string
  /** Overridable in tests, so a sweep can be run at a chosen instant. */
  nowMs?: number
}

function systemCtx(
  db: ISqlDriver,
  workspaceId: string,
  system: { id: string; handle: string },
): ICtx {
  return {
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
}

/**
 * Tell assignees about a due date that is nearly here, or has passed.
 *
 * A real event rather than a notification written by hand, so the card's
 * history, the webhooks and the rules all see it too, and so the recipient
 * set is worked out by the same code as everything else.
 *
 * Deduplicated on the event, not on the clock: one `item.due_soon` per card
 * per due date, and a second one only if somebody moves the date. That is
 * what `op_log` is for, and the op id says exactly that.
 */
export async function dueDateSweep(
  db: ISqlDriver,
  opts: ISweepOptions = {},
): Promise<number> {
  const ts = opts.nowMs ?? now()
  const rows = await db.query<{
    id: string
    key: string
    title: string
    due: number
    workspace_id: string
  }>(
    `SELECT i.id, i.key, i.title, i.due, i.workspace_id
       FROM item i
      WHERE i.due IS NOT NULL AND i.completed = 0 AND i.archived = 0
        AND i.due <= ?
        -- Somebody has to care. A due date on a card nobody is assigned to
        -- is a date in a database, and there is no inbox to put it in.
        AND EXISTS (SELECT 1 FROM item_assignee a WHERE a.item_id = i.id)`,
    [ts + DUE_SOON_MS],
  )
  if (rows.length === 0) return 0

  let sent = 0
  for (const item of rows) {
    const overdue = item.due <= ts
    const verb = overdue ? 'item.overdue' : 'item.due_soon'
    // The due timestamp is in the op id, so moving the date earns one fresh
    // reminder and leaving it alone earns none, however often this runs.
    const opId = `due:${item.id}:${item.due}:${verb}`
    const already = await db.query<{ op_id: string }>(
      'SELECT op_id FROM op_log WHERE workspace_id = ? AND op_id = ?',
      [item.workspace_id, opId],
    )
    if (already.length > 0) continue

    const system = (
      await db.query<{ id: string; handle: string }>(
        "SELECT id, handle FROM actor WHERE workspace_id = ? AND kind = 'system' LIMIT 1",
        [item.workspace_id],
      )
    )[0]
    if (!system) continue

    // withOp rather than an emit and a hand-written op_log row: it is the
    // same envelope every other write in Acta goes through, so the event and
    // the record that it happened commit together. Written the other way,
    // a process that dies between the two sends the reminder again on the
    // next tick, with a new event id that the notification table's
    // uniqueness rule cannot catch.
    const holders = await db.query<{ actor_id: string }>(
      'SELECT actor_id FROM item_assignee WHERE item_id = ?',
      [item.id],
    )

    const ctx = systemCtx(db, item.workspace_id, system)
    const out = await withOp(ctx, opId, async () => {
      await emitEvent(
        ctx,
        verb,
        'item',
        item.id,
        overdue
          ? `${item.key} is overdue: ${item.title}`
          : `${item.key} is due soon: ${item.title}`,
        { due: item.due },
        // By name, so it reaches whoever is holding the card and stops
        // there. Involvement would add everybody who has ever commented,
        // and somebody else's work being late is not news you can act on.
        {
          to: holders.map((h) => ({
            actorId: h.actor_id,
            reason: 'assigned' as const,
          })),
        },
      )
      return { key: item.key }
    })
    if (out.ok) sent += 1
  }
  return sent
}

/**
 * Chase the notifications nobody has opened.
 *
 * Grouped by person and sent as one message, never one per notification.
 * The window is the person's own, so a busy card that produced nine
 * notifications in ten minutes produces one email.
 */
export async function reminderSweep(
  db: ISqlDriver,
  opts: ISweepOptions = {},
): Promise<number> {
  const channels = opts.channels ?? []
  if (channels.length === 0) return 0
  const ts = opts.nowMs ?? now()

  const due = await db.query<
    IPendingNote & { actor_id: string; workspace_id: string }
  >(
    `SELECT n.id, n.actor_id, n.workspace_id, n.reason, n.verb, n.summary,
            n.item_key, n.doc_slug, a.name AS actor_name
       FROM notification n
       LEFT JOIN event e ON e.id = n.event_id
       LEFT JOIN actor a ON a.id = e.actor_id
      WHERE n.read_at IS NULL AND n.reminded_at IS NULL
        AND n.remind_at IS NOT NULL AND n.remind_at <= ?
      ORDER BY n.created_at ASC
      LIMIT ?`,
    [ts, SWEEP_LIMIT],
  )
  if (due.length === 0) return 0

  const byActor = new Map<string, typeof due>()
  for (const row of due) {
    const list = byActor.get(row.actor_id)
    if (list) list.push(row)
    else byActor.set(row.actor_id, [row])
  }

  let reached = 0
  for (const [actorId, notes] of byActor) {
    const person = (
      await db.query<{
        name: string
        email: string | null
        workspace: string
        workspace_slug: string | null
      }>(
        `SELECT a.name, a.email, w.name AS workspace, w.slug AS workspace_slug
           FROM actor a JOIN workspace w ON w.id = a.workspace_id
          WHERE a.id = ? AND a.disabled = 0`,
        [actorId],
      )
    )[0]
    // Disabled since the notification was written, or never reachable.
    // Stamping them anyway is deliberate: leaving the rows pending would
    // have every sweep from now until they come back re-select the same
    // unreachable person.
    const recipient: IRecipient | null = person
      ? {
          id: actorId,
          name: person.name,
          email: person.email,
          workspace: person.workspace,
          workspaceSlug: person.workspace_slug,
          baseUrl: opts.baseUrl ?? '',
        }
      : null

    let via: string | null = null
    if (recipient) {
      for (const channel of channels) {
        try {
          if (await channel.reach(recipient, notes)) {
            via = channel.id
            break
          }
        } catch {
          // A channel that throws is a channel that did not deliver. Try the
          // next one, and if there is none, the stamp below still runs: a
          // reminder that failed is not worth retrying forever against an
          // address that is probably wrong.
        }
      }
      if (via) reached += 1
    }

    const ids = notes.map((n) => n.id)
    await db.run(
      `UPDATE notification SET reminded_at = ?, reminded_via = ?
        WHERE id IN (${ids.map(() => '?').join(',')})`,
      [ts, via, ...ids],
    )
  }
  return reached
}

export async function notificationSweep(
  db: ISqlDriver,
  opts: ISweepOptions = {},
): Promise<{ due: number; reminded: number }> {
  // Due dates first, so a card that falls due inside this tick can still be
  // reminded about in the same tick rather than waiting for the next one.
  const due = await dueDateSweep(db, opts)
  const reminded = await reminderSweep(db, opts)
  return { due, reminded }
}

const REASON_WORDS: Record<string, string> = {
  mention: 'Mentioned you',
  assigned: 'Assigned to you',
  involved: 'On your card',
}

/** The email channel. Silent, and honest about it, when there is no address. */
export function emailChannel(send: TEmailSender): INotificationChannel {
  return {
    id: 'email',
    async reach(to, notes) {
      if (!to.email) return false
      const base = to.baseUrl.replace(/\/$/, '')
      const message = digestEmail(
        {
          name: to.name,
          workspace: to.workspace,
          baseUrl: to.workspaceSlug ? `${base}/${to.workspaceSlug}` : base,
          total: notes.length,
        },
        collapse(
          notes.map((n) => ({
            summary: n.actor_name ? `${n.actor_name} ${n.summary}` : n.summary,
            reason: REASON_WORDS[n.reason] ?? 'Waiting on you',
            url: linkFor(base, to.workspaceSlug, n),
          })),
        ).slice(0, DIGEST_LINES),
      )
      await send({ to: to.email, ...message })
      return true
    },
  }
}

/**
 * Where a notification opens, as an absolute address.
 *
 * Built the way the app's own router reads it: every real route lives under
 * the workspace segment, a card opens the inspector over its space, and a
 * card key carries its space key in front of the dash. A link that lands on
 * the workspace chooser instead of the thing being talked about is worse
 * than no link, so with no base address or no slug this returns nothing and
 * the message is plain text.
 */
/**
 * Fold repeats into one line with a count.
 *
 * A conversation is the common shape of a digest: one card, six comments,
 * six notifications whose summaries are word for word identical. Printing
 * all six says nothing the first one did not, and it buries the other card
 * underneath them.
 */
function collapse(
  lines: Array<{ summary: string; reason: string; url: string | null }>,
): Array<{ summary: string; reason: string; url: string | null }> {
  const out: Array<{
    summary: string
    reason: string
    url: string | null
    count: number
  }> = []
  for (const line of lines) {
    const seen = out.find(
      (o) => o.summary === line.summary && o.reason === line.reason,
    )
    if (seen) seen.count += 1
    else out.push({ ...line, count: 1 })
  }
  return out.map((o) => ({
    summary: o.count > 1 ? `${o.summary} (${o.count} times)` : o.summary,
    reason: o.reason,
    url: o.url,
  }))
}

function linkFor(
  base: string,
  workspaceSlug: string | null,
  note: IPendingNote,
): string | null {
  if (!base || !workspaceSlug) return null
  const root = `${base}/${encodeURIComponent(workspaceSlug)}`
  if (note.item_key) {
    const spaceKey = note.item_key.split('-')[0]
    return `${root}/s/${encodeURIComponent(spaceKey)}?item=${encodeURIComponent(note.item_key)}`
  }
  if (note.doc_slug) return `${root}/docs/${note.doc_slug}`
  return null
}

/**
 * The channels an instance has, from what it has been configured with.
 *
 * Nothing configured means nothing is sent, and that is the self-hosted
 * default rather than a failure: the bell works, the digest simply has no
 * way out of the building. Returning an empty list makes `reminderSweep`
 * return immediately without touching a row, so notifications stay pending
 * rather than being stamped as reminded by a sweep that could not remind
 * anybody.
 */
export function channelsFromEnv(
  env: Record<string, string | undefined>,
): INotificationChannel[] {
  if (!env.ACTA_RESEND_API_KEY) return []
  return [
    emailChannel(
      resendSender(
        env.ACTA_RESEND_API_KEY,
        env.ACTA_EMAIL_FROM ?? 'Acta <acta@nubisco.io>',
      ),
    ),
  ]
}
