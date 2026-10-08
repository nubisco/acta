/**
 * Goals: what the work is for.
 *
 * A goal carries two signals, and the whole design is about keeping them
 * apart. One is the owner's judgement, posted as dated check-ins: pending, on
 * track, at risk, off track, and then done, paused or cancelled. The other is
 * the measured state of the cards that serve it, computed here on every read
 * and never stored, so it cannot drift from the cards themselves. A goal can
 * be nine tenths built and still off track, and the reason to look at goals
 * first is to see exactly that disagreement.
 *
 * Three relations, each a link rather than a ladder:
 *
 * - A goal can be part of another goal, at any depth, with cycles refused on
 *   write. A parent's work is its own cards plus its sub-goals' cards.
 * - A card can serve several goals, and everything that is part of a linked
 *   card serves it too. Linking the card that stands for a release brings the
 *   release's whole tree with it, which is the point of having parts.
 * - People own and follow goals. The owner and followers hear about
 *   check-ins; nobody else does.
 */

import {
  GOAL_REF_RE,
  newId,
  type TGoalOp,
  type TGoalRef,
  type TGoalStatus,
  type TOpResult,
  type zGoalGet,
  type zGoalList,
} from '@nubisco/acta-shared'
import type { z } from 'zod'
import { ApiError, now, type ICtx } from '../core/ctx'
import { emitEvent } from '../core/events'
import { withOp } from '../core/ops'
import { itemByKey } from '../core/store'
import {
  assertCanDeleteComment,
  assertCanEditComment,
  canDeleteComment,
  canEditComment,
  commentDeletePolicy,
} from './comments'
import { newMentions } from './notifications'

export interface IGoalRow {
  id: string
  number: number
  title: string
  description: string
  owner_id: string | null
  parent_id: string | null
  status: TGoalStatus
  start_date: number | null
  target_date: number | null
  metric_name: string | null
  metric_unit: string | null
  metric_start: number | null
  metric_target: number | null
  metric_current: number | null
  archived: number
  rev: number
  created_by: string
  created_at: number
  updated_at: number
}

/** A goal in flight, as opposed to one somebody has stopped steering. */
const IN_FLIGHT: ReadonlySet<TGoalStatus> = new Set([
  'pending',
  'on_track',
  'at_risk',
  'off_track',
])

/**
 * How long a goal in flight may go without a word before it is called
 * quiet. Atlassian prompts for an update monthly, and a goal nobody has
 * spoken about in a month is one nobody is steering, whatever its status
 * still says.
 */
const STALE_AFTER = 30 * 24 * 60 * 60 * 1000

export function goalKey(number: number): string {
  return `G-${number}`
}

export function goalNumber(ref: TGoalRef): number {
  if (typeof ref === 'number') return ref
  const m = GOAL_REF_RE.exec(ref)
  if (!m) throw new ApiError(400, `${ref} is not a goal reference`)
  return Number(m[1])
}

export async function goalByRef(ctx: ICtx, ref: TGoalRef): Promise<IGoalRow> {
  const number = goalNumber(ref)
  const rows = await ctx.db.query<IGoalRow>(
    'SELECT * FROM goal WHERE workspace_id = ? AND number = ?',
    [ctx.workspaceId, number],
  )
  if (rows.length === 0) throw new ApiError(404, `goal G-${number} not found`)
  return rows[0]
}

/**
 * A person, by handle or id. Owners and followers are people only: a goal
 * owned by an ingest token has nobody steering it, and a follower that
 * cannot read is a notification sent nowhere.
 */
async function personByRef(ctx: ICtx, ref: string): Promise<string> {
  const rows = await ctx.db.query<{ id: string; kind: string }>(
    `SELECT id, kind FROM actor
      WHERE workspace_id = ? AND disabled = 0 AND (id = ? OR handle = ?)`,
    [ctx.workspaceId, ref, ref],
  )
  if (rows.length === 0) throw new ApiError(404, `person ${ref} not found`)
  if (rows[0].kind !== 'human')
    throw new ApiError(
      400,
      `${ref} is not a person, so it cannot own or follow a goal`,
    )
  return rows[0].id
}

/**
 * Is `target` somewhere inside `start`'s own sub-goals? The same walk as a
 * card's `contains`, one table along, and refused for the same reason: a
 * loop detaches from every root and nothing in it can be reached again.
 */
async function goalContains(
  ctx: ICtx,
  start: string,
  target: string,
): Promise<boolean> {
  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (id === target) return true
    const next = await ctx.db.query<{ id: string }>(
      'SELECT id FROM goal WHERE parent_id = ?',
      [id],
    )
    for (const row of next) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      queue.push(row.id)
    }
  }
  return false
}

async function bumpGoalRev(
  ctx: ICtx,
  goal: IGoalRow,
  ifRev?: number,
): Promise<number> {
  if (ifRev !== undefined && ifRev !== goal.rev) {
    throw new ApiError(409, `rev conflict on ${goalKey(goal.number)}`, {
      goal: goalKey(goal.number),
      rev: goal.rev,
    })
  }
  const rev = goal.rev + 1
  await ctx.db.run('UPDATE goal SET rev = ?, updated_at = ? WHERE id = ?', [
    rev,
    now(),
    goal.id,
  ])
  return rev
}

const STATUS_WORDS: Record<TGoalStatus, string> = {
  pending: 'pending',
  on_track: 'on track',
  at_risk: 'at risk',
  off_track: 'off track',
  done: 'done',
  paused: 'paused',
  cancelled: 'cancelled',
}

