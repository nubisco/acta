import {
  extractRefs,
  itemKey,
  newId,
  type TItemOp,
  type TOpResult,
} from '@nubisco/acta-shared'
import type { ICtx } from '../core/ctx'
import { ApiError, now } from '../core/ctx'
import { emitEvent } from '../core/events'
import { ftsUpsert } from '../core/fts'
import { withOp } from '../core/ops'
import {
  actorByRef,
  boardByKey,
  itemByKey,
  labelByRef,
  listByRef,
  tailPos,
  type IItemRow,
} from '../core/store'

export async function itemWrite(
  ctx: ICtx,
  ops: TItemOp[],
  defaultBoard?: string,
): Promise<TOpResult[]> {
  const results: TOpResult[] = []
  for (const op of ops) {
    results.push(
      await withOp(ctx, op.op_id, () => applyItemOp(ctx, op, defaultBoard)),
    )
  }
  return results
}

async function bumpRev(
  ctx: ICtx,
  item: IItemRow,
  ifRev?: number,
): Promise<number> {
  if (ifRev !== undefined && ifRev !== item.rev) {
    throw new ApiError(409, `rev conflict on ${item.key}`, {
      key: item.key,
      rev: item.rev,
    })
  }
  const rev = item.rev + 1
  await ctx.db.run('UPDATE item SET rev = ?, updated_at = ? WHERE id = ?', [
    rev,
    now(),
    item.id,
  ])
  return rev
}

async function syncItemFts(ctx: ICtx, itemId: string): Promise<void> {
  const rows = await ctx.db.query<{
    key: string
    title: string
    description: string
    board_key: string
  }>(
    `SELECT i.key, i.title, i.description, b.key AS board_key
       FROM item i JOIN board b ON b.id = i.board_id WHERE i.id = ?`,
    [itemId],
  )
  if (rows.length > 0) {
    const r = rows[0]
    await ftsUpsert(ctx, 'item', r.key, r.title, r.description, r.board_key)
  }
}

async function syncLinks(
  ctx: ICtx,
  srcKind: 'item' | 'comment',
  srcId: string,
  body: string,
): Promise<void> {
  await ctx.db.run('DELETE FROM link WHERE src_kind = ? AND src_id = ?', [
    srcKind,
    srcId,
  ])
  for (const ref of extractRefs(body)) {
    await ctx.db.run(
      `INSERT OR IGNORE INTO link (workspace_id, src_kind, src_id, ref_type, target)
       VALUES (?, ?, ?, ?, ?)`,
      [ctx.workspaceId, srcKind, srcId, ref.type, ref.target],
    )
  }
}

