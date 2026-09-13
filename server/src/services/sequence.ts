/**
 * The order work has to happen in, and the longest road through it.
 *
 * A timeline needs dates, and software rarely has them: people know that one
 * card blocks another long before anyone will commit to a Tuesday. So the
 * plan here is built from dependencies rather than dates, which is the thing
 * teams actually know.
 *
 * Two numbers come out of it. The LAYER is how many steps from the start a
 * card sits, so everything in layer 0 can begin now and nothing in layer 3
 * can begin until three rounds of work are done. The CRITICAL PATH is the
 * longest chain by size: the route that decides the finish, and the only one
 * where saving a day saves a day overall.
 */
import type { ICtx } from '../core/ctx'
import { ApiError } from '../core/ctx'

export interface ISequenceNode {
  key: string
  title: string
  list: string
  status: 'open' | 'done' | 'archived'
  assignees: string[]
  labels: string[]
  size: number | null
  is_milestone: boolean
  /** Steps from the start. Everything in 0 can begin immediately. */
  layer: number
  /** Cards that must finish before this one. */
  blocked_by: string[]
  /** Cards waiting on this one. */
  blocks: string[]
  /** On the longest chain by size, so slipping it slips the whole plan. */
  critical: boolean
  /** Total size of the longest chain ending here, this card included. */
  earliest_finish: number
}

/** Unsized cards still occupy a position; zero would collapse them into one. */
const DEFAULT_SIZE = 1

interface IRow {
  id: string
  key: string
  title: string
  list: string
  completed: number
  archived: number
  size: number | null
  is_milestone: number
}

/**
 * Order the cards of one space.
 *
 * Done and archived cards are dropped before sequencing rather than after: a
 * plan is about what is left, and a finished card that still blocked its
 * successors would hold the whole chain back forever.
 */
export async function sequenceGet(
  ctx: ICtx,
  spaceKey: string,
): Promise<{ nodes: ISequenceNode[]; layers: number; critical_size: number }> {
  const space = (
    await ctx.db.query<{ id: string }>(
      'SELECT id FROM space WHERE workspace_id = ? AND key = ?',
      [ctx.workspaceId, spaceKey],
    )
  )[0]
  if (!space) throw new ApiError(404, `space ${spaceKey} not found`)

  const rows = await ctx.db.query<IRow>(
    `SELECT i.id, i.key, i.title, l.name AS list, i.completed, i.archived,
            i.size, i.is_milestone
       FROM item i JOIN list l ON l.id = i.list_id
      WHERE i.space_id = ? AND i.archived = 0 AND i.completed = 0
      ORDER BY i.pos`,
    [space.id],
  )
  if (rows.length === 0) return { nodes: [], layers: 0, critical_size: 0 }

  const byId = new Map(rows.map((r) => [r.id, r]))
  const edges = (
    await ctx.db.query<{ blocker_id: string; blocked_id: string }>(
      `SELECT blocker_id, blocked_id FROM item_dependency WHERE workspace_id = ?`,
      [ctx.workspaceId],
    )
  ).filter((e) => byId.has(e.blocker_id) && byId.has(e.blocked_id))

  const blockedBy = new Map<string, string[]>()
  const blocks = new Map<string, string[]>()
  for (const r of rows) {
    blockedBy.set(r.id, [])
    blocks.set(r.id, [])
  }
  for (const e of edges) {
    blockedBy.get(e.blocked_id)!.push(e.blocker_id)
    blocks.get(e.blocker_id)!.push(e.blocked_id)
  }

  // Kahn's algorithm: repeatedly take everything with nothing left blocking
  // it. Each pass is one layer, which is what "can start now" means.
  const remaining = new Map(
    rows.map((r) => [r.id, blockedBy.get(r.id)!.length]),
  )
  const layerOf = new Map<string, number>()
  let frontier = rows.filter((r) => remaining.get(r.id) === 0).map((r) => r.id)
  let layer = 0
  let ordered = 0
  while (frontier.length > 0) {
    const next: string[] = []
    for (const id of frontier) {
      layerOf.set(id, layer)
      ordered++
      for (const child of blocks.get(id)!) {
        const left = remaining.get(child)! - 1
        remaining.set(child, left)
        if (left === 0) next.push(child)
      }
    }
    frontier = next
    layer++
  }

  // Anything never reached is in a cycle. Refused rather than drawn, because
  // a plan containing one has no order and half a plan is worse than none.
  if (ordered < rows.length) {
    const stuck = rows.filter((r) => !layerOf.has(r.id)).map((r) => r.key)
    throw new ApiError(
      409,
      `dependencies form a cycle through ${stuck.slice(0, 6).join(', ')}`,
    )
  }

  // Longest chain by size ending at each card. Layer order guarantees every
  // blocker is finished before the card that waits on it.
  const finish = new Map<string, number>()
  const cameFrom = new Map<string, string | null>()
  const inLayerOrder = [...rows].sort(
    (a, b) => layerOf.get(a.id)! - layerOf.get(b.id)!,
  )
  for (const r of inLayerOrder) {
    let best = 0
    let from: string | null = null
    for (const parent of blockedBy.get(r.id)!) {
      const via = finish.get(parent) ?? 0
      if (via > best) {
        best = via
        from = parent
      }
    }
    finish.set(r.id, best + (r.size ?? DEFAULT_SIZE))
    cameFrom.set(r.id, from)
  }

  // Walk back from the furthest finish to mark the route that decides it.
  const critical = new Set<string>()
  let tip: string | null = null
  let longest = 0
  for (const [id, f] of finish) {
    if (f > longest) {
      longest = f
      tip = id
    }
  }
  while (tip) {
    critical.add(tip)
    tip = cameFrom.get(tip) ?? null
  }

  const keyOf = (id: string) => byId.get(id)!.key
  const nodes: ISequenceNode[] = []
  for (const r of rows) {
    const assignees = (
      await ctx.db.query<{ handle: string }>(
        `SELECT a.handle FROM item_assignee ia JOIN actor a ON a.id = ia.actor_id
          WHERE ia.item_id = ?`,
        [r.id],
      )
    ).map((x) => x.handle)
    const labels = (
      await ctx.db.query<{ name: string }>(
        `SELECT lb.name FROM item_label il JOIN label lb ON lb.id = il.label_id
          WHERE il.item_id = ?`,
        [r.id],
      )
    ).map((x) => x.name)
    nodes.push({
      key: r.key,
      title: r.title,
      list: r.list,
      status: r.archived ? 'archived' : r.completed ? 'done' : 'open',
      assignees,
      labels,
      size: r.size,
      is_milestone: r.is_milestone === 1,
      layer: layerOf.get(r.id)!,
      blocked_by: blockedBy.get(r.id)!.map(keyOf),
      blocks: blocks.get(r.id)!.map(keyOf),
      critical: critical.has(r.id),
      earliest_finish: finish.get(r.id)!,
    })
  }
  nodes.sort((a, b) => a.layer - b.layer || b.blocks.length - a.blocks.length)
  return { nodes, layers: layer, critical_size: longest }
}
