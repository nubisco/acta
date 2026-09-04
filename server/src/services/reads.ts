/**
 * Read services (design-spec §4): compact by default, counts instead of
 * blobs, cursor pagination, delta reads.
 */

import type { z } from 'zod'
import type {
  zActivityQuery,
  zBoardGet,
  zItemGet,
  zSearch,
} from '@nubisco/acta-shared'
import type { ICtx } from '../core/ctx'
import { docBySlug, boardByKey, itemByKey, type IItemRow } from '../core/store'
import { sectionMap } from '@nubisco/acta-shared'

type TBoardGet = z.infer<typeof zBoardGet>
type TItemGet = z.infer<typeof zItemGet>
type TSearch = z.infer<typeof zSearch>
type TActivityQuery = z.infer<typeof zActivityQuery>

// --------------------------------------------------------------------------
// workspace_overview
// --------------------------------------------------------------------------

export async function workspaceOverview(ctx: ICtx) {
  const ws = (
    await ctx.db.query<{ id: string; name: string }>(
      'SELECT id, name FROM workspace WHERE id = ?',
      [ctx.workspaceId],
    )
  )[0]
  const boards = await ctx.db.query<{
    key: string
    name: string
    archived: number
    id: string
  }>(
    'SELECT id, key, name, archived FROM board WHERE workspace_id = ? ORDER BY key',
    [ctx.workspaceId],
  )
  const lists = await ctx.db.query<{
    board_id: string
    id: string
    name: string
    role: string
    items: number
  }>(
    `SELECT l.board_id, l.id, l.name, l.role,
            (SELECT COUNT(*) FROM item i WHERE i.list_id = l.id AND i.archived = 0) AS items
       FROM list l WHERE l.workspace_id = ? AND l.archived = 0 ORDER BY l.board_id, l.pos`,
    [ctx.workspaceId],
  )
  const labels = await ctx.db.query<{
    group_name: string
    board_key: string | null
    id: string
    name: string
    color: string
  }>(
    `SELECT g.name AS group_name, b.key AS board_key, l.id, l.name, l.color
       FROM label l JOIN label_group g ON g.id = l.group_id
       LEFT JOIN board b ON b.id = g.board_id
      WHERE l.workspace_id = ? ORDER BY g.name, l.name`,
    [ctx.workspaceId],
  )
  const actors = await ctx.db.query<{
    id: string
    handle: string
    kind: string
    name: string
  }>(
    'SELECT id, handle, kind, name FROM actor WHERE workspace_id = ? AND disabled = 0 ORDER BY handle',
    [ctx.workspaceId],
  )
  const docRoots = await ctx.db.query<{
    slug: string
    title: string
    children: number
  }>(
    `SELECT d.slug, d.title,
            (SELECT COUNT(*) FROM document c WHERE c.parent_id = d.id AND c.archived = 0) AS children
       FROM document d WHERE d.workspace_id = ? AND d.parent_id IS NULL AND d.archived = 0
      ORDER BY d.pos`,
    [ctx.workspaceId],
  )
  return {
    workspace: { id: ws.id, name: ws.name },
    boards: boards.map((b) => ({
      key: b.key,
      name: b.name,
      archived: b.archived === 1 || undefined,
      lists: lists
        .filter((l) => l.board_id === b.id)
        .map((l) => ({
          id: l.id,
          name: l.name,
          role: l.role === 'none' ? undefined : l.role,
          items: l.items,
        })),
    })),
    labels,
    actors,
    doc_roots: docRoots,
  }
}

// --------------------------------------------------------------------------
// board_get
// --------------------------------------------------------------------------