async function applyItemOp(
  ctx: ICtx,
  op: TItemOp,
  defaultBoard?: string,
): Promise<{ key?: string; id?: string; rev?: number }> {
  const ts = now()
  switch (op.op) {
    case 'create': {
      const boardKey = op.board ?? defaultBoard
      if (!boardKey)
        throw new ApiError(400, 'create requires board (or default_board)')
      const board = await boardByKey(ctx, boardKey)
      const list = await listByRef(ctx, board.id, op.list)
      const id = newId('itm')
      const seq = board.next_seq
      const key = itemKey(board.key, seq)
      await ctx.db.run('UPDATE board SET next_seq = ? WHERE id = ?', [
        seq + 1,
        board.id,
      ])
      await ctx.db.run(
        `INSERT INTO item (id, workspace_id, board_id, list_id, key, title, description, pos, due, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          ctx.workspaceId,
          board.id,
          list.id,
          key,
          op.title,
          op.description ?? '',
          op.pos ?? (await tailPos(ctx, 'item', 'list_id', list.id)),
          op.due ?? null,
          ctx.actor.id,
          ts,
          ts,
        ],
      )
      for (const ref of op.labels ?? []) {
        const label = await labelByRef(ctx, ref, board.id)
        await ctx.db.run(
          'INSERT OR IGNORE INTO item_label (item_id, label_id) VALUES (?, ?)',
          [id, label.id],
        )
      }
      for (const ref of op.assignees ?? []) {
        const actor = await actorByRef(ctx, ref)
        await ctx.db.run(
          'INSERT OR IGNORE INTO item_assignee (item_id, actor_id) VALUES (?, ?)',
          [id, actor.id],
        )
      }
      for (const [ci, cl] of (op.checklists ?? []).entries()) {
        const clId = newId('chk')
        await ctx.db.run(
          'INSERT INTO checklist (id, workspace_id, item_id, name, pos) VALUES (?, ?, ?, ?, ?)',
          [clId, ctx.workspaceId, id, cl.name, (ci + 1) * 1024],
        )
        for (const [ii, it] of cl.items.entries()) {
          await ctx.db.run(
            'INSERT INTO checklist_item (id, checklist_id, text, done, pos) VALUES (?, ?, ?, ?, ?)',
            [newId('chk'), clId, it.text, it.done ? 1 : 0, (ii + 1) * 1024],
          )
        }
      }
      await syncItemFts(ctx, id)
      await syncLinks(ctx, 'item', id, op.description ?? '')
      await emitEvent(
        ctx,
        'item.created',
        'item',
        id,
        `created ${key}: ${op.title}`,
      )
      return { key, id, rev: 1 }
    }
    case 'update': {
      const item = await itemByKey(ctx, op.key)
      const rev = await bumpRev(ctx, item, op.if_rev)
      await ctx.db.run(
        'UPDATE item SET title = COALESCE(?, title), description = COALESCE(?, description), due = ? WHERE id = ?',
        [
          op.title ?? null,
          op.description ?? null,
          op.due === undefined ? item.due : op.due,
          item.id,
        ],
      )
      if (op.description !== undefined)
        await syncLinks(ctx, 'item', item.id, op.description)
      await syncItemFts(ctx, item.id)
      await emitEvent(
        ctx,
        'item.updated',
        'item',
        item.id,
        `updated ${item.key}`,
      )
      return { key: item.key, rev }
    }
    case 'move': {
      const item = await itemByKey(ctx, op.key)
      let boardId = item.board_id
      let key = item.key
      if (op.board) {
        const target = await boardByKey(ctx, op.board)
        if (target.id !== item.board_id) {
          // Cross-board move: new key, old key becomes an alias (design-spec §1).
          boardId = target.id
          const seq = target.next_seq
          key = itemKey(target.key, seq)
          await ctx.db.run('UPDATE board SET next_seq = ? WHERE id = ?', [
            seq + 1,
            target.id,
          ])
          await ctx.db.run(
            'INSERT OR IGNORE INTO item_key_alias (workspace_id, key, item_id) VALUES (?, ?, ?)',
            [ctx.workspaceId, item.key, item.id],
          )
          await ctx.db.run(
            'UPDATE item SET board_id = ?, key = ? WHERE id = ?',
            [boardId, key, item.id],
          )
        }
      }
      const list = await listByRef(ctx, boardId, op.list)
      const rev = await bumpRev(ctx, item)
      await ctx.db.run('UPDATE item SET list_id = ?, pos = ? WHERE id = ?', [
        list.id,
        op.pos ?? (await tailPos(ctx, 'item', 'list_id', list.id)),
        item.id,
      ])
      await syncItemFts(ctx, item.id)
      await emitEvent(
        ctx,
        'item.moved',
        'item',
        item.id,
        `moved ${key} to ${list.name}`,
        {
          list: list.name,
          from_key: item.key !== key ? item.key : undefined,
        },
      )
      return { key, rev }
    }
    case 'comment': {
      const item = await itemByKey(ctx, op.key)
      const id = newId('cmt')
      await ctx.db.run(
        'INSERT INTO comment (id, workspace_id, item_id, actor_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, ctx.workspaceId, item.id, ctx.actor.id, op.body, ts],
      )
      await ftsUpsert(ctx, 'comment', id, item.key, op.body)
      await syncLinks(ctx, 'comment', id, op.body)
      const rev = await bumpRev(ctx, item)
      await emitEvent(
        ctx,
        'comment.created',
        'item',
        item.id,
        `commented on ${item.key}`,
      )
      return { key: item.key, id, rev }
    }
    case 'checklist_set': {
      const item = await itemByKey(ctx, op.key)
      let checklist = (
        await ctx.db.query<{ id: string }>(
          'SELECT id FROM checklist WHERE item_id = ? AND lower(name) = lower(?)',
          [item.id, op.checklist],
        )
      )[0]
      if (!checklist) {
        const clId = newId('chk')
        const clCount = (
          await ctx.db.query<{ n: number }>(
            'SELECT COUNT(*) AS n FROM checklist WHERE item_id = ?',
            [item.id],
          )
        )[0].n
        await ctx.db.run(
          'INSERT INTO checklist (id, workspace_id, item_id, name, pos) VALUES (?, ?, ?, ?, ?)',
          [clId, ctx.workspaceId, item.id, op.checklist, (clCount + 1) * 1024],
        )
        checklist = { id: clId }
      }
      if (op.items) {
        await ctx.db.run('DELETE FROM checklist_item WHERE checklist_id = ?', [
          checklist.id,
        ])
        for (const [ii, it] of op.items.entries()) {
          await ctx.db.run(
            'INSERT INTO checklist_item (id, checklist_id, text, done, pos) VALUES (?, ?, ?, ?, ?)',
            [
              newId('chk'),
              checklist.id,
              it.text,
              it.done ? 1 : 0,
              (ii + 1) * 1024,
            ],
          )
        }
      }
      for (const text of op.check ?? []) {
        await ctx.db.run(
          'UPDATE checklist_item SET done = 1 WHERE checklist_id = ? AND lower(text) = lower(?)',
          [checklist.id, text],
        )
      }
      for (const text of op.uncheck ?? []) {
        await ctx.db.run(
          'UPDATE checklist_item SET done = 0 WHERE checklist_id = ? AND lower(text) = lower(?)',
          [checklist.id, text],
        )
      }
      const rev = await bumpRev(ctx, item)
      await emitEvent(
        ctx,
        'item.checklist',
        'item',
        item.id,
        `updated checklist on ${item.key}`,
      )
      return { key: item.key, rev }
    }
    case 'label': {
      const item = await itemByKey(ctx, op.key)
      for (const ref of op.add ?? []) {
        const label = await labelByRef(ctx, ref, item.board_id)
        await ctx.db.run(
          'INSERT OR IGNORE INTO item_label (item_id, label_id) VALUES (?, ?)',
          [item.id, label.id],
        )
      }
      for (const ref of op.remove ?? []) {
        const label = await labelByRef(ctx, ref, item.board_id)
        await ctx.db.run(
          'DELETE FROM item_label WHERE item_id = ? AND label_id = ?',
          [item.id, label.id],
        )
      }
      const rev = await bumpRev(ctx, item)
      await emitEvent(
        ctx,
        'item.labeled',
        'item',
        item.id,
        `labels changed on ${item.key}`,
      )
      return { key: item.key, rev }
    }
    case 'assign': {
      const item = await itemByKey(ctx, op.key)
      for (const ref of op.add ?? []) {
        const actor = await actorByRef(ctx, ref)
        await ctx.db.run(
          'INSERT OR IGNORE INTO item_assignee (item_id, actor_id) VALUES (?, ?)',
          [item.id, actor.id],
        )
      }
      for (const ref of op.remove ?? []) {
        const actor = await actorByRef(ctx, ref)
        await ctx.db.run(
          'DELETE FROM item_assignee WHERE item_id = ? AND actor_id = ?',
          [item.id, actor.id],
        )
      }
      const rev = await bumpRev(ctx, item)
      await emitEvent(
        ctx,
        'item.assigned',
        'item',
        item.id,
        `assignees changed on ${item.key}`,
      )
      return { key: item.key, rev }
    }
    case 'archive':
    case 'restore':
    case 'complete':
    case 'reopen': {
      const item = await itemByKey(ctx, op.key)
      const rev = await bumpRev(ctx, item)
      const field =
        op.op === 'archive' || op.op === 'restore' ? 'archived' : 'completed'
      const value = op.op === 'archive' || op.op === 'complete' ? 1 : 0
      await ctx.db.run(`UPDATE item SET ${field} = ? WHERE id = ?`, [
        value,
        item.id,
      ])
      const verb = {
        archive: 'item.archived',
        restore: 'item.restored',
        complete: 'item.completed',
        reopen: 'item.reopened',
      }[op.op]
      await emitEvent(ctx, verb, 'item', item.id, `${op.op} ${item.key}`)
      return { key: item.key, rev }
    }
  }
}
