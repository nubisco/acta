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
import {
  hasPrivateAncestor,
  hiddenDocIds,
  viewerOf,
  visibleDocSql,
  visibleLinkSourceSql,
} from '../core/docAccess'
import { anchorStatus, parseAnchor } from './anchors'
import { attachmentUrl } from './attachments'
import {
  canDeleteComment,
  canEditComment,
  commentDeletePolicy,
} from './comments'
import { anchorTextFromMarkdown, sectionMap } from '@nubisco/acta-shared'
import {
  GOAL_ITEMS_SQL,
  goalByRef,
  goalCatalogue,
  goalKey,
  goalsForItem,
} from './goals'

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
    await ctx.db.query<{
      id: string
      name: string
      comment_delete: string | null
    }>('SELECT id, name, comment_delete FROM workspace WHERE id = ?', [
      ctx.workspaceId,
    ])
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
    group_id: string
    group_name: string
    space_key: string | null
    id: string
    name: string
    color: string
    exclusive: number
    pos: number | null
  }>(
    // Ordered by `pos` where a group has been arranged, and by name where it
    // has not. Versions are why: 1.9.0 comes before 1.11.0, and no amount of
    // sorting by name will agree. NULLs last so an unplaced label in an
    // otherwise arranged group lands at the end rather than the front.
    `SELECT g.id AS group_id, g.name AS group_name, b.key AS space_key, g.exclusive,
            l.id, l.name, l.color, l.pos
       FROM label l JOIN label_group g ON g.id = l.group_id
       LEFT JOIN space b ON b.id = g.space_id
      WHERE l.workspace_id = ?
      ORDER BY g.name, l.pos IS NULL, l.pos, l.name`,
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
  const visibleRoots = visibleDocSql('d.id', await hiddenDocIds(ctx))
  const docRoots = await ctx.db.query<{
    slug: string
    title: string
    children: number
  }>(
    `SELECT d.slug, d.title,
            (SELECT COUNT(*) FROM document c WHERE c.parent_id = d.id AND c.archived = 0
                AND ${visibleRoots.sql.replaceAll('d.id', 'c.id')}) AS children
       FROM document d WHERE d.workspace_id = ? AND d.parent_id IS NULL AND d.archived = 0
        AND ${visibleRoots.sql}
      ORDER BY d.pos`,
    [...visibleRoots.params, ctx.workspaceId, ...visibleRoots.params],
  )
  return {
    workspace: { id: ws.id, name: ws.name },
    // Workspace-wide policy, read once with everything else rather than
    // through a call of its own: the comment menus need it on every thread.
    policy: {
      comment_delete: ws.comment_delete === 'admin' ? 'admin' : 'author',
    },
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
    labels: labels.map((l) => ({
      // The id, so a caller can name a group exactly. Two boards can each
      // have a "Fixes version", and the name alone is then ambiguous.
      group_id: l.group_id,
      group_name: l.group_name,
      space_key: l.space_key,
      id: l.id,
      name: l.name,
      color: l.color,
      // Absent rather than false, the way every other flag in this payload
      // reads, so a group that behaves as it always did says nothing.
      exclusive: l.exclusive === 1 || undefined,
    })),
    actors,
    doc_roots: docRoots,
    // Every goal, compact. Small by nature (a workspace has tens, not
    // thousands), and every surface that renders a goal chip or offers a
    // goal picker needs the names without a read of its own.
    goals: await goalCatalogue(ctx),
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
  if (params.goal !== undefined) {
    // Everything serving the goal, its sub-goals' work and every part of a
    // linked card included: the same set its progress is measured over, so
    // filtering a board by a goal shows exactly the cards behind its number.
    const goal = await goalByRef(ctx, params.goal)
    where.push(`i.id IN (${GOAL_ITEMS_SQL})`)
    args.push(goal.id)
  }
  // The board's Done window. A done card leaves the board once it has been
  // done for longer than the space's window, or was cleared off with "Clear
  // done now". Measured from when it became done, never from the last edit,
  // so a comment on an old card does not bring it back. Counted, so the
  // column can say what it is not showing.
  const doneSince =
    params.done === 'space'
      ? Math.max(
          space.done_window_days
            ? Date.now() - space.done_window_days * 86_400_000
            : 0,
          space.done_cleared_at ?? 0,
        )
      : 0
  let hiddenDone = 0
  if (doneSince > 0) {
    const older = 'i.done_at IS NOT NULL AND i.done_at < ? AND i.archived = 0'
    const counted = await ctx.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM item i JOIN list l ON l.id = i.list_id
        WHERE ${where.join(' AND ')} AND ${older}`,
      [...args, doneSince],
    )
    hiddenDone = counted[0]?.n ?? 0
    where.push(`NOT (${older})`)
    args.push(doneSince)
  }

  if (params.cursor) {
    where.push('i.key > ?')
    args.push(params.cursor)
  }

  const rows = await ctx.db.query<
    IItemRow & {
      list_name: string
      labels: string | null
      label_ids: string | null
      assignees: string | null
      cmts: number
      chk_done: number
      chk_total: number
      parent_key: string | null
      parts_total: number
      parts_done: number
      atts: number
      blocked_by: string | null
    }
  >(
    `SELECT i.*, l.name AS list_name,
            (SELECT p.key FROM item p WHERE p.id = i.parent_id) AS parent_key,
            (SELECT COUNT(*) FROM item c WHERE c.parent_id = i.id AND c.archived = 0) AS parts_total,
            (SELECT COUNT(*) FROM item c WHERE c.parent_id = i.id AND c.archived = 0 AND c.completed = 1) AS parts_done,
            -- Both ordered by label id through an inner subselect, so the
            -- two lists correspond position by position. GROUP_CONCAT has no
            -- guaranteed order of its own, and an ORDER BY inside it needs a
            -- SQLite newer than we can assume of every deployment.
            (SELECT GROUP_CONCAT(name) FROM (SELECT lb.name FROM item_label il JOIN label lb ON lb.id = il.label_id WHERE il.item_id = i.id ORDER BY lb.id)) AS labels,
            (SELECT GROUP_CONCAT(id) FROM (SELECT lb.id FROM item_label il JOIN label lb ON lb.id = il.label_id WHERE il.item_id = i.id ORDER BY lb.id)) AS label_ids,
            (SELECT GROUP_CONCAT(a.handle) FROM item_assignee ia JOIN actor a ON a.id = ia.actor_id WHERE ia.item_id = i.id) AS assignees,
            (SELECT COUNT(*) FROM comment c WHERE c.item_id = i.id) AS cmts,
            (SELECT COUNT(*) FROM checklist_item ci JOIN checklist ch ON ch.id = ci.checklist_id WHERE ch.item_id = i.id AND ci.done = 1) AS chk_done,
            (SELECT COUNT(*) FROM checklist_item ci JOIN checklist ch ON ch.id = ci.checklist_id WHERE ch.item_id = i.id) AS chk_total,
            (SELECT COUNT(*) FROM attachment at WHERE at.owner_kind = 'item' AND at.owner_id = i.id) AS atts,
            -- Only blockers still in the way: a finished or archived blocker
            -- no longer holds anything up.
            (SELECT GROUP_CONCAT(b.key) FROM item_dependency d JOIN item b ON b.id = d.blocker_id
              WHERE d.blocked_id = i.id AND b.completed = 0 AND b.archived = 0) AS blocked_by
       FROM item i JOIN list l ON l.id = i.list_id
      WHERE ${where.join(' AND ')}
      ORDER BY i.key LIMIT ?`,
    [...args, params.limit + 1],
  )

  const page = rows.slice(0, params.limit)
  // A board card shows more than a row does. Compact stays compact, because
  // agents read spaces through it and pay for every field.
  const card = params.detail !== 'compact'
  const goals = card ? await goalsBySpaceItem(ctx, space.id) : new Map()
  const items = page.map((r) => ({
    key: r.key,
    title: r.title,
    list: r.list_name,
    labels: r.labels ? r.labels.split(',') : undefined,
    label_ids: r.label_ids ? r.label_ids.split(',') : undefined,
    assignees: r.assignees ? r.assignees.split(',') : undefined,
    due: r.due ?? undefined,
    priority: r.priority ?? undefined,
    // The timeline needs somewhere for a bar to start. Without it every card
    // would be a milestone on its due date, which is a worse chart and a less
    // true one.
    created: r.created_at,
    done: r.completed === 1 || undefined,
    archived: r.archived === 1 || undefined,
    cmts: r.cmts || undefined,
    chk: r.chk_total > 0 ? `${r.chk_done}/${r.chk_total}` : undefined,
    // What a card is part of, and how much of it is done. Counted here
    // rather than by the browser, which would otherwise have to hold the
    // whole board to answer it and would still be wrong for a part on
    // another board.
    parent_key: r.parent_key ?? undefined,
    parts_total: r.parts_total || undefined,
    parts_done: r.parts_total > 0 ? r.parts_done : undefined,
    rev: r.rev,
    updated: r.updated_at,
    pos: r.pos,
    description: params.detail === 'full' ? r.description : undefined,
    ...(card
      ? {
          summary: descriptionSummary(r.description) || undefined,
          size: r.size ?? undefined,
          blocked_by: r.blocked_by ? r.blocked_by.split(',') : undefined,
          atts: r.atts || undefined,
          goals: goals.get(r.id),
        }
      : {}),
  }))

  return {
    space: {
      key: space.key,
      name: space.name,
      done_window_days: space.done_window_days ?? null,
    },
    items,
    // Asked for with done=space: how many done cards the window left out,
    // so the Done column can say so instead of losing them silently.
    ...(params.done === 'space'
      ? { done_hidden: hiddenDone, done_since: doneSince || undefined }
      : {}),
    cursor: rows.length > params.limit ? page[page.length - 1].key : undefined,
  }
}

/**
 * The first line of a description that says something, as plain text, for
 * the one line a board card has room for. Headings, list bullets, quotes,
 * emphasis and link targets are markup, not words, so they go.
 */
export function descriptionSummary(
  markdown: string | null | undefined,
): string {
  let fenced = false
  for (const raw of (markdown ?? '').split('\n')) {
    const trimmed = raw.trim()
    // Code says nothing a person can read at a glance, so a fence and all
    // it holds are skipped, as are horizontal rules and table rows.
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      fenced = !fenced
      continue
    }
    if (fenced || /^(?:[-*_]\s*){3,}$/.test(trimmed) || trimmed.startsWith('|'))
      continue
    const line = trimmed
      .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(
        /\[\[(?:[a-z]+:)?([^\]|]+)(?:\|([^\]]+))?\]\]/g,
        (_m, ref, alias) => alias ?? ref,
      )
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
      .trim()
    if (!line) continue
    return line.length > 160 ? `${line.slice(0, 159)}…` : line
  }
  return ''
}

/**
 * The goals every card of a space serves, linked to it or to anything it is
 * part of, nearest first. One query for the whole space: asking per card
 * would be a query per card, and a list of ids would run into D1's limit on
 * bound parameters.
 */
async function goalsBySpaceItem(ctx: ICtx, spaceId: string) {
  const rows = await ctx.db.query<{
    item_id: string
    number: number
    title: string
    status: string
  }>(
    `WITH RECURSIVE up(start, id, depth) AS (
       SELECT i.id, i.id, 0 FROM item i WHERE i.space_id = ?
       UNION
       SELECT up.start, i.parent_id, up.depth + 1 FROM item i JOIN up ON i.id = up.id
        WHERE i.parent_id IS NOT NULL AND up.depth < 64
     )
     SELECT up.start AS item_id, g.number, g.title, g.status
       FROM up
       JOIN goal_item gi ON gi.item_id = up.id
       JOIN goal g ON g.id = gi.goal_id
      WHERE g.archived = 0
      ORDER BY up.start, up.depth, g.number`,
    [spaceId],
  )
  const out = new Map<
    string,
    { number: number; key: string; title: string; status: string }[]
  >()
  for (const r of rows) {
    const list = out.get(r.item_id) ?? []
    if (list.some((g) => g.number === r.number)) continue
    list.push({
      number: r.number,
      key: goalKey(r.number),
      title: r.title,
      status: r.status,
    })
    out.set(r.item_id, list)
  }
  return out
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
    // Ids alongside the names, because a name is no longer enough to say
    // which group a value belongs to. "Affects version" and "Fixes version"
    // both list 1.12.0, so a card carrying the bare name cannot be shown as
    // the field it actually is. `labels` keeps its shape, since the MCP
    // tools, the importers and the board all read it.
    const labelRows = await ctx.db.query<{ id: string; name: string }>(
      'SELECT lb.id, lb.name FROM item_label il JOIN label lb ON lb.id = il.label_id WHERE il.item_id = ?',
      [item.id],
    )
    const labels = labelRows.map((r) => r.name)
    const labelIds = labelRows.map((r) => r.id)
    const assignees = (
      await ctx.db.query<{ handle: string }>(
        'SELECT a.handle FROM item_assignee ia JOIN actor a ON a.id = ia.actor_id WHERE ia.item_id = ?',
        [item.id],
      )
    ).map((r) => r.handle)

    const creator = (
      await ctx.db.query<{ handle: string }>(
        'SELECT handle FROM actor WHERE id = ?',
        [item.created_by],
      )
    )[0]
    const out: Record<string, unknown> = {
      key: item.key,
      space: spaceKey,
      // Who made it, always: "who created this" is the first question a
      // card's history is asked, and it should not need the whole history.
      created_by: creator?.handle,
      list: listName,
      title: item.title,
      description: item.description,
      labels: labels.length > 0 ? labels : undefined,
      label_ids: labelIds.length > 0 ? labelIds : undefined,
      assignees: assignees.length > 0 ? assignees : undefined,
      due: item.due ?? undefined,
      done: item.completed === 1 || undefined,
      archived: item.archived === 1 || undefined,
      rev: item.rev,
      created: item.created_at,
      updated: item.updated_at,
      imported: parseImportedMeta(item.imported_meta),
      size: item.size ?? undefined,
      priority: item.priority ?? undefined,
      is_milestone: item.is_milestone === 1 || undefined,
    }

    // Always, for the same reason as `blocked_by` below: what a card is part
    // of, and what is part of it, is what the card IS rather than an extra
    // anybody has to ask for. A board read can be hidden behind a flag; one
    // card cannot.
    const parentRow = item.parent_id
      ? (
          await ctx.db.query<{
            key: string
            title: string
            completed: number
            space_key: string
          }>(
            `SELECT i.key, i.title, i.completed, s.key AS space_key
               FROM item i JOIN space s ON s.id = i.space_id
              WHERE i.id = ?`,
            [item.parent_id],
          )
        )[0]
      : undefined
    if (parentRow) {
      out.parent = {
        key: parentRow.key,
        title: parentRow.title,
        space: parentRow.space_key,
        done: parentRow.completed === 1 || undefined,
      }
    }

    const parts = (
      await ctx.db.query<{
        key: string
        title: string
        completed: number
        space_key: string
      }>(
        `SELECT i.key, i.title, i.completed, s.key AS space_key
           FROM item i JOIN space s ON s.id = i.space_id
          WHERE i.parent_id = ? AND i.archived = 0
          ORDER BY i.key`,
        [item.id],
      )
    ).map((r) => ({
      key: r.key,
      title: r.title,
      space: r.space_key,
      done: r.completed === 1 || undefined,
    }))
    if (parts.length > 0) out.parts = parts

    // The goals this card serves, linked to it or to anything it is part
    // of. Always, like parts: what a card is for is what the card is.
    const goals = await goalsForItem(ctx, item.id)
    if (goals.length > 0) out.goals = goals

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
      // Worked out here rather than in the browser. Whether somebody may
      // edit or delete a comment is a rule about the workspace and about
      // who wrote it, and a client that re-derives it is a second copy of
      // the rule that will disagree with this one eventually.
      const policy = await commentDeletePolicy(ctx)
      out.comments = (
        await ctx.db.query<{
          id: string
          body: string
          created_at: number
          edited_at: number | null
          actor_id: string
          handle: string
          kind: string
          imported_meta: string | null
        }>(
          `SELECT c.id, c.body, c.created_at, c.edited_at, c.actor_id, a.handle, a.kind, c.imported_meta FROM comment c
             JOIN actor a ON a.id = c.actor_id WHERE c.item_id = ? ORDER BY c.created_at`,
          [item.id],
        )
      ).map((c) => ({
        id: c.id,
        by: c.handle,
        agent: c.kind === 'agent' || undefined,
        ts: c.created_at,
        edited: c.edited_at ?? undefined,
        body: c.body,
        imported: parseImportedMeta(c.imported_meta),
        can_edit: canEditComment(ctx, c.actor_id) || undefined,
        can_delete: canDeleteComment(ctx, c.actor_id, policy) || undefined,
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
      const visibleLinkDocs = visibleLinkSourceSql(await hiddenDocIds(ctx))
      out.links = {
        out: await ctx.db.query<{ ref_type: string; target: string }>(
          "SELECT ref_type, target FROM link WHERE src_kind = 'item' AND src_id = ?",
          [item.id],
        ),
        // `src` names the referrer the way a reader would: a card's key (a
        // comment counts as its card) or a document's slug. The bare id was
        // all the inspector had to show, and nobody can open an id.
        in: await ctx.db.query<{
          src_kind: string
          src_id: string
          src: string | null
        }>(
          `SELECT l.src_kind, l.src_id,
                  CASE l.src_kind
                    WHEN 'item' THEN (SELECT r.key FROM item r WHERE r.id = l.src_id)
                    WHEN 'comment' THEN (SELECT r.key FROM comment c JOIN item r ON r.id = c.item_id WHERE c.id = l.src_id)
                    WHEN 'doc' THEN (SELECT d.slug FROM document d WHERE d.id = l.src_id)
                  END AS src
             FROM link l WHERE l.workspace_id = ? AND l.ref_type = 'item' AND l.target = ?
              AND ${visibleLinkDocs.sql}`,
          [ctx.workspaceId, item.key, ...visibleLinkDocs.params],
        ),
      }
    }
    if (include.has('attachments')) {
      out.attachments = await attachmentsFor(ctx, 'item', item.id)
    }
    if (include.has('activity')) {
      out.activity = await itemHistory(ctx, item.id)
    }
    items.push(out)
  }
  return { items }
}

/**
 * Everything that happened to one card, newest first, with who did it.
 *
 * The raw event rows name people and labels by internal id, which is no use
 * to a reader, so they are resolved here: assignee changes to handles, label
 * changes to names with their group. Every row keeps the server's own
 * summary, so a verb this function does not know about still reads as a
 * sentence rather than disappearing.
 *
 * Older events recorded less than new ones ("labels changed" with no list of
 * which), and nothing can recover what they did not write down. Those rows
 * come back with the summary alone.
 */
const HISTORY_LIMIT = 200

async function itemHistory(ctx: ICtx, itemId: string) {
  const rows = await ctx.db.query<{
    id: string
    ts: number
    verb: string
    summary: string
    actor_kind: string
    payload: string | null
    handle: string | null
    caused_by: string | null
  }>(
    `SELECT e.id, e.ts, e.verb, e.summary, e.actor_kind, e.payload, e.caused_by,
            a.handle
       FROM event e LEFT JOIN actor a ON a.id = e.actor_id
      WHERE e.entity = 'item' AND e.entity_id = ?
      ORDER BY e.id DESC LIMIT ?`,
    [itemId, HISTORY_LIMIT],
  )

  // One lookup each for every person and label any row mentions, rather
  // than a query per row.
  const parsed = rows.map((r) => {
    try {
      return r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  })
  const ids = (key: string) =>
    parsed.flatMap((p) => (Array.isArray(p[key]) ? (p[key] as string[]) : []))
  // Actor ids on assignee events and label ids on label events, pooled:
  // the prefixes keep them apart, and each lookup only finds its own kind.
  const refIds = [...new Set([...ids('added'), ...ids('removed')])]
  const handles = new Map<string, string>()
  if (refIds.length > 0) {
    for (const r of await ctx.db.query<{ id: string; handle: string }>(
      `SELECT id, handle FROM actor WHERE workspace_id = ? AND id IN (${refIds.map(() => '?').join(',')})`,
      [ctx.workspaceId, ...refIds],
    ))
      handles.set(r.id, r.handle)
  }
  const labelNames = new Map<string, string>()
  if (refIds.length > 0) {
    for (const r of await ctx.db.query<{
      id: string
      name: string
      group_name: string
    }>(
      `SELECT l.id, l.name, g.name AS group_name FROM label l JOIN label_group g ON g.id = l.group_id
        WHERE l.workspace_id = ? AND l.id IN (${refIds.map(() => '?').join(',')})`,
      [ctx.workspaceId, ...refIds],
    ))
      labelNames.set(r.id, `${r.group_name}/${r.name}`)
  }

  return rows.map((r, i) => {
    const p = parsed[i]
    const people = (key: string) =>
      Array.isArray(p[key])
        ? (p[key] as string[]).map((id) => handles.get(id)).filter(Boolean)
        : undefined
    const labels = (key: string) =>
      Array.isArray(p[key])
        ? (p[key] as string[]).map(
            (id) => labelNames.get(id) ?? '(deleted label)',
          )
        : undefined
    let changes: Record<string, unknown> | undefined
    if (r.verb === 'item.assigned' || r.verb === 'item.unassigned')
      changes = { added: people('added'), removed: people('removed') }
    else if (r.verb === 'item.labeled')
      changes = { added: labels('added'), removed: labels('removed') }
    else if (Object.keys(p).length > 0) changes = p
    return {
      id: r.id,
      ts: r.ts,
      verb: r.verb,
      summary: r.summary,
      by: r.handle ?? undefined,
      actor_kind: r.actor_kind,
      // A rule did it, on behalf of whatever event triggered the rule.
      automated: r.caused_by ? true : undefined,
      changes,
    }
  })
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
    owner_id: string | null
    visibility: 'private' | 'workspace'
  }
  const hidden = new Set(await hiddenDocIds(ctx))
  const all = (
    await ctx.db.query<INode>(
      'SELECT id, slug, title, parent_id, rev, updated_at, owner_id, visibility FROM document WHERE workspace_id = ? AND archived = 0 ORDER BY pos, id',
      [ctx.workspaceId],
    )
  ).filter((d) => !hidden.has(d.id))
  const rootNode = root ? all.find((d) => d.slug === root) : undefined
  const out: {
    slug: string
    title: string
    depth: number
    rev: number
    updated: number
    /** Private pages are listed only to their owner, marked so. */
    private?: true
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
        ...(node.visibility === 'private' ? { private: true as const } : {}),
      })
      walk(node.id, level + 1)
    }
  }
  walk(rootNode?.id ?? null, 0)
  return { docs: out }
}

/**
 * Who a page belongs to and who can see it, as the page header shows them:
 * the owner's handle, whether it is private, whether the reader may change
 * that, and whether the author still has to be asked about sharing it.
 */
async function docAccessFacts(
  ctx: ICtx,
  doc: {
    id: string
    owner_id: string | null
    visibility: string
    ask_share: number
  },
) {
  const owner = doc.owner_id
    ? await ctx.db.query<{ handle: string }>(
        'SELECT handle FROM actor WHERE id = ?',
        [doc.owner_id],
      )
    : []
  const mine = doc.owner_id !== null && doc.owner_id === viewerOf(ctx)
  const insidePrivate = await hasPrivateAncestor(ctx, doc.id)
  return {
    owner: owner[0]?.handle ?? null,
    visibility: doc.visibility === 'private' ? 'private' : 'workspace',
    /** Private because a page above it is, so it cannot be shared alone. */
    inside_private: insidePrivate || undefined,
    can_change_visibility: mine || undefined,
    ask_share: (mine && doc.ask_share === 1) || undefined,
  }
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
  // The real parent, not one read off the slug: a slug keeps the path it was
  // created with, so after a move it no longer says where the page lives.
  const parentRows = doc.parent_id
    ? await ctx.db.query<{ slug: string }>(
        'SELECT slug FROM document WHERE id = ?',
        [doc.parent_id],
      )
    : []
  const out: Record<string, unknown> = {
    slug: doc.slug,
    title: doc.title,
    parent: parentRows[0]?.slug ?? null,
    layout: doc.layout === 'wide' ? 'wide' : undefined,
    tags: JSON.parse(doc.tags),
    rev,
    updated: doc.updated_at,
    body,
    imported: parseImportedMeta(doc.imported_meta),
    ...(await docAccessFacts(ctx, doc)),
  }
  // Always, not behind `include`. A document's body can embed an attachment,
  // so a reader that has the body but not the attachment list cannot render
  // what the body refers to.
  out.attachments = await attachmentsFor(ctx, 'doc', doc.id)
  if (include.has('comments')) {
    const docPolicy = await commentDeletePolicy(ctx)
    let anchorText: string | null = null
    out.comments = (
      await ctx.db.query<{
        id: string
        body: string
        created_at: number
        edited_at: number | null
        actor_id: string
        handle: string
        kind: string
        imported_meta: string | null
        anchor: string | null
        resolved_at: number | null
        resolved_handle: string | null
      }>(
        `SELECT c.id, c.body, c.created_at, c.edited_at, c.actor_id, a.handle, a.kind, c.imported_meta,
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
        edited: c.edited_at ?? undefined,
        body: c.body,
        imported: parseImportedMeta(c.imported_meta),
        can_edit: canEditComment(ctx, c.actor_id) || undefined,
        can_delete: canDeleteComment(ctx, c.actor_id, docPolicy) || undefined,
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
    const visibleBacklinks = visibleLinkSourceSql(await hiddenDocIds(ctx))
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
        WHERE l.workspace_id = ? AND l.ref_type = 'doc' AND l.target = ?
          AND ${visibleBacklinks.sql}`,
      [ctx.workspaceId, doc.slug, ...visibleBacklinks.params],
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
  // A page hidden from this reader is not a search result, title included.
  const hidden = await hiddenDocIds(ctx)
  if (hidden.length > 0) {
    // Comments on a page are indexed under the page's slug as their title.
    filter += ` AND NOT (kind IN ('doc', 'comment') AND (CASE kind WHEN 'doc' THEN ref ELSE title END) IN (SELECT slug FROM document WHERE id IN (SELECT value FROM json_each(?))))`
    args.push(JSON.stringify(hidden))
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
  // Qualified, because the query joins item and document to resolve what each
  // row opens, and `id` means two things once it does.
  const where: string[] = ['e.workspace_id = ?']
  const args: unknown[] = [ctx.workspaceId]
  if (params.entity) {
    where.push('(e.entity = ? OR e.entity_id = ?)')
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
            '(e.actor_id = ? OR e.actor_id IN (SELECT id FROM actor WHERE workspace_id = ? AND handle = ?))',
        )
        .join(' OR ')
      where.push(`(${clause})`)
      for (const actor of actors) args.push(actor, ctx.workspaceId, actor)
    }
  }
  if (params.actor_kind) {
    where.push('e.actor_kind = ?')
    args.push(params.actor_kind)
  }
  if (params.verb) {
    where.push('e.verb LIKE ?')
    args.push(params.verb.replace('*', '%'))
  }
  if (params.since) {
    where.push('e.id > ?')
    args.push(params.since)
  }
  if (params.cursor) {
    where.push('e.id < ?')
    args.push(params.cursor)
  }
  // What happens to a page hidden from this reader is not theirs to see. A
  // page that still exists answers for itself. A deleted one cannot, so its
  // events answer with what was stamped on them when they happened.
  const visibleEvents = visibleDocSql('d.id', await hiddenDocIds(ctx))
  where.push(
    `(e.entity != 'doc' OR (d.id IS NOT NULL AND ${visibleEvents.sql}) OR (d.id IS NULL AND (e.private_to IS NULL OR e.private_to = ?)))`,
  )
  args.push(...visibleEvents.params, viewerOf(ctx))
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
    item_key: string | null
    doc_slug: string | null
    goal_number: number | null
  }>(
    `SELECT e.id, e.ts, e.actor_id, e.actor_kind, e.on_behalf_of, e.verb,
            e.entity, e.entity_id, e.summary, e.caused_by,
            -- What the row opens. entity_id is an internal id, which is no
            -- use to a browser and no use to a person: the feed talks about
            -- ST-1 and spec, so it has to hand back ST-1 and spec. Resolved
            -- here for the same reason the notification inbox resolves it,
            -- rather than asking every client to look up every row.
            i.key AS item_key,
            d.slug AS doc_slug,
            g.number AS goal_number
       FROM event e
       LEFT JOIN item i ON i.id = e.entity_id AND e.entity = 'item'
       LEFT JOIN document d ON d.id = e.entity_id AND e.entity = 'doc'
       LEFT JOIN goal g ON g.id = e.entity_id AND e.entity = 'goal'
      WHERE ${where.join(' AND ')}
      ORDER BY e.id DESC LIMIT ?`,
    [...args, params.limit],
  )
  return {
    events: rows.map((r) => ({
      ...r,
      item_key: r.item_key ?? undefined,
      doc_slug: r.doc_slug ?? undefined,
      goal_number: r.goal_number ?? undefined,
    })),
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
