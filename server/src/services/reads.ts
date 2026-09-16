/**
 * Read services (design-spec §4): compact by default, counts instead of
 * blobs, cursor pagination, delta reads.
 */

import type { z } from 'zod'
import type {
  zActivityQuery,
  zSpaceGet,
  zItemGet,
  zSearch,
} from '@nubisco/acta-shared'
import { now, type ICtx } from '../core/ctx'
import { docBySlug, spaceByKey, itemByKey, type IItemRow } from '../core/store'
import { anchorStatus, parseAnchor } from './anchors'
import { attachmentUrl } from './attachments'
import { anchorTextFromMarkdown, sectionMap } from '@nubisco/acta-shared'

type TSpaceGet = z.infer<typeof zSpaceGet>
type TItemGet = z.infer<typeof zItemGet>
type TSearch = z.infer<typeof zSearch>
type TActivityQuery = z.infer<typeof zActivityQuery>

/** Stored provenance JSON → response object; absent/invalid → undefined. */
function parseImportedMeta(
  raw: string | null | undefined,
): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return undefined
  }
}

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
  const spaces = await ctx.db.query<{
    key: string
    name: string
    archived: number
    id: string
    starred: number
  }>(
    `SELECT b.id, b.key, b.name, b.archived,
            EXISTS (SELECT 1 FROM space_star s
                     WHERE s.space_id = b.id AND s.actor_id = ?) AS starred
       FROM space b WHERE b.workspace_id = ? ORDER BY b.key`,
    [ctx.actor.id, ctx.workspaceId],
  )
  const lists = await ctx.db.query<{
    space_id: string
    id: string
    name: string
    role: string
    items: number
  }>(
    `SELECT l.space_id, l.id, l.name, l.role,
            (SELECT COUNT(*) FROM item i WHERE i.list_id = l.id AND i.archived = 0) AS items
       FROM list l WHERE l.workspace_id = ? AND l.archived = 0 ORDER BY l.space_id, l.pos`,
    [ctx.workspaceId],
  )
  const labels = await ctx.db.query<{
    group_name: string
    space_key: string | null
    id: string
    name: string
    color: string
  }>(
    `SELECT g.name AS group_name, b.key AS space_key, l.id, l.name, l.color
       FROM label l JOIN label_group g ON g.id = l.group_id
       LEFT JOIN space b ON b.id = g.space_id
      WHERE l.workspace_id = ? ORDER BY g.name, l.name`,
    [ctx.workspaceId],
  )
  const actors = await ctx.db.query<{
    id: string
    handle: string
    kind: string
    name: string
    role: string
    avatar_url: string | null
  }>(
    'SELECT id, handle, kind, name, role, avatar_url FROM actor WHERE workspace_id = ? AND disabled = 0 ORDER BY handle',
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
    spaces: spaces.map((b) => ({
      key: b.key,
      name: b.name,
      archived: b.archived === 1 || undefined,
      starred: b.starred === 1 || undefined,
      lists: lists
        .filter((l) => l.space_id === b.id)
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
// space_get
// --------------------------------------------------------------------------

export async function spaceGet(ctx: ICtx, params: TSpaceGet) {
  const space = await spaceByKey(ctx, params.space)
  const where: string[] = ['i.space_id = ?']
  const args: unknown[] = [space.id]

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
    // Several labels mean "any of these", the way Jira and Trello read a
    // multi-select filter. Comma separated so a single value is still the
    // same request it always was.
    const labels = params.label
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean)
    if (labels.length > 0) {
      const clause = labels
        .map(() => '(lb.id = ? OR lower(lb.name) = lower(?))')
        .join(' OR ')
      where.push(
        `EXISTS (SELECT 1 FROM item_label il JOIN label lb ON lb.id = il.label_id
                 WHERE il.item_id = i.id AND (${clause}))`,
      )
      for (const label of labels) args.push(label, label)
    }
  }
  if (params.assignee) {
    // Comma separated and "any of these", exactly like `label` above. The
    // space filters people by avatar now, and an avatar row you can only
    // pick one of is a radio group wearing the wrong clothes.
    const handles = params.assignee
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
    if (handles.length > 0) {
      const clause = handles
        .map(() => '(a.id = ? OR a.handle = ?)')
        .join(' OR ')
      where.push(
        `EXISTS (SELECT 1 FROM item_assignee ia JOIN actor a ON a.id = ia.actor_id
                 WHERE ia.item_id = i.id AND (${clause}))`,
      )
      for (const handle of handles) args.push(handle, handle)
    }
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
    // The timeline needs somewhere for a bar to start. Without it every card
    // would be a milestone on its due date, which is a worse chart and a less
    // true one.
    created: r.created_at,
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
    space: { key: space.key, name: space.name },
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
    const spaceKey = (
      await ctx.db.query<{ key: string }>(
        'SELECT key FROM space WHERE id = ?',
        [item.space_id],
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
      space: spaceKey,
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
      imported: parseImportedMeta(item.imported_meta),
      size: item.size ?? undefined,
      is_milestone: item.is_milestone === 1 || undefined,
    }

    // Always, not behind `include`. What a card waits on is part of what the
    // card IS, and the sequence view was showing it while the card itself
    // said nothing, which reads as two different sources of truth.
    out.blocked_by = (
      await ctx.db.query<{ key: string; title: string; completed: number }>(
        `SELECT b.key, b.title, b.completed FROM item_dependency d
           JOIN item b ON b.id = d.blocker_id
          WHERE d.blocked_id = ? ORDER BY b.key`,
        [item.id],
      )
    ).map((r) => ({ key: r.key, title: r.title, done: r.completed === 1 }))
    out.blocks = (
      await ctx.db.query<{ key: string; title: string; completed: number }>(
        `SELECT b.key, b.title, b.completed FROM item_dependency d
           JOIN item b ON b.id = d.blocked_id
          WHERE d.blocker_id = ? ORDER BY b.key`,
        [item.id],
      )
    ).map((r) => ({ key: r.key, title: r.title, done: r.completed === 1 }))

    if (include.has('comments')) {
      out.comments = (
        await ctx.db.query<{
          id: string
          body: string
          created_at: number
          handle: string
          kind: string
          imported_meta: string | null
        }>(
          `SELECT c.id, c.body, c.created_at, a.handle, a.kind, c.imported_meta FROM comment c
             JOIN actor a ON a.id = c.actor_id WHERE c.item_id = ? ORDER BY c.created_at`,
          [item.id],
        )
      ).map((c) => ({
        id: c.id,
        by: c.handle,
        agent: c.kind === 'agent' || undefined,
        ts: c.created_at,
        body: c.body,
        imported: parseImportedMeta(c.imported_meta),
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
      out.attachments = await attachmentsFor(ctx, 'item', item.id)
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
    'SELECT id, slug, title, parent_id, rev, updated_at FROM document WHERE workspace_id = ? AND archived = 0 ORDER BY pos, id',
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
  // Each page is listed at most once. Moves refuse a cycle now, but a parent
  // chain that already loops (left by an older build) would otherwise repeat
  // for as long as `depth` allows, and `depth` comes straight from a query
  // string, where `NaN` never compares greater than anything.
  const visited = new Set<string>()
  const walk = (parentId: string | null, level: number) => {
    if (level > depth) return
    for (const node of all.filter((d) => d.parent_id === parentId)) {
      if (visited.has(node.id)) continue
      visited.add(node.id)
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

/**
 * Attachments on one owner, with the address each is reachable at.
 *
 * `url` used to be whatever was in the column, which is the external address
 * for a link attachment and NULL for an uploaded file. A caller therefore had
 * no way to display or embed a file it could see listed. An upload now
 * reports where it is served from.
 *
 * `mime` is included because it is what decides whether something renders as
 * an image or as a chip you can download, and a reader cannot tell from an
 * id.
 */
async function attachmentsFor(
  ctx: ICtx,
  ownerKind: 'item' | 'doc',
  ownerId: string,
) {
  const rows = await ctx.db.query<{
    id: string
    kind: string
    filename: string
    mime: string | null
    url: string | null
    size: number | null
  }>(
    'SELECT id, kind, filename, mime, url, size FROM attachment WHERE owner_kind = ? AND owner_id = ? ORDER BY created_at',
    [ownerKind, ownerId],
  )
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    filename: r.filename,
    mime: r.mime ?? undefined,
    size: r.size ?? undefined,
    url: r.url ?? attachmentUrl(r.id),
  }))
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
    imported: parseImportedMeta(doc.imported_meta),
  }
  // Always, not behind `include`. A document's body can embed an attachment,
  // so a reader that has the body but not the attachment list cannot render
  // what the body refers to.
  out.attachments = await attachmentsFor(ctx, 'doc', doc.id)
  if (include.has('comments')) {
    let anchorText: string | null = null
    out.comments = (
      await ctx.db.query<{
        id: string
        body: string
        created_at: number
        handle: string
        kind: string
        imported_meta: string | null
        anchor: string | null
        resolved_at: number | null
        resolved_handle: string | null
      }>(
        `SELECT c.id, c.body, c.created_at, a.handle, a.kind, c.imported_meta,
                c.anchor, c.resolved_at, r.handle AS resolved_handle
           FROM doc_comment c
           JOIN actor a ON a.id = c.actor_id
           LEFT JOIN actor r ON r.id = c.resolved_by
          WHERE c.document_id = ? ORDER BY c.created_at`,
        [doc.id],
      )
    ).map((c) => {
      const anchor = parseAnchor(c.anchor)
      // Projected once for the whole thread, and only if something needs it.
      if (anchor && anchorText === null)
        anchorText = anchorTextFromMarkdown(body)
      return {
        id: c.id,
        by: c.handle,
        agent: c.kind === 'agent' || undefined,
        ts: c.created_at,
        body: c.body,
        imported: parseImportedMeta(c.imported_meta),
        // Against the body being returned, so a comment read at an old
        // version reports whether it anchors in that version.
        anchor: anchor ?? undefined,
        anchor_status: anchor
          ? anchorStatus(anchorText ?? '', anchor)
          : undefined,
        resolved:
          c.resolved_at !== null
            ? { ts: c.resolved_at, by: c.resolved_handle ?? undefined }
            : undefined,
      }
    })
  }
  if (include.has('sections')) {
    out.sections = sectionMap(body).map((s) => ({
      slug: s.slug,
      level: s.level,
      hash: s.hash,
    }))
  }
  if (include.has('backlinks')) {
    // Resolved to something a person can read. The link table stores internal
    // ids, and returning those unchanged put rows like
    // "item  itm_01m2gaz92142arwky3srvkw0pd" under "Referenced by", which
    // tells a reader nothing and is not even clickable. The label is the card
    // key or the document title; the raw id stays for callers that want it.
    out.backlinks = await ctx.db.query<{
      src_kind: string
      src_id: string
      ref: string | null
      label: string | null
    }>(
      `SELECT l.src_kind, l.src_id,
              CASE l.src_kind
                WHEN 'item' THEN i.key
                WHEN 'doc' THEN d.slug
                WHEN 'comment' THEN ci.key
              END AS ref,
              CASE l.src_kind
                WHEN 'item' THEN i.title
                WHEN 'doc' THEN d.title
                WHEN 'comment' THEN ci.title
              END AS label
         FROM link l
         LEFT JOIN item i ON l.src_kind = 'item' AND i.id = l.src_id
         LEFT JOIN document d ON l.src_kind = 'doc' AND d.id = l.src_id
         LEFT JOIN comment c ON l.src_kind = 'comment' AND c.id = l.src_id
         LEFT JOIN item ci ON ci.id = c.item_id
        WHERE l.workspace_id = ? AND l.ref_type = 'doc' AND l.target = ?`,
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

/**
 * User input is not FTS5 syntax: a card key like LA-335 parses as
 * "LA NOT 335" and free text with quotes or parens throws. Every token is
 * quoted (AND semantics), and the last becomes a prefix match so search-as-
 * you-type sees results before a word is finished. Keys still hit because
 * the tokenizer splits the indexed ref column the same way.
 */
function ftsMatchExpr(raw: string): string | null {
  const tokens = raw
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (tokens.length === 0) return null
  return tokens
    .map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`))
    .join(' ')
}

export async function search(ctx: ICtx, params: TSearch) {
  const match = ftsMatchExpr(params.query)
  if (!match) return { results: [] }
  const types = params.types ?? ['item', 'doc', 'comment']
  const args: unknown[] = [match]
  let filter = `kind IN (${types.map(() => '?').join(',')})`
  args.push(...types)
  if (params.space) {
    filter += ' AND space_key = ?'
    args.push(params.space)
  }
  const rows = await ctx.db.query<{
    kind: string
    ref: string
    title: string
    snippet: string
    space_key: string
  }>(
    `SELECT kind, ref, title, space_key, snippet(fts, 3, '<<', '>>', '...', 12) AS snippet
       FROM fts WHERE fts MATCH ? AND ${filter} LIMIT ?`,
    [...args, params.limit],
  )
  return {
    results: rows.map((r) => ({
      type: r.kind,
      ref: r.ref,
      title: r.title,
      snippet: r.snippet,
      space: r.space_key || undefined,
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
    // Several actors mean "any of these", so a row of avatars can filter to a
    // few people at once rather than one at a time. A handle is accepted
    // alongside an id because that is what a URL is likely to carry.
    const actors = params.actor
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
    if (actors.length > 0) {
      const clause = actors
        .map(
          () =>
            '(actor_id = ? OR actor_id IN (SELECT id FROM actor WHERE workspace_id = ? AND handle = ?))',
        )
        .join(' OR ')
      where.push(`(${clause})`)
      for (const actor of actors) args.push(actor, ctx.workspaceId, actor)
    }
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

/** A week out is close enough to act on and far enough to plan around. */
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000

// --------------------------------------------------------------------------
// my_work
// --------------------------------------------------------------------------

export interface IMyWorkItem {
  key: string
  title: string
  space: string
  space_key: string
  list: string
  due?: number
  overdue?: boolean
  completed?: boolean
  reason?: string
  at?: number
}

export interface IMyWork {
  assigned: IMyWorkItem[]
  due: IMyWorkItem[]
  mentions: IMyWorkItem[]
  recent: IMyWorkItem[]
}

/**
 * What one person should probably look at, across every space.
 *
 * Every other item read here is scoped to a single space, which is right for
 * a board and useless for the question people actually arrive with, which is
 * "what is mine". Home showed spaces and a workspace activity feed, neither
 * of which answers it: a grid of boards is a filing cabinet, and an activity
 * feed is everything everyone did.
 *
 * Four buckets, deliberately small and capped. This runs on every visit to
 * Home, so it is four indexed reads rather than one query that tries to rank
 * everything against everything.
 */
export async function myWork(ctx: ICtx, limit = 8): Promise<IMyWork> {
  const actorId = ctx.actor.id
  const today = now()

  const base = `SELECT i.key, i.title, i.due, i.completed,
                       s.key AS space_key, s.name AS space, l.name AS list
                  FROM item i
                  JOIN space s ON s.id = i.space_id
                  JOIN list l ON l.id = i.list_id`

  type TRow = {
    key: string
    title: string
    due: number | null
    completed: number
    space_key: string
    space: string
    list: string
  }

  const shape = (r: TRow): IMyWorkItem => ({
    key: r.key,
    title: r.title,
    space: r.space,
    space_key: r.space_key,
    list: r.list,
    due: r.due ?? undefined,
    // Computed here rather than in the browser, so "overdue" is decided
    // against one clock instead of whatever the viewer's machine believes.
    overdue: r.due !== null && r.due < today ? true : undefined,
    completed: r.completed === 1 || undefined,
  })

  const assigned = await ctx.db.query<TRow>(
    `${base}
      WHERE i.workspace_id = ? AND i.archived = 0 AND i.completed = 0
        AND EXISTS (SELECT 1 FROM item_assignee ia
                     WHERE ia.item_id = i.id AND ia.actor_id = ?)
      ORDER BY CASE WHEN i.due IS NULL THEN 1 ELSE 0 END, i.due, i.updated_at DESC
      LIMIT ?`,
    [ctx.workspaceId, actorId, limit],
  )

  /**
   * Dated work, whoever holds it. Assignment is how work is yours, but a
   * milestone nobody is on still lands on the same day, and a due list that
   * only shows what is already assigned hides exactly the ones about to be
   * missed.
   */
  const dueSoon = await ctx.db.query<TRow>(
    `${base}
      WHERE i.workspace_id = ? AND i.archived = 0 AND i.completed = 0
        AND i.due IS NOT NULL AND i.due <= ?
      ORDER BY i.due
      LIMIT ?`,
    [ctx.workspaceId, today + SEVEN_DAYS, limit],
  )

  /**
   * Mentions still waiting on this person.
   *
   * Unread is the proxy for unanswered: reading the notification is the act
   * of having seen it, and anything cleverer (did they reply, did they react)
   * needs state nothing writes today.
   */
  const mentionRows = await ctx.db.query<TRow & { reason: string; at: number }>(
    `SELECT i.key, i.title, i.due, i.completed,
            s.key AS space_key, s.name AS space, l.name AS list,
            n.reason, n.created_at AS at
       FROM notification n
       JOIN item i ON i.key = n.item_key AND i.workspace_id = n.workspace_id
       JOIN space s ON s.id = i.space_id
       JOIN list l ON l.id = i.list_id
      WHERE n.workspace_id = ? AND n.actor_id = ? AND n.read_at IS NULL
        AND n.reason = 'mention' AND i.archived = 0
      ORDER BY n.created_at DESC
      LIMIT ?`,
    [ctx.workspaceId, actorId, limit],
  )

  /**
   * Where this person left off.
   *
   * Touched, not viewed. Nothing records a view, and adding a write on every
   * card open to find out would cost more than the row is worth. Having
   * edited something is the stronger signal anyway: it means work, where
   * opening a card can mean a mis-click.
   */
  const recent = await ctx.db.query<TRow & { at: number }>(
    `SELECT i.key, i.title, i.due, i.completed,
            s.key AS space_key, s.name AS space, l.name AS list,
            MAX(e.ts) AS at
       FROM event e
       JOIN item i ON i.id = e.entity_id
       JOIN space s ON s.id = i.space_id
       JOIN list l ON l.id = i.list_id
      WHERE e.workspace_id = ? AND e.actor_id = ? AND e.entity = 'item'
        AND i.archived = 0
      GROUP BY i.id
      ORDER BY at DESC
      LIMIT ?`,
    [ctx.workspaceId, actorId, limit],
  )

  const assignedKeys = new Set(assigned.map((r) => r.key))

  return {
    assigned: assigned.map(shape),
    // Anything already listed as assigned is not repeated under Due: the
    // same card twice on one screen reads as two pieces of work.
    due: dueSoon.filter((r) => !assignedKeys.has(r.key)).map(shape),
    mentions: mentionRows.map((r) => ({
      ...shape(r),
      reason: r.reason,
      at: r.at,
    })),
    recent: recent.map((r) => ({ ...shape(r), at: r.at })),
  }
}
