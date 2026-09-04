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

export function itemWrite(
  ctx: ICtx,
  ops: TItemOp[],
  defaultBoard?: string,
): TOpResult[] {
  return ops.map((op) =>
    withOp(ctx, op.op_id, () => applyItemOp(ctx, op, defaultBoard)),
  )
}

function bumpRev(ctx: ICtx, item: IItemRow, ifRev?: number): number {
  if (ifRev !== undefined && ifRev !== item.rev) {
    throw new ApiError(409, `rev conflict on ${item.key}`, {
      key: item.key,
      rev: item.rev,
    })
  }
  const rev = item.rev + 1
  ctx.db.run('UPDATE item SET rev = ?, updated_at = ? WHERE id = ?', [
    rev,
    now(),
    item.id,
  ])
  return rev
}

function syncItemFts(ctx: ICtx, itemId: string): void {
  const rows = ctx.db.query<{
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
    ftsUpsert(ctx, 'item', r.key, r.title, r.description, r.board_key)
  }
}

function syncLinks(
  ctx: ICtx,
  srcKind: 'item' | 'comment',
  srcId: string,
  body: string,
): void {
  ctx.db.run('DELETE FROM link WHERE src_kind = ? AND src_id = ?', [
    srcKind,
    srcId,
  ])
  for (const ref of extractRefs(body)) {
    ctx.db.run(
      `INSERT OR IGNORE INTO link (workspace_id, src_kind, src_id, ref_type, target)
       VALUES (?, ?, ?, ?, ?)`,
      [ctx.workspaceId, srcKind, srcId, ref.type, ref.target],
    )
  }
}

