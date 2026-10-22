/**
 * How long people wait: time to first response and time to resolution, per
 * space and per label, over a date range (LA-370).
 *
 * Both are read from the event log rather than kept as columns, so they cover
 * every card that already exists and cannot drift from what happened.
 *
 * FIRST RESPONSE is the first comment, list move, completion or reopening on
 * the card by a person who is not the card's creator. An agent or the system
 * never responds, whoever it acts for: a contact form filing a card, a rule
 * moving it and an assistant commenting on it are all things happening TO the
 * request, not somebody answering it. A personal access token is its owner,
 * so a person working through their own MCP client still counts. Reordering
 * a card within its list is not a move.
 *
 * RESOLUTION is the card reaching a done-role list, or being completed. A
 * card that is reopened and resolved again is resolved at the last time, and
 * its time runs from creation to then, the reopened stretch included: the
 * person who asked was waiting for all of it. A card created straight into a
 * done list has no resolution, since nobody resolved it.
 *
 * A card counts toward the range its response or resolution happened in,
 * judged only on what had happened by the end of the range, so a past week
 * reads the same whenever it is asked about. `received` and `unanswered` are
 * the cards created in the range, and those of them still waiting for a first
 * response when the range ended.
 *
 * Cards are grouped by the space they are in and the labels they carry now,
 * not when they were answered. Durations are calendar time, not working
 * hours. The median and the 90th percentile interpolate between neighbours,
 * the way a spreadsheet's PERCENTILE.INC does.
 */
import type { ICtx } from '../core/ctx'
import { ApiError, now } from '../core/ctx'

const WEEK = 7 * 86_400_000
/** A year and a bit: enough for any review, and a bound on the work. */
const MAX_RANGE = 400 * 86_400_000

export interface IDurationStats {
  /** How many cards this is measured over. */
  count: number
  /** Null when there is nothing to measure. */
  median_ms: number | null
  p90_ms: number | null
}

export interface IResponseStats {
  /** Cards created in the range. */
  received: number
  /** Of those, the ones with no first response by the end of the range. */
  unanswered: number
  first_response: IDurationStats
  resolution: IDurationStats
}

export interface IResponseLabelRow extends IResponseStats {
  id: string
  name: string
  color: string
  group: string
}

export interface IResponseSpaceRow {
  key: string
  name: string
  all: IResponseStats
  labels: IResponseLabelRow[]
}

export interface IResponseTimes {
  from: number
  to: number
  spaces: IResponseSpaceRow[]
}

/** What the measurement needs to know about one card. */
export interface ICardFacts {
  created_by: string
  /** Whether the card's space has a done list, so moving is what done means. */
  has_done_list: boolean
}

export interface ICardEvent {
  ts: number
  actor_id: string
  actor_kind: string
  verb: string
  payload: string | null
}

/** Resolves a list, by id where the event recorded one, else by name. */
export type TRoleOf = (
  listId: string | undefined,
  name: string | undefined,
) => string | null

interface IListRef {
  id?: string
  name?: string
}

interface IMovePayload {
  list?: string
  list_id?: string
  to_list?: string
  from_list?: string
}

function parse(payload: string | null): IMovePayload {
  if (!payload) return {}
  try {
    return JSON.parse(payload) as IMovePayload
  } catch {
    return {}
  }
}

/**
 * When a card was first responded to and when it was resolved, from its
 * events in order. Either is null when it has not happened.
 *
 * Moves are recognised two ways because the log has two shapes. Events
 * written since this report record the list ids, and a move without a
 * `from_list` stayed in its list. Older ones carry only the list's name, so a
 * move counts when the name differs from where the card was.
 */
export function measureCard(
  card: ICardFacts,
  events: ICardEvent[],
  roleOf: TRoleOf,
): { first_response_at: number | null; resolved_at: number | null } {
  let where: IListRef = {}
  let done = false
  let resolvedAt: number | null = null
  let firstAt: number | null = null

  for (const event of events) {
    let response: boolean
    switch (event.verb) {
      case 'item.created': {
        const p = parse(event.payload)
        where = { id: p.list_id, name: p.list }
        // Created already done: done, and nobody resolved it.
        done = roleOf(where.id, where.name) === 'done'
        continue
      }
      case 'comment.created':
        response = true
        break
      case 'item.moved': {
        const p = parse(event.payload)
        const to: IListRef = { id: p.to_list, name: p.list }
        response =
          p.from_list !== undefined ||
          (p.to_list === undefined && to.name !== where.name)
        where = to
        // Without a done list, a list says nothing about done: the completed
        // flag is the only way such a space has to say so.
        if (card.has_done_list) {
          const nowDone = roleOf(to.id, to.name) === 'done'
          if (nowDone && !done) resolvedAt = event.ts
          done = nowDone
        }
        break
      }
      case 'item.completed':
        response = true
        if (!done) resolvedAt = event.ts
        done = true
        break
      case 'item.reopened':
        response = true
        done = false
        break
      default:
        continue
    }
    if (
      response &&
      firstAt === null &&
      event.actor_kind === 'human' &&
      event.actor_id !== card.created_by
    )
      firstAt = event.ts
  }
  return { first_response_at: firstAt, resolved_at: done ? resolvedAt : null }
}