export async function boardGet(ctx: ICtx, params: TBoardGet) {
  const board = await boardByKey(ctx, params.board)
  const where: string[] = ['i.board_id = ?']
  const args: unknown[] = [board.id]

  if (params.state === 'open') where.push('i.archived = 0')
  else if (params.state === 'archived') where.push('i.archived = 1')
  else if (params.state === 'done')
    where.push('i.completed = 1 AND i.archived = 0')

  if (params.list) {
    where.push('(l.id = ? OR lower(l.name) = lower(?))')
    args.push(params.list, params.list)
  }
  if (params.updated_since) {
    where.push('i.updated_at > ?')
    args.push(params.updated_since)
  }
  if (params.text) {
    where.push('(i.title LIKE ? OR i.description LIKE ?)')
    args.push(`%${params.text}%`, `%${params.text}%`)
  }
  if (params.label) {
    where.push(
      `EXISTS (SELECT 1 FROM item_label il JOIN label lb ON lb.id = il.label_id
               WHERE il.item_id = i.id AND (lb.id = ? OR lower(lb.name) = lower(?)))`,
    )
    args.push(params.label, params.label)
  }
  if (params.assignee) {
    where.push(
      `EXISTS (SELECT 1 FROM item_assignee ia JOIN actor a ON a.id = ia.actor_id
               WHERE ia.item_id = i.id AND (a.id = ? OR a.handle = ?))`,
    )
    args.push(params.assignee, params.assignee)
  }
  if (params.cursor) {
    where.push('i.key > ?')
    args.push(params.cursor)
  }

  const rows = await ctx.db.query<
    IItemRow & {
      list_name: string
      labels: string | null
      assignees: string | null
      cmts: number
      chk_done: number
      chk_total: number
    }
  >(
    `SELECT i.*, l.name AS list_name,
            (SELECT GROUP_CONCAT(lb.name) FROM item_label il JOIN label lb ON lb.id = il.label_id WHERE il.item_id = i.id) AS labels,
            (SELECT GROUP_CONCAT(a.handle) FROM item_assignee ia JOIN actor a ON a.id = ia.actor_id WHERE ia.item_id = i.id) AS assignees,
            (SELECT COUNT(*) FROM comment c WHERE c.item_id = i.id) AS cmts,
            (SELECT COUNT(*) FROM checklist_item ci JOIN checklist ch ON ch.id = ci.checklist_id WHERE ch.item_id = i.id AND ci.done = 1) AS chk_done,
            (SELECT COUNT(*) FROM checklist_item ci JOIN checklist ch ON ch.id = ci.checklist_id WHERE ch.item_id = i.id) AS chk_total
       FROM item i JOIN list l ON l.id = i.list_id
      WHERE ${where.join(' AND ')}
      ORDER BY i.key LIMIT ?`,
    [...args, params.limit + 1],
  )

  const page = rows.slice(0, params.limit)
  const items = page.map((r) => ({
    key: r.key,
    title: r.title,
    list: r.list_name,
    labels: r.labels ? r.labels.split(',') : undefined,
    assignees: r.assignees ? r.assignees.split(',') : undefined,
    due: r.due ?? undefined,
    done: r.completed === 1 || undefined,
    archived: r.archived === 1 || undefined,
    cmts: r.cmts || undefined,
    chk: r.chk_total > 0 ? `${r.chk_done}/${r.chk_total}` : undefined,
    rev: r.rev,
    updated: r.updated_at,
    pos: r.pos,
    description: params.detail === 'full' ? r.description : undefined,
  }))

  return {
    board: { key: board.key, name: board.name },
    items,
    cursor: rows.length > params.limit ? page[page.length - 1].key : undefined,
  }
}

// --------------------------------------------------------------------------
// item_get (batch)
// --------------------------------------------------------------------------

