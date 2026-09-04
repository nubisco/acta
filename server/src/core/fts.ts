import type { ICtx } from './ctx'

/** Keep the FTS index in sync on writes. One row per entity. */
export async function ftsUpsert(
  ctx: ICtx,
  kind: 'item' | 'doc' | 'comment',
  ref: string,
  title: string,
  body: string,
  boardKey = '',
): Promise<void> {
  if (!ctx.db.supportsFts) return
  await ctx.db.run('DELETE FROM fts WHERE kind = ? AND ref = ?', [kind, ref])
  await ctx.db.run(
    'INSERT INTO fts (kind, ref, title, body, board_key) VALUES (?, ?, ?, ?, ?)',
    [kind, ref, title, body, boardKey],
  )
}

export async function ftsDelete(
  ctx: ICtx,
  kind: string,
  ref: string,
): Promise<void> {
  if (!ctx.db.supportsFts) return
  await ctx.db.run('DELETE FROM fts WHERE kind = ? AND ref = ?', [kind, ref])
}
