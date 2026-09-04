import type { IOpErr, IOpOk, TOpResult } from '@nubisco/acta-shared'
import { discardPendingEvents, flushPendingEvents } from './events'
import type { ICtx } from './ctx'
import { ApiError, now } from './ctx'

/**
 * Idempotency (design-spec §1): each op carries a client op_id. A replay
 * returns the recorded result instead of re-executing. Errors are not
 * recorded, so a failed op can be retried with the same op_id.
 */
export async function withOp(
  ctx: ICtx,
  opId: string,
  fn: () => Promise<Omit<IOpOk, 'op_id' | 'ok'>>,
): Promise<TOpResult> {
  const cached = await ctx.db.query<{ result: string }>(
    'SELECT result FROM op_log WHERE workspace_id = ? AND op_id = ?',
    [ctx.workspaceId, opId],
  )
  if (cached.length > 0) return JSON.parse(cached[0].result) as TOpResult

  try {
    const partial = await ctx.db.transaction(() => fn())
    const result: IOpOk = { op_id: opId, ok: true, ...partial }
    await ctx.db.run(
      'INSERT INTO op_log (workspace_id, op_id, result, created_at) VALUES (?, ?, ?, ?)',
      [ctx.workspaceId, opId, JSON.stringify(result), now()],
    )
    flushPendingEvents()
    return result
  } catch (err) {
    discardPendingEvents()
    const result: IOpErr = {
      op_id: opId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      current: err instanceof ApiError ? err.current : undefined,
    }
    return result
  }
}
