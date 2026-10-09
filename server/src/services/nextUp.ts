/**
 * What to pick up next: one ranked list across every space, with the reasons
 * each card is there.
 *
 * Home's "Your work" was four separate lists (assigned, due, mentions,
 * recent), each in its own order, so nothing said which card mattered most.
 * Jose, 2026-10-09: "the user has a hard time understanding what he should
 * pick up next". This scores every candidate on signals a person would use
 * themselves and shows the signals, never a bare number: a ranking nobody
 * can see into is one nobody trusts.
 *
 * The weights are here, in one place, and each one has a test.
 */
import type { ICtx } from '../core/ctx'
import { now } from '../core/ctx'
import { GOAL_ITEMS_SQL } from './goals'

const DAY = 86_400_000

export const WEIGHTS = {
  overdueBase: 50,
  overduePerDay: 5,
  overdueMax: 80,
  dueToday: 45,
  dueIn3: 30,
  dueIn7: 15,
  mention: 35,
  blocksBase: 25,
  blocksPerExtra: 5,
  blocksMax: 40,
  blocksOverdue: 10,
  goalOffTrack: 25,
  goalAtRisk: 15,
  goalOverdue: 10,
  inProgress: 15,
  inReview: 20,
  milestone: 10,
  untouched: 10,
  urgent: 35,
  high: 20,
  medium: 5,
  nobodyOnIt: -10,
} as const

export interface INextReason {
  code: string
  /** What the chip says, e.g. "Overdue 2 days". */
  label: string
  points: number
  /** A card or goal the reason points at, when it has one. */
  ref?: string
}

export interface INextItem {
  key: string
  title: string
  space: string
  space_key: string
  list: string
  list_role: string
  due?: number
  priority?: string
  assigned: boolean
  score: number
  reasons: INextReason[]
}

interface ICandidate {
  id: string
  key: string
  title: string
  space: string
  space_key: string
  list: string
  role: string
  due: number | null
  priority: string | null
  is_milestone: number
  updated_at: number
  mine: number
}

const plural = (n: number, word: string) =>
  `${n} ${n === 1 ? word : `${word}s`}`

/**
 * Score and explain one card. Exported for the tests, which check each
 * signal on its own.
 */
export function scoreCard(
  card: ICandidate,
  facts: {
    today: number
    mentionedBy?: string
    blocks: { key: string; overdue: boolean }[]
    goal?: { key: string; status: string; overdue: boolean }
    waitingOn?: string
  },
): { score: number; reasons: INextReason[] } {
  const reasons: INextReason[] = []
  const add = (code: string, label: string, points: number, ref?: string) =>
    reasons.push({ code, label, points, ...(ref ? { ref } : {}) })
  const { today } = facts

  if (card.due !== null) {
    const startOfToday = new Date(today).setHours(0, 0, 0, 0)
    if (card.due < startOfToday) {
      const days = Math.max(1, Math.floor((startOfToday - card.due) / DAY) + 1)
      add(
        'overdue',
        `Overdue ${plural(days, 'day')}`,
        Math.min(
          WEIGHTS.overdueMax,
          WEIGHTS.overdueBase + WEIGHTS.overduePerDay * days,
        ),
      )
    } else {
      const days = Math.floor((card.due - startOfToday) / DAY)
      if (days === 0) add('due', 'Due today', WEIGHTS.dueToday)
      else if (days === 1) add('due', 'Due tomorrow', WEIGHTS.dueIn3)
      else if (days <= 3) add('due', `Due in ${days} days`, WEIGHTS.dueIn3)
      else if (days <= 7) add('due', `Due in ${days} days`, WEIGHTS.dueIn7)
    }
  }
  if (card.priority === 'urgent') add('priority', 'Urgent', WEIGHTS.urgent)
  else if (card.priority === 'high')
    add('priority', 'High priority', WEIGHTS.high)
  else if (card.priority === 'medium')
    add('priority', 'Medium priority', WEIGHTS.medium)
  if (facts.mentionedBy)
    add('mention', `${facts.mentionedBy} mentioned you`, WEIGHTS.mention)
  if (facts.blocks.length > 0) {
    const points =
      Math.min(
        WEIGHTS.blocksMax,
        WEIGHTS.blocksBase + WEIGHTS.blocksPerExtra * (facts.blocks.length - 1),
      ) + (facts.blocks.some((b) => b.overdue) ? WEIGHTS.blocksOverdue : 0)
    const first = facts.blocks[0].key
    add(
      'blocks',
      facts.blocks.length === 1
        ? `Blocks ${first}`
        : `Blocks ${first} and ${facts.blocks.length - 1} more`,
      points,
      first,
    )
  }
  if (
    facts.goal &&
    (facts.goal.status === 'off_track' || facts.goal.status === 'at_risk')
  ) {
    const off = facts.goal.status === 'off_track'
    add(
      'goal',
      `${facts.goal.key} ${off ? 'off track' : 'at risk'}`,
      (off ? WEIGHTS.goalOffTrack : WEIGHTS.goalAtRisk) +
        (facts.goal.overdue ? WEIGHTS.goalOverdue : 0),
      facts.goal.key,
    )
  }
  if (card.role === 'active') {
    add('active', 'In progress', WEIGHTS.inProgress)
    const idle = Math.floor((today - card.updated_at) / DAY)
    if (idle >= 7)
      add('untouched', `Untouched ${plural(idle, 'day')}`, WEIGHTS.untouched)
  }
  if (card.role === 'review' && card.mine)
    add('review', 'In review', WEIGHTS.inReview)
  if (card.is_milestone) add('milestone', 'Milestone', WEIGHTS.milestone)
  if (!card.mine && reasons.length > 0)
    add('unassigned', 'Nobody on it', WEIGHTS.nobodyOnIt)

  const score = reasons.reduce((sum, r) => sum + r.points, 0)
  return { score, reasons }
}

