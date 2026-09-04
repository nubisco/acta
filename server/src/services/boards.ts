import { newId, type TBoardOp, type TOpResult } from '@nubisco/acta-shared'
import type { ICtx } from '../core/ctx'
import { ApiError, now } from '../core/ctx'
import { emitEvent } from '../core/events'
import { withOp } from '../core/ops'
import { boardByKey, listByRef, tailPos } from '../core/store'

const KANBAN6: { name: string; role: string }[] = [
  { name: 'Backlog', role: 'backlog' },
  { name: 'To Do', role: 'backlog' },
  { name: 'In Progress', role: 'active' },
  { name: 'Blocked / Waiting', role: 'blocked' },
  { name: 'Review / Testing', role: 'review' },
  { name: 'Done', role: 'done' },
]

export function boardWrite(ctx: ICtx, ops: TBoardOp[]): TOpResult[] {
  return ops.map((op) => withOp(ctx, op.op_id, () => applyBoardOp(ctx, op)))
}

function applyBoardOp(ctx: ICtx, op: TBoardOp): { key?: string; id?: string } {
  const ts = now()
  switch (op.op) {
    case 'create': {
      const existing = ctx.db.query(
        'SELECT id FROM board WHERE workspace_id = ? AND key = ?',
        [ctx.workspaceId, op.key],
      )
      if (existing.length > 0)
        throw new ApiError(409, `board ${op.key} already exists`)
      const id = newId('brd')
      ctx.db.run(
        `INSERT INTO board (id, workspace_id, key, name, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, ctx.workspaceId, op.key, op.name, op.description ?? '', ts, ts],
      )
      if (op.template === 'kanban6') {
        KANBAN6.forEach((l, i) => {
          ctx.db.run(
            `INSERT INTO list (id, workspace_id, board_id, name, role, pos)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [newId('lst'), ctx.workspaceId, id, l.name, l.role, (i + 1) * 1024],
          )
        })
      }
      emitEvent(
        ctx,
        'board.created',
        'board',
        id,
        `created board ${op.key} (${op.name})`,
      )
      return { key: op.key, id }
    }
    case 'update': {
      const board = boardByKey(ctx, op.key)
      ctx.db.run(
        'UPDATE board SET name = COALESCE(?, name), description = COALESCE(?, description), updated_at = ? WHERE id = ?',
        [op.name ?? null, op.description ?? null, ts, board.id],
      )
      emitEvent(
        ctx,
        'board.updated',
        'board',
        board.id,
        `updated board ${op.key}`,
      )
      return { key: op.key, id: board.id }
    }
    case 'archive': {
      const board = boardByKey(ctx, op.key)
      ctx.db.run('UPDATE board SET archived = 1, updated_at = ? WHERE id = ?', [
        ts,
        board.id,
      ])
      emitEvent(
        ctx,
        'board.archived',
        'board',
        board.id,
        `archived board ${op.key}`,
      )
      return { key: op.key, id: board.id }
    }
    case 'list_create': {
      const board = boardByKey(ctx, op.board)
      const id = newId('lst')
      const pos = op.pos ?? tailPos(ctx, 'list', 'board_id', board.id)
      ctx.db.run(
        'INSERT INTO list (id, workspace_id, board_id, name, role, pos) VALUES (?, ?, ?, ?, ?, ?)',
        [id, ctx.workspaceId, board.id, op.name, op.role, pos],
      )
      emitEvent(
        ctx,
        'list.created',
        'list',
        id,
        `created list ${op.name} on ${op.board}`,
      )
      return { id }
    }
    case 'list_update': {
      const board = boardByKey(ctx, op.board)
      const list = listByRef(ctx, board.id, op.list)
      ctx.db.run(
        'UPDATE list SET name = COALESCE(?, name), role = COALESCE(?, role), pos = COALESCE(?, pos) WHERE id = ?',
        [op.name ?? null, op.role ?? null, op.pos ?? null, list.id],
      )
      emitEvent(
        ctx,
        'list.updated',
        'list',
        list.id,
        `updated list ${list.name} on ${op.board}`,
      )
      return { id: list.id }
    }
    case 'list_archive': {
      const board = boardByKey(ctx, op.board)
      const list = listByRef(ctx, board.id, op.list)
      const open = ctx.db.query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM item WHERE list_id = ? AND archived = 0',
        [list.id],
      )
      if ((open[0]?.n ?? 0) > 0)
        throw new ApiError(
          409,
          `list ${list.name} still has ${open[0].n} open items`,
        )
      ctx.db.run('UPDATE list SET archived = 1 WHERE id = ?', [list.id])
      emitEvent(
        ctx,
        'list.archived',
        'list',
        list.id,
        `archived list ${list.name} on ${op.board}`,
      )
      return { id: list.id }
    }
  }
}