export async function itemGet(ctx: ICtx, params: TItemGet) {
  const include = new Set(
    params.include ?? ['comments', 'checklists', 'links', 'attachments'],
  )
  const items = []
  for (const key of params.keys) {
    const item = await itemByKey(ctx, key)
    const boardKey = (
      await ctx.db.query<{ key: string }>(
        'SELECT key FROM board WHERE id = ?',
        [item.board_id],
      )
    )[0].key
    const listName = (
      await ctx.db.query<{ name: string }>(
        'SELECT name FROM list WHERE id = ?',
        [item.list_id],
      )
    )[0].name
    const labels = (
      await ctx.db.query<{ name: string }>(
        'SELECT lb.name FROM item_label il JOIN label lb ON lb.id = il.label_id WHERE il.item_id = ?',
        [item.id],
      )
    ).map((r) => r.name)
    const assignees = (
      await ctx.db.query<{ handle: string }>(
        'SELECT a.handle FROM item_assignee ia JOIN actor a ON a.id = ia.actor_id WHERE ia.item_id = ?',
        [item.id],
      )
    ).map((r) => r.handle)

    const out: Record<string, unknown> = {
      key: item.key,
      board: boardKey,
      list: listName,
      title: item.title,
      description: item.description,
      labels: labels.length > 0 ? labels : undefined,
      assignees: assignees.length > 0 ? assignees : undefined,
      due: item.due ?? undefined,
      done: item.completed === 1 || undefined,
      archived: item.archived === 1 || undefined,
      rev: item.rev,
      created: item.created_at,
      updated: item.updated_at,
    }
    if (include.has('comments')) {
      out.comments = (
        await ctx.db.query<{
          id: string
          body: string
          created_at: number
          handle: string
          kind: string
        }>(
          `SELECT c.id, c.body, c.created_at, a.handle, a.kind FROM comment c
             JOIN actor a ON a.id = c.actor_id WHERE c.item_id = ? ORDER BY c.created_at`,
          [item.id],
        )
      ).map((c) => ({
        id: c.id,
        by: c.handle,
        agent: c.kind === 'agent' || undefined,
        ts: c.created_at,
        body: c.body,
      }))
    }
    if (include.has('checklists')) {
      const checklists = await ctx.db.query<{ id: string; name: string }>(
        'SELECT id, name FROM checklist WHERE item_id = ? ORDER BY pos',
        [item.id],
      )
      const withItems = []
      for (const cl of checklists) {
        withItems.push({
          name: cl.name,
          items: (
            await ctx.db.query<{ text: string; done: number }>(
              'SELECT text, done FROM checklist_item WHERE checklist_id = ? ORDER BY pos',
              [cl.id],
            )
          ).map((ci) => ({ text: ci.text, done: ci.done === 1 })),
        })
      }
      out.checklists = withItems
    }
    if (include.has('links')) {
      out.links = {
        out: await ctx.db.query<{ ref_type: string; target: string }>(
          "SELECT ref_type, target FROM link WHERE src_kind = 'item' AND src_id = ?",
          [item.id],
        ),
        in: await ctx.db.query<{ src_kind: string; src_id: string }>(
          "SELECT src_kind, src_id FROM link WHERE workspace_id = ? AND ref_type = 'item' AND target = ?",
          [ctx.workspaceId, item.key],
        ),
      }
    }
    if (include.has('attachments')) {
      out.attachments = await ctx.db.query<{
        id: string
        kind: string
        filename: string
        url: string | null
        size: number | null
      }>(
        "SELECT id, kind, filename, url, size FROM attachment WHERE owner_kind = 'item' AND owner_id = ?",
        [item.id],
      )
    }
    if (include.has('activity')) {
      out.activity = await ctx.db.query<{
        ts: number
        verb: string
        summary: string
        actor_kind: string
      }>(
        "SELECT ts, verb, summary, actor_kind FROM event WHERE entity = 'item' AND entity_id = ? ORDER BY id DESC LIMIT 20",
        [item.id],
      )
    }
    items.push(out)
  }
  return { items }
}

// --------------------------------------------------------------------------
// doc_tree / doc_get
// --------------------------------------------------------------------------

export async function docTree(ctx: ICtx, root?: string, depth = 10) {
  interface INode {
    id: string
    slug: string
    title: string
    parent_id: string | null
    rev: number
    updated_at: number
  }
  const all = await ctx.db.query<INode>(
    'SELECT id, slug, title, parent_id, rev, updated_at FROM document WHERE workspace_id = ? AND archived = 0 ORDER BY pos',
    [ctx.workspaceId],
  )
  const rootNode = root ? all.find((d) => d.slug === root) : undefined
  const out: {
    slug: string
    title: string
    depth: number
    rev: number
    updated: number
  }[] = []
  const walk = (parentId: string | null, level: number) => {
    if (level > depth) return
    for (const node of all.filter((d) => d.parent_id === parentId)) {
      out.push({
        slug: node.slug,
        title: node.title,
        depth: level,
        rev: node.rev,
        updated: node.updated_at,
      })
      walk(node.id, level + 1)
    }
  }
  walk(rootNode?.id ?? null, 0)
  return { docs: out }
}

