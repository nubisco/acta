import { newId, type TSpaceOp, type TOpResult } from '@nubisco/acta-shared'
import type { ICtx } from '../core/ctx'
import { ApiError, now } from '../core/ctx'
import { emitEvent } from '../core/events'
import { withOp } from '../core/ops'
import { spaceByKey, listByRef, tailPos, type IItemRow } from '../core/store'
import { purgeItem } from './items'
import type { AttachmentStore } from './attachments'

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
  store?: AttachmentStore,
): Promise<TOpResult[]> {
  const results: TOpResult[] = []
  for (const op of ops) {
    results.push(
      await withOp(ctx, op.op_id, () => applySpaceOp(ctx, op, store)),
    )
  }
  return results
}

async function applySpaceOp(
  ctx: ICtx,
  op: TSpaceOp,
  store?: AttachmentStore,
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
      if (op.done_window_days !== undefined)
        await ctx.db.run('UPDATE space SET done_window_days = ? WHERE id = ?', [
          op.done_window_days,
          space.id,
        ])
      await emitEvent(
        ctx,
        'space.updated',
        'space',
        space.id,
        `updated space ${op.key}`,
      )
      return { key: op.key, id: space.id }
    }
    case 'clear_done': {
      const space = await spaceByKey(ctx, op.key)
      await ctx.db.run(
        'UPDATE space SET done_cleared_at = ?, updated_at = ? WHERE id = ?',
        [ts, ts, space.id],
      )
      await emitEvent(
        ctx,
        'space.done_cleared',
        'space',
        space.id,
        `cleared the done cards off ${op.key}`,
      )
      return { key: op.key, id: space.id }
    }
    case 'restore': {
      const space = await spaceByKey(ctx, op.key)
      await ctx.db.run(
        'UPDATE space SET archived = 0, updated_at = ? WHERE id = ?',
        [ts, space.id],
      )
      await emitEvent(
        ctx,
        'space.restored',
        'space',
        space.id,
        `restored space ${op.key}`,
      )
      return { key: op.key, id: space.id }
    }
    case 'delete': {
      // Like a card: archive is the reversible step, delete is for good, so
      // a space holding work has to be archived first. An empty space has
      // nothing to lose and goes directly (Jose, 2026-10-09: an empty board
      // had no way of being removed at all). Admins only, as in Trello,
      // Jira, Linear and Asana.
      if (ctx.actor.role !== 'admin')
        throw new ApiError(403, 'only a workspace admin can delete a space')
      const space = await spaceByKey(ctx, op.key)
      const cards = await ctx.db.query<IItemRow>(
        'SELECT * FROM item WHERE space_id = ?',
        [space.id],
      )
      if (cards.length > 0 && space.archived !== 1)
        throw new ApiError(
          409,
          `${op.key} holds ${cards.length} ${cards.length === 1 ? 'card' : 'cards'}; archive the space before deleting it`,
        )
      for (const card of cards) await purgeItem(ctx, card, store)
      // Labels that belong to this space alone go with it.
      await ctx.db.run(
        'DELETE FROM item_label WHERE label_id IN (SELECT l.id FROM label l JOIN label_group g ON g.id = l.group_id WHERE g.space_id = ?)',
        [space.id],
      )
      await ctx.db.run(
        'DELETE FROM label WHERE group_id IN (SELECT id FROM label_group WHERE space_id = ?)',
        [space.id],
      )
      await ctx.db.run('DELETE FROM label_group WHERE space_id = ?', [space.id])
      // Pages filed under the space are somebody's writing: kept, unfiled.
      await ctx.db.run(
        'UPDATE document SET space_id = NULL WHERE space_id = ?',
        [space.id],
      )
      await ctx.db.run('DELETE FROM ingest_token WHERE space_id = ?', [
        space.id,
      ])
      await ctx.db.run('DELETE FROM connection WHERE space_id = ?', [space.id])
      await ctx.db.run('DELETE FROM space_star WHERE space_id = ?', [space.id])
      await ctx.db.run('DELETE FROM list WHERE space_id = ?', [space.id])
      await ctx.db.run('DELETE FROM space WHERE id = ?', [space.id])
      await emitEvent(
        ctx,
        'space.deleted',
        'space',
        space.id,
        cards.length > 0
          ? `deleted space ${op.key} and its ${cards.length} ${cards.length === 1 ? 'card' : 'cards'}`
          : `deleted space ${op.key}`,
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