/**
 * The q-th quantile of sorted values, interpolating between the two nearest
 * (PERCENTILE.INC). Whole milliseconds.
 */
export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null
  const h = (sorted.length - 1) * q
  const lo = Math.floor(h)
  const hi = Math.min(lo + 1, sorted.length - 1)
  return Math.round(sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]))
}

function durations(values: number[]): IDurationStats {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    median_ms: quantile(sorted, 0.5),
    p90_ms: quantile(sorted, 0.9),
  }
}

interface IBucket {
  received: number
  unanswered: number
  first: number[]
  resolution: number[]
}

const emptyBucket = (): IBucket => ({
  received: 0,
  unanswered: 0,
  first: [],
  resolution: [],
})

function stats(bucket: IBucket): IResponseStats {
  return {
    received: bucket.received,
    unanswered: bucket.unanswered,
    first_response: durations(bucket.first),
    resolution: durations(bucket.resolution),
  }
}

const VERBS = [
  'item.created',
  'item.moved',
  'item.completed',
  'item.reopened',
  'comment.created',
]

/**
 * The report. Five queries whatever the size of the space: its lists, its
 * cards, their labels and the events that matter, the last read through
 * idx_event_entity one card at a time.
 */
export async function responseTimes(
  ctx: ICtx,
  params: { space?: string; from?: number; to?: number },
): Promise<IResponseTimes> {
  // `to` is exclusive, so the default reaches one past now: something that
  // happened this very millisecond has happened.
  const to = params.to ?? now() + 1
  const from = params.from ?? to - WEEK
  if (from >= to) throw new ApiError(400, 'from must be before to')
  if (to - from > MAX_RANGE)
    throw new ApiError(400, 'the range can be at most 400 days')

  const spaces = await ctx.db.query<{ id: string; key: string; name: string }>(
    params.space
      ? 'SELECT id, key, name FROM space WHERE workspace_id = ? AND key = ?'
      : 'SELECT id, key, name FROM space WHERE workspace_id = ? AND archived = 0 ORDER BY key',
    params.space ? [ctx.workspaceId, params.space] : [ctx.workspaceId],
  )
  if (params.space && spaces.length === 0)
    throw new ApiError(404, `space ${params.space} not found`)

  // Which cards: the space asked for, or every space that is not archived.
  const scope = params.space
    ? 'i.space_id = ?'
    : 'i.space_id IN (SELECT id FROM space WHERE workspace_id = ? AND archived = 0)'
  const scopeArg = params.space ? spaces[0].id : ctx.workspaceId

  // Every list in the workspace, archived ones too: an old event can name a
  // list that has since been archived, or one on the space a card came from.
  const lists = await ctx.db.query<{
    id: string
    space_id: string
    name: string
    role: string
  }>(
    `SELECT l.id, l.space_id, l.name, l.role FROM list l
       WHERE l.workspace_id = ? ORDER BY l.archived, l.pos`,
    [ctx.workspaceId],
  )
  const roleById = new Map(lists.map((l) => [l.id, l.role]))
  const roleByName = new Map<string, Map<string, string>>()
  const withDone = new Set<string>()
  for (const list of lists) {
    const names = roleByName.get(list.space_id) ?? new Map<string, string>()
    if (!names.has(list.name)) names.set(list.name, list.role)
    roleByName.set(list.space_id, names)
    if (list.role === 'done') withDone.add(list.space_id)
  }

  const items = await ctx.db.query<{
    id: string
    space_id: string
    created_by: string
    created_at: number
  }>(
    `SELECT i.id, i.space_id, i.created_by, i.created_at FROM item i
      WHERE i.workspace_id = ? AND ${scope} AND i.created_at < ?`,
    [ctx.workspaceId, scopeArg, to],
  )

  const labelRows = await ctx.db.query<{
    item_id: string
    id: string
    name: string
    color: string
    pos: number | null
    group_name: string
  }>(
    `SELECT il.item_id, l.id, l.name, l.color, l.pos, g.name AS group_name
       FROM item_label il
       JOIN item i ON i.id = il.item_id
       JOIN label l ON l.id = il.label_id
       JOIN label_group g ON g.id = l.group_id
      WHERE i.workspace_id = ? AND ${scope} AND i.created_at < ?`,
    [ctx.workspaceId, scopeArg, to],
  )
  const labelsOf = new Map<string, typeof labelRows>()
  for (const row of labelRows) {
    const list = labelsOf.get(row.item_id) ?? []
    list.push(row)
    labelsOf.set(row.item_id, list)
  }

  const events = await ctx.db.query<ICardEvent & { item_id: string }>(
    `SELECT e.entity_id AS item_id, e.ts, e.actor_id, e.actor_kind, e.verb, e.payload
       FROM item i
       JOIN event e ON e.entity_id = i.id
      WHERE i.workspace_id = ? AND ${scope} AND i.created_at < ?
        AND e.entity = 'item' AND e.ts < ?
        AND e.verb IN (${VERBS.map(() => '?').join(', ')})
      ORDER BY e.ts, e.id`,
    [ctx.workspaceId, scopeArg, to, to, ...VERBS],
  )
  const eventsOf = new Map<string, ICardEvent[]>()
  for (const event of events) {
    const list = eventsOf.get(event.item_id) ?? []
    list.push(event)
    eventsOf.set(event.item_id, list)
  }

  const bySpace = new Map(
    spaces.map((s) => [
      s.id,
      {
        all: emptyBucket(),
        labels: new Map<
          string,
          { row: (typeof labelRows)[number]; bucket: IBucket }
        >(),
      },
    ]),
  )

  for (const item of items) {
    const space = bySpace.get(item.space_id)
    if (!space) continue
    const names = roleByName.get(item.space_id)
    const roleOf: TRoleOf = (id, name) =>
      (id !== undefined ? roleById.get(id) : undefined) ??
      (name !== undefined ? names?.get(name) : undefined) ??
      null
    const { first_response_at, resolved_at } = measureCard(
      {
        created_by: item.created_by,
        has_done_list: withDone.has(item.space_id),
      },
      eventsOf.get(item.id) ?? [],
      roleOf,
    )
    const inRange = (ts: number | null): ts is number =>
      ts !== null && ts >= from && ts < to
    const buckets = [space.all]
    for (const label of labelsOf.get(item.id) ?? []) {
      let entry = space.labels.get(label.id)
      if (!entry) {
        entry = { row: label, bucket: emptyBucket() }
        space.labels.set(label.id, entry)
      }
      buckets.push(entry.bucket)
    }
    for (const bucket of buckets) {
      if (item.created_at >= from) {
        bucket.received += 1
        if (first_response_at === null) bucket.unanswered += 1
      }
      if (inRange(first_response_at))
        bucket.first.push(first_response_at - item.created_at)
      if (inRange(resolved_at))
        bucket.resolution.push(resolved_at - item.created_at)
    }
  }

  const active = (b: IBucket) =>
    b.received > 0 || b.first.length > 0 || b.resolution.length > 0

  return {
    from,
    to,
    spaces: spaces
      .map((s) => {
        const space = bySpace.get(s.id)!
        const labels = [...space.labels.values()]
          .filter((entry) => active(entry.bucket))
          // In each group's own order where it has one, the way the board
          // lists them, else by name.
          .sort(
            (a, b) =>
              a.row.group_name.localeCompare(b.row.group_name) ||
              (a.row.pos !== null && b.row.pos !== null
                ? a.row.pos - b.row.pos
                : 0) ||
              a.row.name.localeCompare(b.row.name),
          )
          .map(({ row, bucket }) => ({
            id: row.id,
            name: row.name,
            color: row.color,
            group: row.group_name,
            ...stats(bucket),
          }))
        return {
          key: s.key,
          name: s.name,
          all: stats(space.all),
          labels,
          quiet: !active(space.all),
        }
      })
      // Asked about by name, a space is always answered. Across the whole
      // workspace, one where nothing happened is noise.
      .filter((s) => params.space !== undefined || !s.quiet)
      .map(({ quiet: _quiet, ...rest }) => rest),
  }
}
