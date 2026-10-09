/**
 * Who may see a document.
 *
 * A page is private to its owner or shared with the workspace (never public:
 * shared means the other members). Set by Jose on 2026-10-09:
 *
 * - A new page starts private, and its author is asked on the first save
 *   whether to share it. Pages an agent writes are shared, since a private
 *   page owned by a bot is one nobody can see.
 * - Children follow their parent. A page inside a private page is private
 *   with it, so a page is hidden from you when it, or any page above it, is
 *   private and somebody else's.
 * - Private is private: admins do not see other people's private pages.
 *
 * Hidden pages behave as if they did not exist (404, absent from lists), so a
 * private page's title never leaks through a tree, a search, a link or the
 * activity feed.
 */
import type { ICtx } from './ctx'

export type TDocVisibility = 'private' | 'workspace'

/**
 * The person a request reads as. An agent connected for somebody (OAuth, a
 * personal token) sees what that person sees.
 */
export function viewerOf(ctx: ICtx): string {
  return ctx.actor.onBehalfOf ?? ctx.actor.id
}

/** The ids of every page hidden from this request, private subtrees included. */
export async function hiddenDocIds(ctx: ICtx): Promise<string[]> {
  // The system acts for nobody in particular (sweeps, rules) and is never a
  // reader, so it sees everything it is asked to touch.
  if (ctx.actor.kind === 'system') return []
  const rows = await ctx.db.query<{ id: string }>(
    `WITH RECURSIVE hidden(id) AS (
       SELECT id FROM document
        WHERE workspace_id = ? AND visibility = 'private'
          AND (owner_id IS NULL OR owner_id != ?)
       UNION
       SELECT d.id FROM document d JOIN hidden h ON d.parent_id = h.id
     )
     SELECT id FROM hidden`,
    [ctx.workspaceId, viewerOf(ctx)],
  )
  return rows.map((r) => r.id)
}

/**
 * A SQL condition keeping hidden pages out, for a column holding a document
 * id. One JSON parameter rather than a placeholder per id, so it holds for
 * any number of pages on both SQLite and D1.
 */
export function visibleDocSql(
  column: string,
  hidden: string[],
): { sql: string; params: unknown[] } {
  if (hidden.length === 0) return { sql: '1 = 1', params: [] }
  return {
    sql: `(${column} IS NULL OR ${column} NOT IN (SELECT value FROM json_each(?)))`,
    params: [JSON.stringify(hidden)],
  }
}

/** Whether one page is hidden from this request. */
export async function isDocHidden(ctx: ICtx, docId: string): Promise<boolean> {
  return (await hiddenDocIds(ctx)).includes(docId)
}

/**
 * Whether any page above this one is private, which makes this one private
 * too and means it cannot be shared on its own.
 */
export async function hasPrivateAncestor(
  ctx: ICtx,
  docId: string,
): Promise<boolean> {
  const rows = await ctx.db.query<{ n: number }>(
    `WITH RECURSIVE up(id, parent_id, visibility) AS (
       SELECT id, parent_id, visibility FROM document WHERE id = ?
       UNION
       SELECT d.id, d.parent_id, d.visibility FROM document d JOIN up ON d.id = up.parent_id
     )
     SELECT COUNT(*) AS n FROM up WHERE id != ? AND visibility = 'private'`,
    [docId, docId],
  )
  return (rows[0]?.n ?? 0) > 0
}

/** Pages under this one (not itself) owned by somebody other than `owner`. */
export async function foreignDescendants(
  ctx: ICtx,
  docId: string,
  owner: string,
): Promise<string[]> {
  const rows = await ctx.db.query<{ slug: string }>(
    `WITH RECURSIVE down(id) AS (
       SELECT id FROM document WHERE parent_id = ?
       UNION
       SELECT d.id FROM document d JOIN down ON d.parent_id = down.id
     )
     SELECT d.slug FROM document d JOIN down ON d.id = down.id
      WHERE d.owner_id IS NULL OR d.owner_id != ?`,
    [docId, owner],
  )
  return rows.map((r) => r.slug)
}