/**
 * Link and unlink cards, one event per card.
 *
 * On the card rather than on the goal, so the rules engine (which only ever
 * reasons about cards) can act on it: "when a card is linked to a goal,
 * label it Roadmap" is the obvious first rule anybody writes.
 */
async function linkItems(
  ctx: ICtx,
  goal: IGoalRow,
  add: string[],
  remove: string[],
): Promise<number> {
  let changed = 0
  const key = goalKey(goal.number)
  for (const ref of add) {
    const item = await itemByKey(ctx, ref)
    const had = await ctx.db.query(
      'SELECT 1 FROM goal_item WHERE goal_id = ? AND item_id = ?',
      [goal.id, item.id],
    )
    if (had.length > 0) continue
    await ctx.db.run(
      `INSERT INTO goal_item (workspace_id, goal_id, item_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [ctx.workspaceId, goal.id, item.id, ctx.actor.id, now()],
    )
    await emitEvent(
      ctx,
      'item.goal_linked',
      'item',
      item.id,
      `${item.key} serves ${key}`,
      { goal: goal.number },
    )
    changed += 1
  }
  for (const ref of remove) {
    const item = await itemByKey(ctx, ref)
    const had = await ctx.db.query(
      'SELECT 1 FROM goal_item WHERE goal_id = ? AND item_id = ?',
      [goal.id, item.id],
    )
    if (had.length === 0) continue
    await ctx.db.run(
      'DELETE FROM goal_item WHERE goal_id = ? AND item_id = ?',
      [goal.id, item.id],
    )
    await emitEvent(
      ctx,
      'item.goal_unlinked',
      'item',
      item.id,
      `${item.key} no longer serves ${key}`,
      { goal: goal.number },
    )
    changed += 1
  }
  return changed
}

async function follow(
  ctx: ICtx,
  goal: IGoalRow,
  add: string[],
  remove: string[],
): Promise<void> {
  for (const ref of add) {
    const actorId = await personByRef(ctx, ref)
    await ctx.db.run(
      'INSERT OR IGNORE INTO goal_follower (goal_id, actor_id, created_at) VALUES (?, ?, ?)',
      [goal.id, actorId, now()],
    )
  }
  for (const ref of remove) {
    const actorId = await personByRef(ctx, ref)
    await ctx.db.run(
      'DELETE FROM goal_follower WHERE goal_id = ? AND actor_id = ?',
      [goal.id, actorId],
    )
  }
}

export async function goalWrite(
  ctx: ICtx,
  ops: TGoalOp[],
): Promise<TOpResult[]> {
  const results: TOpResult[] = []
  for (const op of ops) {
    results.push(await withOp(ctx, op.op_id, () => applyGoalOp(ctx, op)))
  }
  return results
}

async function applyGoalOp(
  ctx: ICtx,
  op: TGoalOp,
): Promise<{ key?: string; id?: string; rev?: number }> {
  const ts = now()
  switch (op.op) {
    case 'create': {
      const seq = (
        await ctx.db.query<{ next_goal_seq: number | null }>(
          'SELECT next_goal_seq FROM workspace WHERE id = ?',
          [ctx.workspaceId],
        )
      )[0]?.next_goal_seq
      const number = seq ?? 1
      await ctx.db.run('UPDATE workspace SET next_goal_seq = ? WHERE id = ?', [
        number + 1,
        ctx.workspaceId,
      ])

      // Whoever creates a goal owns it unless they say otherwise, the way
      // Atlassian does it, because a goal with no owner is a wish. An agent
      // creating one is not a person, so it leaves the goal unowned rather
      // than owned by something that cannot be asked.
      const ownerId =
        op.owner === null
          ? null
          : op.owner !== undefined
            ? await personByRef(ctx, op.owner)
            : ctx.actor.kind === 'human'
              ? ctx.actor.id
              : null
      const parent =
        op.parent !== undefined ? await goalByRef(ctx, op.parent) : undefined

      const id = newId('gol')
      await ctx.db.run(
        `INSERT INTO goal (id, workspace_id, number, title, description, owner_id, parent_id,
                           status, start_date, target_date,
                           metric_name, metric_unit, metric_start, metric_target, metric_current,
                           created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          ctx.workspaceId,
          number,
          op.title,
          op.description ?? '',
          ownerId,
          parent?.id ?? null,
          op.status ?? 'pending',
          op.start_date ?? null,
          op.target_date ?? null,
          op.metric?.name ?? null,
          op.metric?.unit ?? null,
          op.metric?.start ?? null,
          op.metric?.target ?? null,
          op.metric ? (op.metric.current ?? op.metric.start) : null,
          ctx.actor.id,
          ts,
          ts,
        ],
      )
      const goal = await goalByRef(ctx, number)
      await emitEvent(
        ctx,
        'goal.created',
        'goal',
        id,
        `created ${goalKey(number)}: ${op.title}`,
        { number },
        {
          body: op.description,
          // Being handed a goal is the goal equivalent of being assigned a
          // card. The creator owning their own goal is filtered out by the
          // notifier, which never tells anybody about their own action.
          to: ownerId ? [{ actorId: ownerId, reason: 'assigned' }] : [],
        },
      )
      await follow(ctx, goal, op.followers ?? [], [])
      await linkItems(ctx, goal, op.items ?? [], [])
      return { key: goalKey(number), id, rev: 1 }
    }

    case 'update': {
      const goal = await goalByRef(ctx, op.goal)
      const rev = await bumpGoalRev(ctx, goal, op.if_rev)
      const ownerId =
        op.owner === undefined
          ? goal.owner_id
          : op.owner === null
            ? null
            : await personByRef(ctx, op.owner)
      const metric = op.metric
      await ctx.db.run(
        `UPDATE goal SET
           title = COALESCE(?, title),
           description = COALESCE(?, description),
           owner_id = ?,
           start_date = ?,
           target_date = ?
         WHERE id = ?`,
        [
          op.title ?? null,
          op.description ?? null,
          ownerId,
          op.start_date === undefined ? goal.start_date : op.start_date,
          op.target_date === undefined ? goal.target_date : op.target_date,
          goal.id,
        ],
      )
      if (metric === null) {
        await ctx.db.run(
          `UPDATE goal SET metric_name = NULL, metric_unit = NULL, metric_start = NULL,
             metric_target = NULL, metric_current = NULL WHERE id = ?`,
          [goal.id],
        )
      } else if (metric !== undefined) {
        // Redefining the target keeps where the number actually is, unless
        // the caller says otherwise: moving the goalposts is not progress.
        await ctx.db.run(
          `UPDATE goal SET metric_name = ?, metric_unit = ?, metric_start = ?,
             metric_target = ?, metric_current = ? WHERE id = ?`,
          [
            metric.name,
            metric.unit ?? null,
            metric.start,
            metric.target,
            metric.current ?? goal.metric_current ?? metric.start,
            goal.id,
          ],
        )
      }
      const key = goalKey(goal.number)
      await emitEvent(
        ctx,
        'goal.updated',
        'goal',
        goal.id,
        `updated ${key}`,
        { number: goal.number },
        op.description === undefined
          ? undefined
          : newMentions(goal.description, op.description),
      )
      if (ownerId !== goal.owner_id) {
        await emitEvent(
          ctx,
          'goal.owner_changed',
          'goal',
          goal.id,
          ownerId
            ? `handed ${key} to a new owner`
            : `left ${key} without an owner`,
          { number: goal.number, from: goal.owner_id, to: ownerId },
          {
            to: [
              ...(ownerId
                ? [{ actorId: ownerId, reason: 'assigned' as const }]
                : []),
              // The person it was taken from, who would otherwise never
              // learn they stopped owning it. Same reasoning as a card's
              // unassigned event.
              ...(goal.owner_id
                ? [{ actorId: goal.owner_id, reason: 'assigned' as const }]
                : []),
            ],
          },
        )
      }
      return { key, rev }
    }

    case 'set_parent': {
      const goal = await goalByRef(ctx, op.goal)
      const key = goalKey(goal.number)
      if (op.parent === null) {
        if (goal.parent_id === null) return { key, rev: goal.rev }
        const rev = await bumpGoalRev(ctx, goal)
        await ctx.db.run('UPDATE goal SET parent_id = NULL WHERE id = ?', [
          goal.id,
        ])
        await emitEvent(
          ctx,
          'goal.detached',
          'goal',
          goal.id,
          `${key} is no longer part of another goal`,
          { number: goal.number },
        )
        return { key, rev }
      }
      const parent = await goalByRef(ctx, op.parent)
      if (parent.id === goal.id)
        throw new ApiError(400, 'a goal cannot be part of itself')
      if (await goalContains(ctx, goal.id, parent.id))
        throw new ApiError(
          409,
          `${goalKey(parent.number)} is already part of ${key}, directly or through others`,
        )
      const rev = await bumpGoalRev(ctx, goal)
      await ctx.db.run('UPDATE goal SET parent_id = ? WHERE id = ?', [
        parent.id,
        goal.id,
      ])
      await emitEvent(
        ctx,
        'goal.parented',
        'goal',
        goal.id,
        `${key} is part of ${goalKey(parent.number)}`,
        { number: goal.number, parent: parent.number },
      )
      return { key, rev }
    }

    case 'link': {
      const goal = await goalByRef(ctx, op.goal)
      const changed = await linkItems(ctx, goal, op.add ?? [], op.remove ?? [])
      // The goal's composition changed, so a client holding its rev is
      // holding a stale picture of it. Nothing to bump when nothing moved.
      const rev = changed > 0 ? await bumpGoalRev(ctx, goal) : goal.rev
      return { key: goalKey(goal.number), rev }
    }

    case 'check_in': {
      const goal = await goalByRef(ctx, op.goal)
      if (op.metric_value !== undefined && goal.metric_name === null)
        throw new ApiError(
          400,
          `${goalKey(goal.number)} has no metric to report a value against`,
        )
      const id = newId('gup')
      await ctx.db.run(
        `INSERT INTO goal_update (id, workspace_id, goal_id, actor_id, status, body, metric_value, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          ctx.workspaceId,
          goal.id,
          ctx.actor.id,
          op.status ?? null,
          op.body ?? '',
          op.metric_value ?? null,
          ts,
        ],
      )
      await ctx.db.run(
        `UPDATE goal SET status = COALESCE(?, status),
           metric_current = COALESCE(?, metric_current) WHERE id = ?`,
        [op.status ?? null, op.metric_value ?? null, goal.id],
      )
      const rev = await bumpGoalRev(ctx, goal)
      const key = goalKey(goal.number)
      const status = op.status ?? goal.status
      await emitEvent(
        ctx,
        'goal.checked_in',
        'goal',
        goal.id,
        `checked in on ${key}: ${STATUS_WORDS[status]}`,
        {
          number: goal.number,
          status,
          metric_value: op.metric_value,
          check_in: id,
        },
        op.body,
      )
      // A separate event for automation, not for people: whoever follows the
      // goal already heard about this check-in, and a second bell for the
      // same sentence is how a bell gets switched off.
      if (op.status !== undefined && op.status !== goal.status) {
        await emitEvent(
          ctx,
          'goal.status_changed',
          'goal',
          goal.id,
          `${key} went from ${STATUS_WORDS[goal.status]} to ${STATUS_WORDS[op.status]}`,
          { number: goal.number, from: goal.status, to: op.status },
        )
      }
      return { key, id, rev }
    }

    case 'check_in_update': {
      const goal = await goalByRef(ctx, op.goal)
      const existing = (
        await ctx.db.query<{ id: string; body: string; actor_id: string }>(
          'SELECT id, body, actor_id FROM goal_update WHERE id = ? AND goal_id = ?',
          [op.check_in_id, goal.id],
        )
      )[0]
      if (!existing)
        throw new ApiError(
          404,
          `check-in ${op.check_in_id} not on ${goalKey(goal.number)}`,
        )
      // A check-in carries its author's name and face, so it is theirs to
      // edit and nobody else's, exactly as a comment is.
      assertCanEditComment(ctx, existing.actor_id)
      await ctx.db.run(
        'UPDATE goal_update SET body = ?, edited_at = ? WHERE id = ?',
        [op.body, ts, existing.id],
      )
      await emitEvent(
        ctx,
        'goal.check_in_updated',
        'goal',
        goal.id,
        `edited a check-in on ${goalKey(goal.number)}`,
        { number: goal.number, check_in: existing.id },
        { body: newMentions(existing.body, op.body) },
      )
      return { key: goalKey(goal.number), id: existing.id, rev: goal.rev }
    }

    case 'check_in_delete': {
      const goal = await goalByRef(ctx, op.goal)
      const existing = (
        await ctx.db.query<{ id: string; actor_id: string }>(
          'SELECT id, actor_id FROM goal_update WHERE id = ? AND goal_id = ?',
          [op.check_in_id, goal.id],
        )
      )[0]
      if (!existing)
        throw new ApiError(
          404,
          `check-in ${op.check_in_id} not on ${goalKey(goal.number)}`,
        )
      assertCanDeleteComment(
        ctx,
        existing.actor_id,
        await commentDeletePolicy(ctx),
      )
      // The goal keeps the status it has. Deleting a note removes the note;
      // quietly rewinding the goal to whatever an older check-in said would
      // be a status change nobody made.
      await ctx.db.run('DELETE FROM goal_update WHERE id = ?', [existing.id])
      await emitEvent(
        ctx,
        'goal.check_in_deleted',
        'goal',
        goal.id,
        `deleted a check-in on ${goalKey(goal.number)}`,
        { number: goal.number, check_in: existing.id },
      )
      return { key: goalKey(goal.number), id: existing.id, rev: goal.rev }
    }

    case 'follow': {
      const goal = await goalByRef(ctx, op.goal)
      await follow(ctx, goal, op.add ?? [], op.remove ?? [])
      return { key: goalKey(goal.number), rev: goal.rev }
    }

    case 'archive':
    case 'restore': {
      const goal = await goalByRef(ctx, op.goal)
      const rev = await bumpGoalRev(ctx, goal)
      const archive = op.op === 'archive'
      await ctx.db.run('UPDATE goal SET archived = ? WHERE id = ?', [
        archive ? 1 : 0,
        goal.id,
      ])
      const key = goalKey(goal.number)
      await emitEvent(
        ctx,
        archive ? 'goal.archived' : 'goal.restored',
        'goal',
        goal.id,
        `${archive ? 'archived' : 'restored'} ${key}`,
        { number: goal.number },
      )
      return { key, rev }
    }

    case 'delete': {
      const goal = await goalByRef(ctx, op.goal)
      const key = goalKey(goal.number)
      if (goal.archived !== 1)
        throw new ApiError(
          409,
          `${key} is not archived; archive it before deleting`,
        )
      // Sub-goals stand on their own afterwards, and the cards are untouched:
      // removing what the work was for must not remove the work.
      await ctx.db.run('UPDATE goal SET parent_id = NULL WHERE parent_id = ?', [
        goal.id,
      ])
      await ctx.db.run('DELETE FROM goal_item WHERE goal_id = ?', [goal.id])
      await ctx.db.run('DELETE FROM goal_update WHERE goal_id = ?', [goal.id])
      await ctx.db.run('DELETE FROM goal_follower WHERE goal_id = ?', [goal.id])
      await ctx.db.run('DELETE FROM goal WHERE id = ?', [goal.id])
      await emitEvent(ctx, 'goal.deleted', 'goal', goal.id, `deleted ${key}`, {
        number: goal.number,
      })
      return { key }
    }
  }
}

// --------------------------------------------------------------------------
// Reads
// --------------------------------------------------------------------------

/** One card as goal progress sees it. */
interface IGoalCard {
  id: string
  key: string
  title: string
  space_key: string
  list: string
  done: boolean
  active: boolean
  waiting: boolean
  overdue: boolean
  weight: number
  /** The linked card this one is reached through, when it is a part. */
  via_id: string | null
  /** The card it is directly a part of, whether or not that serves the goal. */
  parent_id: string | null
}

export interface IGoalProgress {
  /** Cards serving the goal, its sub-goals' included, each counted once. */
  cards_total: number
  cards_done: number
  /** In a list whose role is active or review. */
  cards_active: number
  /** In a blocked list, or waiting on a card that is not done. */
  cards_waiting: number
  /** Not done and past due. */
  cards_overdue: number
  /** Sizes, with an unsized card counted as 1. */
  weight_total: number
  weight_done: number
  /** 0 to 100, by weight. Absent when there are no cards to measure. */
  percent?: number
}

function emptyProgress(): IGoalProgress {
  return {
    cards_total: 0,
    cards_done: 0,
    cards_active: 0,
    cards_waiting: 0,
    cards_overdue: 0,
    weight_total: 0,
    weight_done: 0,
  }
}

function measure(cards: Iterable<IGoalCard>): IGoalProgress {
  const p = emptyProgress()
  for (const c of cards) {
    p.cards_total += 1
    p.weight_total += c.weight
    if (c.done) {
      p.cards_done += 1
      p.weight_done += c.weight
      continue
    }
    if (c.active) p.cards_active += 1
    if (c.waiting) p.cards_waiting += 1
    if (c.overdue) p.cards_overdue += 1
  }
  if (p.cards_total > 0) {
    // By weight when anything has weight. A goal whose every card is sized
    // zero (all milestones, say) still has a done fraction worth showing, so
    // it falls back to counting cards rather than dividing by nothing.
    p.percent =
      p.weight_total > 0
        ? Math.round((p.weight_done / p.weight_total) * 100)
        : Math.round((p.cards_done / p.cards_total) * 100)
  }
  return p
}

/**
 * Every card serving every goal in the workspace, directly or as a part of a
 * linked card, in one query.
 *
 * Recursive rather than looped, because a dashboard reads every goal at once
 * and a loop would be a round trip per level per goal, which on D1 is the
 * difference between one request and dozens. UNION rather than UNION ALL, so
 * a card reached twice is one row, and the walk ends even on data an older
 * build might have left looping.
 *
 * Done means completed or sitting in a list whose role is done, which is
 * what a person looking at the board would call done.
 */
async function cardsByGoal(
  ctx: ICtx,
  goalId?: string,
): Promise<Map<string, Map<string, IGoalCard>>> {
  const today = now()
  const rows = await ctx.db.query<{
    goal_id: string
    root_id: string
    id: string
    key: string
    title: string
    space_key: string
    list: string
    role: string
    completed: number
    size: number | null
    due: number | null
    waiting: number
    parent_id: string | null
  }>(
    `WITH RECURSIVE gi(goal_id, root_id, item_id) AS (
       SELECT goal_id, item_id, item_id FROM goal_item
        WHERE workspace_id = ? ${goalId ? 'AND goal_id = ?' : ''}
       UNION
       SELECT gi.goal_id, gi.root_id, c.id FROM gi JOIN item c ON c.parent_id = gi.item_id
     )
     SELECT gi.goal_id, gi.root_id, i.id, i.key, i.title, s.key AS space_key,
            l.name AS list, l.role, i.completed, i.size, i.due, i.parent_id,
            EXISTS (SELECT 1 FROM item_dependency d JOIN item b ON b.id = d.blocker_id
                     WHERE d.blocked_id = i.id AND b.completed = 0 AND b.archived = 0) AS waiting
       FROM gi
       JOIN item i ON i.id = gi.item_id
       JOIN space s ON s.id = i.space_id
       JOIN list l ON l.id = i.list_id
      WHERE i.archived = 0
      ORDER BY i.key`,
    goalId ? [ctx.workspaceId, goalId] : [ctx.workspaceId],
  )
  const out = new Map<string, Map<string, IGoalCard>>()
  for (const r of rows) {
    let cards = out.get(r.goal_id)
    if (!cards) out.set(r.goal_id, (cards = new Map()))
    const linked = r.root_id === r.id
    const seen = cards.get(r.id)
    // Reached both directly and as a part of something else linked: it is
    // linked, and it says so, rather than claiming to be only a part.
    if (seen && (seen.via_id === null || !linked)) continue
    const done = r.completed === 1 || r.role === 'done'
    cards.set(r.id, {
      id: r.id,
      key: r.key,
      title: r.title,
      space_key: r.space_key,
      list: r.list,
      done,
      active: r.role === 'active' || r.role === 'review',
      waiting: r.role === 'blocked' || r.waiting === 1,
      overdue: !done && r.due !== null && r.due < today,
      weight: r.size ?? 1,
      via_id: linked ? null : r.root_id,
      parent_id: r.parent_id,
    })
  }
  return out
}

interface IGoalSet {
  goals: IGoalRow[]
  byId: Map<string, IGoalRow>
  children: Map<string, IGoalRow[]>
  own: Map<string, Map<string, IGoalCard>>
}

async function loadGoals(ctx: ICtx): Promise<IGoalSet> {
  const goals = await ctx.db.query<IGoalRow>(
    'SELECT * FROM goal WHERE workspace_id = ? ORDER BY number',
    [ctx.workspaceId],
  )
  const byId = new Map(goals.map((g) => [g.id, g]))
  const children = new Map<string, IGoalRow[]>()
  for (const g of goals) {
    if (!g.parent_id) continue
    const list = children.get(g.parent_id) ?? []
    list.push(g)
    children.set(g.parent_id, list)
  }
  return { goals, byId, children, own: await cardsByGoal(ctx) }
}

/**
 * A goal's cards, its sub-goals' included, each card once.
 *
 * Archived and cancelled sub-goals are left out. Their unfinished cards are
 * work somebody decided not to do, and counting them would hold the parent
 * below 100% for ever.
 */
function rolledCards(set: IGoalSet, goalId: string): Map<string, IGoalCard> {
  const out = new Map<string, IGoalCard>()
  const seen = new Set<string>()
  const walk = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    for (const [cardId, card] of set.own.get(id) ?? []) {
      if (!out.has(cardId)) out.set(cardId, card)
    }
    for (const child of set.children.get(id) ?? []) {
      if (child.archived === 1 || child.status === 'cancelled') continue
      walk(child.id)
    }
  }
  walk(goalId)
  return out
}

function metricOf(g: IGoalRow) {
  if (
    g.metric_name === null ||
    g.metric_start === null ||
    g.metric_target === null
  )
    return undefined
  const current = g.metric_current ?? g.metric_start
  const span = g.metric_target - g.metric_start
  const raw = span === 0 ? 0 : ((current - g.metric_start) / span) * 100
  return {
    name: g.metric_name,
    unit: g.metric_unit ?? undefined,
    start: g.metric_start,
    target: g.metric_target,
    current,
    percent: Math.max(0, Math.min(100, Math.round(raw))),
  }
}

interface ILastCheckIn {
  ts: number
  by: string
  status: string | null
}

/**
 * The compact shape every goal read returns, the list and the dashboard
 * included. Everything a row needs to be drawn, and to be judged, is decided
 * here against one clock rather than by each viewer's machine.
 */
function shapeGoal(
  g: IGoalRow,
  set: IGoalSet,
  handles: Map<string, string>,
  last: Map<string, ILastCheckIn>,
  following: Set<string>,
) {
  const today = now()
  const inFlight = IN_FLIGHT.has(g.status)
  const check = last.get(g.id)
  const spoke = check?.ts ?? g.created_at
  const subGoals = (set.children.get(g.id) ?? []).filter(
    (c) => c.archived === 0,
  )
  const parent = g.parent_id ? set.byId.get(g.parent_id) : undefined
  // How far through its window the goal is, so a reader can set the work
  // done against the time gone. Only with both ends, since a window with one
  // end is not a window.
  const elapsed =
    g.start_date !== null &&
    g.target_date !== null &&
    g.target_date > g.start_date
      ? Math.max(
          0,
          Math.min(
            100,
            Math.round(
              ((today - g.start_date) / (g.target_date - g.start_date)) * 100,
            ),
          ),
        )
      : undefined
  return {
    number: g.number,
    key: goalKey(g.number),
    title: g.title,
    status: g.status,
    owner: g.owner_id ? handles.get(g.owner_id) : undefined,
    parent: parent ? parent.number : undefined,
    start_date: g.start_date ?? undefined,
    target_date: g.target_date ?? undefined,
    archived: g.archived === 1 || undefined,
    metric: metricOf(g),
    progress: measure(rolledCards(set, g.id).values()),
    /** Cards linked to this goal itself, before parts and sub-goals. */
    linked: [...(set.own.get(g.id)?.values() ?? [])].filter(
      (c) => c.via_id === null,
    ).length,
    sub_goals: subGoals.length || undefined,
    elapsed,
    overdue:
      (inFlight && g.target_date !== null && g.target_date < today) ||
      undefined,
    stale: (inFlight && today - spoke > STALE_AFTER) || undefined,
    last_check_in: check
      ? { ts: check.ts, by: check.by, status: check.status ?? undefined }
      : undefined,
    following: following.has(g.id) || undefined,
    rev: g.rev,
    updated: g.updated_at,
  }
}

export type TGoalSummaryRow = ReturnType<typeof shapeGoal>

async function readContext(ctx: ICtx) {
  const handles = new Map(
    (
      await ctx.db.query<{ id: string; handle: string }>(
        'SELECT id, handle FROM actor WHERE workspace_id = ?',
        [ctx.workspaceId],
      )
    ).map((a) => [a.id, a.handle]),
  )
  // The latest check-in per goal. The tie on created_at is broken by id,
  // which is monotonic, so two check-ins in one millisecond still have an
  // order.
  const last = new Map<string, ILastCheckIn>()
  for (const r of await ctx.db.query<{
    goal_id: string
    created_at: number
    handle: string
    status: string | null
  }>(
    `SELECT u.goal_id, u.created_at, a.handle, u.status
       FROM goal_update u JOIN actor a ON a.id = u.actor_id
      WHERE u.workspace_id = ?
      ORDER BY u.created_at, u.id`,
    [ctx.workspaceId],
  )) {
    last.set(r.goal_id, { ts: r.created_at, by: r.handle, status: r.status })
  }
  const following = new Set(
    (
      await ctx.db.query<{ goal_id: string }>(
        'SELECT goal_id FROM goal_follower WHERE actor_id = ?',
        [ctx.actor.id],
      )
    ).map((r) => r.goal_id),
  )
  return { handles, last, following }
}

/**
 * Every goal, with its progress, plus a breakdown of the whole set: what the
 * dashboard draws and what an agent asking "how are our goals" wants in one
 * call.
 */
export async function goalList(ctx: ICtx, params: z.infer<typeof zGoalList>) {
  const set = await loadGoals(ctx)
  const { handles, last, following } = await readContext(ctx)
  const statuses = params.status
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const ownerId = params.owner
    ? ([...handles].find(
        ([id, h]) => id === params.owner || h === params.owner,
      )?.[0] ?? '\u0000')
    : undefined

  const rows = set.goals
    .filter((g) =>
      params.state === 'all'
        ? true
        : params.state === 'archived'
          ? g.archived === 1
          : g.archived === 0,
    )
    .filter((g) => !statuses || statuses.includes(g.status))
    .filter((g) => ownerId === undefined || g.owner_id === ownerId)
    .map((g) => shapeGoal(g, set, handles, last, following))

  return { goals: rows, summary: summarise(set, handles, last, following) }
}

/**
 * The breakdown, over every goal that is not archived regardless of the
 * filters on the list, so the dashboard's numbers do not change meaning when
 * somebody filters the table under them.
 */
function summarise(
  set: IGoalSet,
  handles: Map<string, string>,
  last: Map<string, ILastCheckIn>,
  following: Set<string>,
) {
  const open = set.goals.filter((g) => g.archived === 0)
  const by_status: Record<TGoalStatus, number> = {
    pending: 0,
    on_track: 0,
    at_risk: 0,
    off_track: 0,
    done: 0,
    paused: 0,
    cancelled: 0,
  }
  for (const g of open) by_status[g.status] += 1
  const shaped = open.map((g) => shapeGoal(g, set, handles, last, following))
  const inFlight = shaped.filter((g) => IN_FLIGHT.has(g.status))
  // Work across every goal in flight, each card once even when it serves
  // several goals, which is the honest answer to "how much is left".
  const cards = new Map<string, IGoalCard>()
  for (const g of open) {
    if (!IN_FLIGHT.has(g.status)) continue
    for (const [id, card] of set.own.get(g.id) ?? []) cards.set(id, card)
  }
  return {
    total: open.length,
    in_flight: inFlight.length,
    by_status,
    overdue: inFlight.filter((g) => g.overdue).length,
    stale: inFlight.filter((g) => g.stale).length,
    work: measure(cards.values()),
  }
}

/** Full detail for up to twenty goals. */
export async function goalGet(ctx: ICtx, params: z.infer<typeof zGoalGet>) {
  const include = new Set(params.include ?? ['items', 'check_ins'])
  const set = await loadGoals(ctx)
  const { handles, last, following } = await readContext(ctx)
  const policy = include.has('check_ins')
    ? await commentDeletePolicy(ctx)
    : 'author'
  const out = []
  for (const ref of params.goals) {
    const number = goalNumber(ref)
    const g = set.goals.find((x) => x.number === number)
    if (!g) throw new ApiError(404, `goal G-${number} not found`)
    const row: Record<string, unknown> = {
      ...shapeGoal(g, set, handles, last, following),
      description: g.description,
      created: g.created_at,
      created_by: handles.get(g.created_by),
      followers: (
        await ctx.db.query<{ handle: string }>(
          `SELECT a.handle FROM goal_follower f JOIN actor a ON a.id = f.actor_id
            WHERE f.goal_id = ? ORDER BY a.handle`,
          [g.id],
        )
      ).map((r) => r.handle),
      // Sub-goals with their own progress, so the page can show what each
      // contributes without a second read. Named apart from `sub_goals`,
      // which is a count on every compact row, so one field never means two
      // things depending on which read returned it.
      children: (set.children.get(g.id) ?? []).map((c) =>
        shapeGoal(c, set, handles, last, following),
      ),
      // The way up, for a breadcrumb: nearest parent first.
      ancestors: ancestorsOf(set, g).map((a) => ({
        number: a.number,
        key: goalKey(a.number),
        title: a.title,
      })),
    }
    if (include.has('items') || include.has('tree')) {
      const own = set.own.get(g.id) ?? new Map<string, IGoalCard>()
      const keyOf = (id: string | null) => (id ? own.get(id)?.key : undefined)
      const people = await assigneesOf(ctx, g.id)
      const blockers = include.has('tree')
        ? await blockersOf(ctx, g.id)
        : undefined
      row.items = [...own.values()].map((c) => ({
        key: c.key,
        title: c.title,
        space: c.space_key,
        list: c.list,
        done: c.done || undefined,
        active: c.active || undefined,
        waiting: c.waiting || undefined,
        overdue: c.overdue || undefined,
        size: c.weight,
        /** Linked to this goal directly, rather than counted as a part. */
        linked: c.via_id === null || undefined,
        /** The linked card it is a part of. */
        via: keyOf(c.via_id),
        /** Handles, so a reader can tell who is on it and what is free. */
        assignees: people.get(c.id),
        ...(blockers && {
          /**
           * The card it is directly a part of, for nesting. A parent that no
           * longer serves the goal (archived, say) falls back to the linked
           * card, so the part still has somewhere to hang.
           */
          parent:
            c.via_id === null
              ? undefined
              : (keyOf(c.parent_id) ?? keyOf(c.via_id)),
          blocked_by: blockers.get(c.id),
        }),
      }))
    }
    if (include.has('check_ins')) {
      row.check_ins = (
        await ctx.db.query<{
          id: string
          actor_id: string
          handle: string
          status: string | null
          body: string
          metric_value: number | null
          created_at: number
          edited_at: number | null
        }>(
          `SELECT u.id, u.actor_id, a.handle, u.status, u.body, u.metric_value,
                  u.created_at, u.edited_at
             FROM goal_update u JOIN actor a ON a.id = u.actor_id
            WHERE u.goal_id = ? ORDER BY u.created_at DESC, u.id DESC`,
          [g.id],
        )
      ).map((u) => ({
        id: u.id,
        by: u.handle,
        ts: u.created_at,
        edited: u.edited_at ?? undefined,
        status: u.status ?? undefined,
        body: u.body || undefined,
        metric_value: u.metric_value ?? undefined,
        can_edit: canEditComment(ctx, u.actor_id) || undefined,
        can_delete: canDeleteComment(ctx, u.actor_id, policy) || undefined,
      }))
    }
    out.push(row)
  }
  return { goals: out }
}

function ancestorsOf(set: IGoalSet, g: IGoalRow): IGoalRow[] {
  const out: IGoalRow[] = []
  const seen = new Set<string>([g.id])
  let cursor = g.parent_id ? set.byId.get(g.parent_id) : undefined
  while (cursor && !seen.has(cursor.id)) {
    out.push(cursor)
    seen.add(cursor.id)
    cursor = cursor.parent_id ? set.byId.get(cursor.parent_id) : undefined
  }
  return out
}

/**
 * The cards a goal counts itself, linked and every part below them, as a
 * subquery taking the goal's id. The same walk `cardsByGoal` makes, without
 * sub-goals, so the extras below line up with `items` card for card.
 */
const OWN_ITEMS_SQL = `
  WITH RECURSIVE gi(item_id) AS (
    SELECT item_id FROM goal_item WHERE goal_id = ?
    UNION
    SELECT c.id FROM item c JOIN gi ON c.parent_id = gi.item_id
  )`

/** Who is on each of a goal's cards, by card id, handles in order. */
async function assigneesOf(
  ctx: ICtx,
  goalId: string,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const r of await ctx.db.query<{ item_id: string; handle: string }>(
    `${OWN_ITEMS_SQL}
     SELECT ia.item_id, a.handle
       FROM gi
       JOIN item_assignee ia ON ia.item_id = gi.item_id
       JOIN actor a ON a.id = ia.actor_id
      ORDER BY a.handle`,
    [goalId],
  )) {
    const list = out.get(r.item_id) ?? []
    list.push(r.handle)
    out.set(r.item_id, list)
  }
  return out
}

interface IGoalBlocker {
  key: string
  title: string
  space: string
}

/**
 * What each of a goal's cards is still waiting on, by card id. Open blockers
 * only, the same test `waiting` makes, so a card with blockers listed is a
 * card counted as waiting. A blocker can live on any space and need not serve
 * the goal at all, so it carries its own title rather than a key to look up.
 */
async function blockersOf(
  ctx: ICtx,
  goalId: string,
): Promise<Map<string, IGoalBlocker[]>> {
  const out = new Map<string, IGoalBlocker[]>()
  for (const r of await ctx.db.query<{
    blocked_id: string
    key: string
    title: string
    space: string
  }>(
    `${OWN_ITEMS_SQL}
     SELECT d.blocked_id, b.key, b.title, s.key AS space
       FROM gi
       JOIN item_dependency d ON d.blocked_id = gi.item_id
       JOIN item b ON b.id = d.blocker_id
       JOIN space s ON s.id = b.space_id
      WHERE b.completed = 0 AND b.archived = 0
      ORDER BY b.key`,
    [goalId],
  )) {
    const list = out.get(r.blocked_id) ?? []
    list.push({ key: r.key, title: r.title, space: r.space })
    out.set(r.blocked_id, list)
  }
  return out
}

/**
 * The goals one card serves: linked to it, or to anything it is part of.
 * `via` names the card the link is actually on when it is an ancestor, so
 * the inspector can say why a card counts toward a goal nobody linked it to.
 */
export async function goalsForItem(ctx: ICtx, itemId: string) {
  const rows = await ctx.db.query<{
    number: number
    title: string
    status: string
    via_id: string
    via_key: string
  }>(
    `WITH RECURSIVE up(id, depth) AS (
       SELECT ?, 0
       UNION
       SELECT i.parent_id, up.depth + 1 FROM item i JOIN up ON i.id = up.id
        WHERE i.parent_id IS NOT NULL AND up.depth < 64
     )
     SELECT g.number, g.title, g.status, up.id AS via_id, it.key AS via_key
       FROM up
       JOIN goal_item gi ON gi.item_id = up.id
       JOIN goal g ON g.id = gi.goal_id
       JOIN item it ON it.id = up.id
      WHERE g.archived = 0
      ORDER BY up.depth, g.number`,
    [itemId],
  )
  const out = new Map<
    number,
    { number: number; key: string; title: string; status: string; via?: string }
  >()
  for (const r of rows) {
    if (out.has(r.number)) continue
    out.set(r.number, {
      number: r.number,
      key: goalKey(r.number),
      title: r.title,
      status: r.status,
      via: r.via_id === itemId ? undefined : r.via_key,
    })
  }
  return [...out.values()]
}

/**
 * SQL for "the ids of every card serving this goal", as a subquery taking
 * one parameter, the goal's id. Sub-goals and parts included, archived and
 * cancelled sub-goals left out, which is the same set `rolledCards` counts.
 *
 * A subquery rather than an id list, because D1 caps a statement at a
 * hundred bound parameters and a goal can easily serve more cards than that.
 */
export const GOAL_ITEMS_SQL = `
  WITH RECURSIVE gs(id) AS (
    SELECT ?
    UNION
    SELECT g.id FROM goal g JOIN gs ON g.parent_id = gs.id
     WHERE g.archived = 0 AND g.status <> 'cancelled'
  ),
  gi(item_id) AS (
    SELECT item_id FROM goal_item WHERE goal_id IN (SELECT id FROM gs)
    UNION
    SELECT c.id FROM item c JOIN gi ON c.parent_id = gi.item_id
  )
  SELECT item_id FROM gi`

/** The compact list the overview carries, for chips and pickers. */
export async function goalCatalogue(ctx: ICtx) {
  const rows = await ctx.db.query<{
    number: number
    title: string
    status: string
    parent_number: number | null
    archived: number
  }>(
    `SELECT g.number, g.title, g.status, p.number AS parent_number, g.archived
       FROM goal g LEFT JOIN goal p ON p.id = g.parent_id
      WHERE g.workspace_id = ? ORDER BY g.number`,
    [ctx.workspaceId],
  )
  return rows.map((r) => ({
    number: r.number,
    key: goalKey(r.number),
    title: r.title,
    status: r.status,
    parent: r.parent_number ?? undefined,
    archived: r.archived === 1 || undefined,
  }))
}