export async function nextUp(ctx: ICtx, limit = 7) {
  const me = ctx.actor.onBehalfOf ?? ctx.actor.id
  const today = now()

  // Mine and open, plus anybody's open card due within a week in a space I
  // have worked in: a dated card nobody is on lands on the same day anyway.
  const candidates = await ctx.db.query<ICandidate>(
    `SELECT i.id, i.key, i.title, s.name AS space, s.key AS space_key,
            l.name AS list, l.role, i.due, i.priority, i.is_milestone, i.updated_at,
            EXISTS (SELECT 1 FROM item_assignee ia WHERE ia.item_id = i.id AND ia.actor_id = ?) AS mine
       FROM item i
       JOIN space s ON s.id = i.space_id AND s.archived = 0
       JOIN list l ON l.id = i.list_id
      WHERE i.workspace_id = ? AND i.archived = 0 AND i.completed = 0 AND l.role != 'done'
        AND (
          EXISTS (SELECT 1 FROM item_assignee ia WHERE ia.item_id = i.id AND ia.actor_id = ?)
          OR i.key IN (SELECT item_key FROM notification
                        WHERE actor_id = ? AND read_at IS NULL AND reason = 'mention' AND item_key IS NOT NULL)
          OR (i.due IS NOT NULL AND i.due <= ?
              AND NOT EXISTS (SELECT 1 FROM item_assignee ia WHERE ia.item_id = i.id)
              AND i.space_id IN (SELECT DISTINCT it.space_id FROM item_assignee ia
                                   JOIN item it ON it.id = ia.item_id WHERE ia.actor_id = ?))
        )`,
    [me, ctx.workspaceId, me, me, today + 7 * DAY, me],
  )
  if (candidates.length === 0)
    return { counts: emptyCounts(), items: [], waiting: [] }

  const ids = JSON.stringify(candidates.map((c) => c.id))

  const mentions = new Map<string, string>()
  for (const row of await ctx.db.query<{ item_key: string; name: string }>(
    `SELECT n.item_key, a.name FROM notification n
       JOIN event e ON e.id = n.event_id JOIN actor a ON a.id = e.actor_id
      WHERE n.actor_id = ? AND n.read_at IS NULL AND n.reason = 'mention'
        AND n.item_key IS NOT NULL
      ORDER BY n.created_at DESC`,
    [me],
  ))
    if (!mentions.has(row.item_key))
      mentions.set(row.item_key, row.name.split(' ')[0])

  // What each candidate holds up: open cards somebody else is on.
  const blocks = new Map<string, { key: string; overdue: boolean }[]>()
  for (const row of await ctx.db.query<{
    blocker_id: string
    key: string
    due: number | null
  }>(
    `SELECT d.blocker_id, b.key, b.due FROM item_dependency d
       JOIN item b ON b.id = d.blocked_id
      WHERE d.blocker_id IN (SELECT value FROM json_each(?))
        AND b.completed = 0 AND b.archived = 0
        AND EXISTS (SELECT 1 FROM item_assignee ia WHERE ia.item_id = b.id AND ia.actor_id != ?)`,
    [ids, me],
  )) {
    const list = blocks.get(row.blocker_id) ?? []
    list.push({ key: row.key, overdue: row.due !== null && row.due < today })
    blocks.set(row.blocker_id, list)
  }

  // What holds each candidate up: it waits rather than ranks.
  const waitingOn = new Map<string, string>()
  for (const row of await ctx.db.query<{ blocked_id: string; key: string }>(
    `SELECT d.blocked_id, b.key FROM item_dependency d
       JOIN item b ON b.id = d.blocker_id
      WHERE d.blocked_id IN (SELECT value FROM json_each(?))
        AND b.completed = 0 AND b.archived = 0`,
    [ids],
  ))
    if (!waitingOn.has(row.blocked_id)) waitingOn.set(row.blocked_id, row.key)

  // The worst goal each candidate serves, among goals in trouble.
  const goalOf = new Map<
    string,
    { key: string; status: string; overdue: boolean }
  >()
  const troubled = await ctx.db.query<{
    id: string
    number: number
    status: string
    target_date: number | null
  }>(
    `SELECT id, number, status, target_date FROM goal
      WHERE workspace_id = ? AND archived = 0 AND status IN ('off_track', 'at_risk')
      ORDER BY CASE status WHEN 'off_track' THEN 0 ELSE 1 END, number`,
    [ctx.workspaceId],
  )
  for (const goal of troubled) {
    const served = await ctx.db.query<{ item_id: string }>(GOAL_ITEMS_SQL, [
      goal.id,
    ])
    for (const { item_id } of served)
      if (!goalOf.has(item_id))
        goalOf.set(item_id, {
          key: `G-${goal.number}`,
          status: goal.status,
          overdue: goal.target_date !== null && goal.target_date < today,
        })
  }

  const ranked: INextItem[] = []
  const waiting: (INextItem & { waiting_on: string })[] = []
  for (const card of candidates) {
    const { score, reasons } = scoreCard(card, {
      today,
      mentionedBy: mentions.get(card.key),
      blocks: blocks.get(card.id) ?? [],
      goal: goalOf.get(card.id),
    })
    const item: INextItem = {
      key: card.key,
      title: card.title,
      space: card.space,
      space_key: card.space_key,
      list: card.list,
      list_role: card.role,
      due: card.due ?? undefined,
      priority: card.priority ?? undefined,
      assigned: card.mine === 1,
      score,
      reasons: reasons.sort((a, b) => b.points - a.points),
    }
    const blocker = waitingOn.get(card.id)
    if (blocker) waiting.push({ ...item, waiting_on: blocker })
    else if (card.mine || score > 0) ranked.push(item)
  }
  // Highest first, then the sooner due, then the most recently touched.
  const order = (a: INextItem, b: INextItem) =>
    b.score - a.score ||
    (a.due ?? Infinity) - (b.due ?? Infinity) ||
    a.key.localeCompare(b.key)
  ranked.sort(order)
  waiting.sort(order)

  const startOfToday = new Date(today).setHours(0, 0, 0, 0)
  const mineOpen = candidates.filter((c) => c.mine)
  return {
    counts: {
      overdue: mineOpen.filter((c) => c.due !== null && c.due < startOfToday)
        .length,
      due_today: mineOpen.filter(
        (c) =>
          c.due !== null && c.due >= startOfToday && c.due < startOfToday + DAY,
      ).length,
      due_week: mineOpen.filter(
        (c) =>
          c.due !== null &&
          c.due >= startOfToday &&
          c.due < startOfToday + 7 * DAY,
      ).length,
      mentions: mentions.size,
      blocking: [...blocks.keys()].filter((id) =>
        mineOpen.some((c) => c.id === id),
      ).length,
      waiting: waiting.length,
    },
    items: ranked.slice(0, limit),
    waiting: waiting.slice(0, limit),
  }
}

function emptyCounts() {
  return {
    overdue: 0,
    due_today: 0,
    due_week: 0,
    mentions: 0,
    blocking: 0,
    waiting: 0,
  }
}
