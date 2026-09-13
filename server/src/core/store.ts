/**
 * Row lookups and position helpers shared by the services. All lookups are
 * workspace-scoped and accept human keys (design-spec §1).
 */

import type { ICtx } from './ctx'
import { ApiError } from './ctx'

export interface ISpaceRow {
  id: string
  key: string
  name: string
  description: string
  next_seq: number
  archived: number
}

export interface IListRow {
  id: string
  space_id: string
  name: string
  role: string
  pos: number
  archived: number
}

export interface IItemRow {
  id: string
  space_id: string
  list_id: string
  key: string
  title: string
  description: string
  pos: number
  due: number | null
  completed: number
  archived: number
  rev: number
  created_by: string
  created_at: number
  updated_at: number
  imported_meta: string | null
  /** Unitless estimate, for sequencing. Null means unsized. */
  size: number | null
  /** A checkpoint rather than a piece of work. */
  is_milestone: number
}

export interface IDocRow {
  id: string
  slug: string
  title: string
  parent_id: string | null
  space_id: string | null
  pos: number
  body: string
  layout: string
  tags: string
  archived: number
  rev: number
  created_at: number
  updated_at: number
  imported_meta: string | null
}

export async function spaceByKey(ctx: ICtx, key: string): Promise<ISpaceRow> {
  const rows = await ctx.db.query<ISpaceRow>(
    'SELECT * FROM space WHERE workspace_id = ? AND key = ?',
    [ctx.workspaceId, key],
  )
  if (rows.length === 0) throw new ApiError(404, `space ${key} not found`)
  return rows[0]
}

/** Lists are addressed by name (case-insensitive) or id within a space. */
export async function listByRef(
  ctx: ICtx,
  spaceId: string,
  ref: string,
): Promise<IListRow> {
  const rows = await ctx.db.query<IListRow>(
    `SELECT * FROM list WHERE workspace_id = ? AND space_id = ? AND archived = 0
       AND (id = ? OR lower(name) = lower(?)) LIMIT 1`,
    [ctx.workspaceId, spaceId, ref, ref],
  )
  if (rows.length === 0) throw new ApiError(404, `list ${ref} not found`)
  return rows[0]
}

/** Items resolve by key, following key aliases from cross-space moves. */
export async function itemByKey(ctx: ICtx, key: string): Promise<IItemRow> {
  const rows = await ctx.db.query<IItemRow>(
    'SELECT * FROM item WHERE workspace_id = ? AND key = ?',
    [ctx.workspaceId, key],
  )
  if (rows.length > 0) return rows[0]
  const alias = await ctx.db.query<{ item_id: string }>(
    'SELECT item_id FROM item_key_alias WHERE workspace_id = ? AND key = ?',
    [ctx.workspaceId, key],
  )
  if (alias.length > 0) {
    const byId = await ctx.db.query<IItemRow>(
      'SELECT * FROM item WHERE id = ?',
      [alias[0].item_id],
    )
    if (byId.length > 0) return byId[0]
  }
  throw new ApiError(404, `item ${key} not found`)
}

export async function docBySlug(ctx: ICtx, slug: string): Promise<IDocRow> {
  const rows = await ctx.db.query<IDocRow>(
    'SELECT * FROM document WHERE workspace_id = ? AND slug = ?',
    [ctx.workspaceId, slug],
  )
  if (rows.length === 0) throw new ApiError(404, `doc ${slug} not found`)
  return rows[0]
}

export async function actorByRef(
  ctx: ICtx,
  ref: string,
): Promise<{ id: string; handle: string }> {
  const rows = await ctx.db.query<{ id: string; handle: string }>(
    'SELECT id, handle FROM actor WHERE workspace_id = ? AND (id = ? OR handle = ?)',
    [ctx.workspaceId, ref, ref],
  )
  if (rows.length === 0) throw new ApiError(404, `actor ${ref} not found`)
  return rows[0]
}

export async function labelByRef(
  ctx: ICtx,
  ref: string,
  spaceId?: string,
): Promise<{ id: string; name: string; group_id: string }> {
  // Accept a label id or a name; names resolve space-local first, then
  // workspace groups.
  const byId = await ctx.db.query<{
    id: string
    name: string
    group_id: string
  }>('SELECT id, name, group_id FROM label WHERE workspace_id = ? AND id = ?', [
    ctx.workspaceId,
    ref,
  ])
  if (byId.length > 0) return byId[0]
  // With a space context, prefer that space's labels over workspace ones and
  // hide other spaces' labels; without one, any unique name resolves.
  const byName = await (spaceId
    ? ctx.db.query<{ id: string; name: string; group_id: string }>(
        `SELECT l.id, l.name, l.group_id FROM label l
           JOIN label_group g ON g.id = l.group_id
          WHERE l.workspace_id = ? AND lower(l.name) = lower(?)
            AND (g.space_id IS NULL OR g.space_id = ?)
          ORDER BY g.space_id IS NULL`,
        [ctx.workspaceId, ref, spaceId],
      )
    : ctx.db.query<{ id: string; name: string; group_id: string }>(
        `SELECT l.id, l.name, l.group_id FROM label l
          WHERE l.workspace_id = ? AND lower(l.name) = lower(?)`,
        [ctx.workspaceId, ref],
      ))
  if (byName.length === 0) throw new ApiError(404, `label ${ref} not found`)
  return byName[0]
}

const POS_STEP = 1024

/** Position at the end of a sequence. */
export async function tailPos(
  ctx: ICtx,
  table: 'list' | 'item',
  parentCol: string,
  parentId: string,
): Promise<number> {
  const rows = await ctx.db.query<{ m: number | null }>(
    `SELECT MAX(pos) AS m FROM ${table} WHERE ${parentCol} = ?`,
    [parentId],
  )
  return (rows[0]?.m ?? 0) + POS_STEP
}
