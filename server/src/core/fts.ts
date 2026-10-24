import type { ICtx } from './ctx'

/** Keep the FTS index in sync on writes. One row per entity. */
export async function ftsUpsert(
  ctx: ICtx,
  kind: 'item' | 'doc' | 'comment',
  ref: string,
  title: string,
  body: string,
  spaceKey = '',
): Promise<void> {
  if (!ctx.db.supportsFts) return
  // Refs (item keys, doc slugs) repeat across workspaces, so every statement
  // is scoped to this one.
  await ctx.db.run(
    'DELETE FROM fts WHERE kind = ? AND ref = ? AND workspace_id = ?',
    [kind, ref, ctx.workspaceId],
  )
  await ctx.db.run(
    'INSERT INTO fts (kind, ref, title, body, space_key, workspace_id) VALUES (?, ?, ?, ?, ?, ?)',
    [kind, ref, title, body, spaceKey, ctx.workspaceId],
  )
}

export async function ftsDelete(
  ctx: ICtx,
  kind: string,
  ref: string,
): Promise<void> {
  if (!ctx.db.supportsFts) return
  await ctx.db.run(
    'DELETE FROM fts WHERE kind = ? AND ref = ? AND workspace_id = ?',
    [kind, ref, ctx.workspaceId],
  )
}
