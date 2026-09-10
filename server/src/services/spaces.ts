import { newId, type TSpaceOp, type TOpResult } from '@nubisco/acta-shared'
import type { ICtx } from '../core/ctx'
import { ApiError, now } from '../core/ctx'
import { emitEvent } from '../core/events'
import { withOp } from '../core/ops'
import { spaceByKey, listByRef, tailPos } from '../core/store'

const KANBAN6: { name: string; role: string }[] = [
  { name: 'Backlog', role: 'backlog' },
  { name: 'To Do', role: 'backlog' },
  { name: 'In Progress', role: 'active' },
  { name: 'Blocked / Waiting', role: 'blocked' },
  { name: 'Review / Testing', role: 'review' },
  { name: 'Done', role: 'done' },
]

export async function spaceWrite(
  ctx: ICtx,
  ops: TSpaceOp[],
): Promise<TOpResult[]> {
  const results: TOpResult[] = []
  for (const op of ops) {
    results.push(await withOp(ctx, op.op_id, () => applySpaceOp(ctx, op)))
  }
  return results
}

async function applySpaceOp(
  ctx: ICtx,
  op: TSpaceOp,
): Promise<{ key?: string; id?: string }> {
  const ts = now()
  switch (op.op) {
    case 'create': {
      const existing = await ctx.db.query(
        'SELECT id FROM space WHERE workspace_id = ? AND key = ?',
        [ctx.workspaceId, op.key],
      )
      if (existing.length > 0)
        throw new ApiError(409, `space ${op.key} already exists`)
      const id = newId('brd')
      await ctx.db.run(
        `INSERT INTO space (id, workspace_id, key, name, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, ctx.workspaceId, op.key, op.name, op.description ?? '', ts, ts],
      )
      if (op.template === 'kanban6') {
        for (const [i, l] of KANBAN6.entries()) {
          await ctx.db.run(
            `INSERT INTO list (id, workspace_id, space_id, name, role, pos)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [newId('lst'), ctx.workspaceId, id, l.name, l.role, (i + 1) * 1024],
          )
        }
      }
      await emitEvent(
        ctx,
        'space.created',
        'space',
        id,
        `created space ${op.key} (${op.name})`,
      )
      return { key: op.key, id }
    }
    case 'update': {
      const space = await spaceByKey(ctx, op.key)
      await ctx.db.run(
        'UPDATE space SET name = COALESCE(?, name), description = COALESCE(?, description), updated_at = ? WHERE id = ?',
        [op.name ?? null, op.description ?? null, ts, space.id],
      )
      await emitEvent(
        ctx,
        'space.updated',
        'space',
        space.id,
        `updated space ${op.key}`,
      )
      return { key: op.key, id: space.id }
    }
    case 'archive': {
      const space = await spaceByKey(ctx, op.key)
      await ctx.db.run(
        'UPDATE space SET archived = 1, updated_at = ? WHERE id = ?',
        [ts, space.id],
      )
      await emitEvent(
        ctx,
        'space.archived',
        'space',
        space.id,
        `archived space ${op.key}`,
      )
      return { key: op.key, id: space.id }
    }
    case 'list_create': {
      const space = await spaceByKey(ctx, op.space)
      const id = newId('lst')
      const pos = op.pos ?? (await tailPos(ctx, 'list', 'space_id', space.id))
      await ctx.db.run(
        'INSERT INTO list (id, workspace_id, space_id, name, role, pos) VALUES (?, ?, ?, ?, ?, ?)',
        [id, ctx.workspaceId, space.id, op.name, op.role, pos],
      )
      await emitEvent(
        ctx,
        'list.created',
        'list',
        id,
        `created list ${op.name} on ${op.space}`,
      )
      return { id }
    }
    case 'list_update': {
      const space = await spaceByKey(ctx, op.space)
      const list = await listByRef(ctx, space.id, op.list)
      await ctx.db.run(
        'UPDATE list SET name = COALESCE(?, name), role = COALESCE(?, role), pos = COALESCE(?, pos) WHERE id = ?',
        [op.name ?? null, op.role ?? null, op.pos ?? null, list.id],
      )
      await emitEvent(
        ctx,
        'list.updated',
        'list',
        list.id,
        `updated list ${list.name} on ${op.space}`,
      )
      return { id: list.id }
    }
    case 'list_archive': {
      const space = await spaceByKey(ctx, op.space)
      const list = await listByRef(ctx, space.id, op.list)
      const open = await ctx.db.query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM item WHERE list_id = ? AND archived = 0',
        [list.id],
      )
      if ((open[0]?.n ?? 0) > 0)
        throw new ApiError(
          409,
          `list ${list.name} still has ${open[0].n} open items`,
        )
      await ctx.db.run('UPDATE list SET archived = 1 WHERE id = ?', [list.id])
      await emitEvent(
        ctx,
        'list.archived',
        'list',
        list.id,
        `archived list ${list.name} on ${op.space}`,
      )
      return { id: list.id }
    }
  }
}