function applyItemOp(
  ctx: ICtx,
  op: TItemOp,
  defaultBoard?: string,
): { key?: string; id?: string; rev?: number } {
  const ts = now()
  switch (op.op) {
    case 'create': {
      const boardKey = op.board ?? defaultBoard
      if (!boardKey)
        throw new ApiError(400, 'create requires board (or default_board)')
      const board = boardByKey(ctx, boardKey)
      const list = listByRef(ctx, board.id, op.list)
      const id = newId('itm')
      const seq = board.next_seq
      const key = itemKey(board.key, seq)
      ctx.db.run('UPDATE board SET next_seq = ? WHERE id = ?', [
        seq + 1,
        board.id,
      ])
      ctx.db.run(
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
          op.pos ?? tailPos(ctx, 'item', 'list_id', list.id),
          op.due ?? null,
          ctx.actor.id,
          ts,
          ts,
        ],
      )
      for (const ref of op.labels ?? []) {
        const label = labelByRef(ctx, ref, board.id)
        ctx.db.run(
          'INSERT OR IGNORE INTO item_label (item_id, label_id) VALUES (?, ?)',
          [id, label.id],
        )
      }
      for (const ref of op.assignees ?? []) {
        const actor = actorByRef(ctx, ref)
        ctx.db.run(
          'INSERT OR IGNORE INTO item_assignee (item_id, actor_id) VALUES (?, ?)',
          [id, actor.id],
        )
      }
      for (const [ci, cl] of (op.checklists ?? []).entries()) {
        const clId = newId('chk')
        ctx.db.run(
          'INSERT INTO checklist (id, workspace_id, item_id, name, pos) VALUES (?, ?, ?, ?, ?)',
          [clId, ctx.workspaceId, id, cl.name, (ci + 1) * 1024],
        )
        cl.items.forEach((it, ii) => {
          ctx.db.run(
            'INSERT INTO checklist_item (id, checklist_id, text, done, pos) VALUES (?, ?, ?, ?, ?)',
            [newId('chk'), clId, it.text, it.done ? 1 : 0, (ii + 1) * 1024],
          )
        })
      }
      syncItemFts(ctx, id)
      syncLinks(ctx, 'item', id, op.description ?? '')
      emitEvent(ctx, 'item.created', 'item', id, `created ${key}: ${op.title}`)
      return { key, id, rev: 1 }
    }
    case 'update': {
      const item = itemByKey(ctx, op.key)
      const rev = bumpRev(ctx, item, op.if_rev)
      ctx.db.run(
        'UPDATE item SET title = COALESCE(?, title), description = COALESCE(?, description), due = ? WHERE id = ?',
        [
          op.title ?? null,
          op.description ?? null,
          op.due === undefined ? item.due : op.due,
          item.id,
        ],
      )
      if (op.description !== undefined)
        syncLinks(ctx, 'item', item.id, op.description)
      syncItemFts(ctx, item.id)
      emitEvent(ctx, 'item.updated', 'item', item.id, `updated ${item.key}`)
      return { key: item.key, rev }
    }
    case 'move': {
      const item = itemByKey(ctx, op.key)
      let boardId = item.board_id
      let key = item.key
      if (op.board) {
        const target = boardByKey(ctx, op.board)
        if (target.id !== item.board_id) {
          // Cross-board move: new key, old key becomes an alias (design-spec §1).
          boardId = target.id
          const seq = target.next_seq
          key = itemKey(target.key, seq)
          ctx.db.run('UPDATE board SET next_seq = ? WHERE id = ?', [
            seq + 1,
            target.id,
          ])
          ctx.db.run(
            'INSERT OR IGNORE INTO item_key_alias (workspace_id, key, item_id) VALUES (?, ?, ?)',
            [ctx.workspaceId, item.key, item.id],
          )
          ctx.db.run('UPDATE item SET board_id = ?, key = ? WHERE id = ?', [
            boardId,
            key,
            item.id,
          ])
        }
      }
      const list = listByRef(ctx, boardId, op.list)
      const rev = bumpRev(ctx, item)
      ctx.db.run('UPDATE item SET list_id = ?, pos = ? WHERE id = ?', [
        list.id,
        op.pos ?? tailPos(ctx, 'item', 'list_id', list.id),
        item.id,
      ])
      syncItemFts(ctx, item.id)
      emitEvent(
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
      const item = itemByKey(ctx, op.key)
      const id = newId('cmt')
      ctx.db.run(
        'INSERT INTO comment (id, workspace_id, item_id, actor_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, ctx.workspaceId, item.id, ctx.actor.id, op.body, ts],
      )
      ftsUpsert(ctx, 'comment', id, item.key, op.body)
      syncLinks(ctx, 'comment', id, op.body)
      const rev = bumpRev(ctx, item)
      emitEvent(
        ctx,
        'comment.created',
        'item',
        item.id,
        `commented on ${item.key}`,
      )
      return { key: item.key, id, rev }
    }
    case 'checklist_set': {
      const item = itemByKey(ctx, op.key)
      let checklist = ctx.db.query<{ id: string }>(
        'SELECT id FROM checklist WHERE item_id = ? AND lower(name) = lower(?)',
        [item.id, op.checklist],
      )[0]
      if (!checklist) {
        const clId = newId('chk')
        const clCount = ctx.db.query<{ n: number }>(
          'SELECT COUNT(*) AS n FROM checklist WHERE item_id = ?',
          [item.id],
        )[0].n
        ctx.db.run(
          'INSERT INTO checklist (id, workspace_id, item_id, name, pos) VALUES (?, ?, ?, ?, ?)',
          [clId, ctx.workspaceId, item.id, op.checklist, (clCount + 1) * 1024],
        )
        checklist = { id: clId }
      }
      if (op.items) {
        ctx.db.run('DELETE FROM checklist_item WHERE checklist_id = ?', [
          checklist.id,
        ])
        op.items.forEach((it, ii) => {
          ctx.db.run(
            'INSERT INTO checklist_item (id, checklist_id, text, done, pos) VALUES (?, ?, ?, ?, ?)',
            [
              newId('chk'),
              checklist.id,
              it.text,
              it.done ? 1 : 0,
              (ii + 1) * 1024,
            ],
          )
        })
      }
      for (const text of op.check ?? []) {
        ctx.db.run(
          'UPDATE checklist_item SET done = 1 WHERE checklist_id = ? AND lower(text) = lower(?)',
          [checklist.id, text],
        )
      }
      for (const text of op.uncheck ?? []) {
        ctx.db.run(
          'UPDATE checklist_item SET done = 0 WHERE checklist_id = ? AND lower(text) = lower(?)',
          [checklist.id, text],
        )
      }
      const rev = bumpRev(ctx, item)
      emitEvent(
        ctx,
        'item.checklist',
        'item',
        item.id,
        `updated checklist on ${item.key}`,
      )
      return { key: item.key, rev }
    }
    case 'label': {
      const item = itemByKey(ctx, op.key)
      for (const ref of op.add ?? []) {
        const label = labelByRef(ctx, ref, item.board_id)
        ctx.db.run(
          'INSERT OR IGNORE INTO item_label (item_id, label_id) VALUES (?, ?)',
          [item.id, label.id],
        )
      }
      for (const ref of op.remove ?? []) {
        const label = labelByRef(ctx, ref, item.board_id)
        ctx.db.run(
          'DELETE FROM item_label WHERE item_id = ? AND label_id = ?',
          [item.id, label.id],
        )
      }
      const rev = bumpRev(ctx, item)
      emitEvent(
        ctx,
        'item.labeled',
        'item',
        item.id,
        `labels changed on ${item.key}`,
      )
      return { key: item.key, rev }
    }
    case 'assign': {
      const item = itemByKey(ctx, op.key)
      for (const ref of op.add ?? []) {
        const actor = actorByRef(ctx, ref)
        ctx.db.run(
          'INSERT OR IGNORE INTO item_assignee (item_id, actor_id) VALUES (?, ?)',
          [item.id, actor.id],
        )
      }
      for (const ref of op.remove ?? []) {
        const actor = actorByRef(ctx, ref)
        ctx.db.run(
          'DELETE FROM item_assignee WHERE item_id = ? AND actor_id = ?',
          [item.id, actor.id],
        )
      }
      const rev = bumpRev(ctx, item)
      emitEvent(
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
      const item = itemByKey(ctx, op.key)
      const rev = bumpRev(ctx, item)
      const field =
        op.op === 'archive' || op.op === 'restore' ? 'archived' : 'completed'
      const value = op.op === 'archive' || op.op === 'complete' ? 1 : 0
      ctx.db.run(`UPDATE item SET ${field} = ? WHERE id = ?`, [value, item.id])
      const verb = {
        archive: 'item.archived',
        restore: 'item.restored',
        complete: 'item.completed',
        reopen: 'item.reopened',
      }[op.op]
      emitEvent(ctx, verb, 'item', item.id, `${op.op} ${item.key}`)
      return { key: item.key, rev }
    }
  }
}