export async function docGet(
  ctx: ICtx,
  ref: string,
  opts: { at_version?: number; include?: string[] } = {},
) {
  const doc = await docBySlug(ctx, ref)
  const include = new Set(opts.include ?? [])
  let body = doc.body
  let rev = doc.rev
  if (opts.at_version !== undefined) {
    const v = await ctx.db.query<{ body: string; rev: number }>(
      'SELECT body, rev FROM doc_version WHERE document_id = ? AND rev = ?',
      [doc.id, opts.at_version],
    )
    if (v.length > 0) {
      body = v[0].body
      rev = v[0].rev
    }
  }
  const out: Record<string, unknown> = {
    slug: doc.slug,
    title: doc.title,
    layout: doc.layout === 'wide' ? 'wide' : undefined,
    tags: JSON.parse(doc.tags),
    rev,
    updated: doc.updated_at,
    body,
  }
  if (include.has('sections')) {
    out.sections = sectionMap(body).map((s) => ({
      slug: s.slug,
      level: s.level,
      hash: s.hash,
    }))
  }
  if (include.has('backlinks')) {
    out.backlinks = await ctx.db.query<{ src_kind: string; src_id: string }>(
      "SELECT src_kind, src_id FROM link WHERE workspace_id = ? AND ref_type = 'doc' AND target = ?",
      [ctx.workspaceId, doc.slug],
    )
  }
  if (include.has('versions')) {
    out.versions = await ctx.db.query<{
      rev: number
      created_at: number
      handle: string
    }>(
      `SELECT v.rev, v.created_at, a.handle FROM doc_version v JOIN actor a ON a.id = v.actor_id
        WHERE v.document_id = ? ORDER BY v.rev DESC LIMIT 50`,
      [doc.id],
    )
  }
  return out
}

// --------------------------------------------------------------------------
// search / activity
// --------------------------------------------------------------------------

export async function search(ctx: ICtx, params: TSearch) {
  const types = params.types ?? ['item', 'doc', 'comment']
  const args: unknown[] = [params.query]
  let filter = `kind IN (${types.map(() => '?').join(',')})`
  args.push(...types)
  if (params.board) {
    filter += ' AND board_key = ?'
    args.push(params.board)
  }
  const rows = await ctx.db.query<{
    kind: string
    ref: string
    title: string
    snippet: string
    board_key: string
  }>(
    `SELECT kind, ref, title, board_key, snippet(fts, 3, '<<', '>>', '...', 12) AS snippet
       FROM fts WHERE fts MATCH ? AND ${filter} LIMIT ?`,
    [...args, params.limit],
  )
  return {
    results: rows.map((r) => ({
      type: r.kind,
      ref: r.ref,
      title: r.title,
      snippet: r.snippet,
      board: r.board_key || undefined,
    })),
  }
}

export async function activityQuery(ctx: ICtx, params: TActivityQuery) {
  const where: string[] = ['workspace_id = ?']
  const args: unknown[] = [ctx.workspaceId]
  if (params.entity) {
    where.push('(entity = ? OR entity_id = ?)')
    args.push(params.entity, params.entity)
  }
  if (params.actor) {
    where.push('actor_id = ?')
    args.push(params.actor)
  }
  if (params.actor_kind) {
    where.push('actor_kind = ?')
    args.push(params.actor_kind)
  }
  if (params.verb) {
    where.push('verb LIKE ?')
    args.push(params.verb.replace('*', '%'))
  }
  if (params.since) {
    where.push('id > ?')
    args.push(params.since)
  }
  if (params.cursor) {
    where.push('id < ?')
    args.push(params.cursor)
  }
  const rows = await ctx.db.query<{
    id: string
    ts: number
    actor_id: string
    actor_kind: string
    on_behalf_of: string | null
    verb: string
    entity: string
    entity_id: string
    summary: string
    caused_by: string | null
  }>(
    `SELECT id, ts, actor_id, actor_kind, on_behalf_of, verb, entity, entity_id, summary, caused_by
       FROM event WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
    [...args, params.limit],
  )
  return {
    events: rows,
    cursor: rows.length === params.limit ? rows[rows.length - 1].id : undefined,
  }
}
