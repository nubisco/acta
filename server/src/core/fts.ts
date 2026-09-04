import type { ICtx } from './ctx'

/** Keep the FTS index in sync on writes. One row per entity. */
export function ftsUpsert(
  ctx: ICtx,
  kind: 'item' | 'doc' | 'comment',
  ref: string,
  title: string,
  body: string,
  boardKey = '',
): void {
  ctx.db.run('DELETE FROM fts WHERE kind = ? AND ref = ?', [kind, ref])
  ctx.db.run(
    'INSERT INTO fts (kind, ref, title, body, board_key) VALUES (?, ?, ?, ?, ?)',
    [kind, ref, title, body, boardKey],
  )
}

export function ftsDelete(ctx: ICtx, kind: string, ref: string): void {
  ctx.db.run('DELETE FROM fts WHERE kind = ? AND ref = ?', [kind, ref])
}
