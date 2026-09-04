import { newId, type TLabelOp, type TOpResult } from '@nubisco/acta-shared'
import type { ICtx } from '../core/ctx'
import { ApiError } from '../core/ctx'
import { emitEvent } from '../core/events'
import { withOp } from '../core/ops'
import { boardByKey, labelByRef } from '../core/store'

export function labelWrite(ctx: ICtx, ops: TLabelOp[]): TOpResult[] {
  return ops.map((op) => withOp(ctx, op.op_id, () => applyLabelOp(ctx, op)))
}

function groupByName(ctx: ICtx, name: string): { id: string } {
  const rows = ctx.db.query<{ id: string }>(
    'SELECT id FROM label_group WHERE workspace_id = ? AND lower(name) = lower(?)',
    [ctx.workspaceId, name],
  )
  if (rows.length === 0)
    throw new ApiError(404, `label group ${name} not found`)
  return rows[0]
}

function applyLabelOp(ctx: ICtx, op: TLabelOp): { id?: string } {
  switch (op.op) {
    case 'group_create': {
      const board = op.board ? boardByKey(ctx, op.board) : null
      const id = newId('lgr')
      ctx.db.run(
        'INSERT INTO label_group (id, workspace_id, board_id, name) VALUES (?, ?, ?, ?)',
        [id, ctx.workspaceId, board?.id ?? null, op.name],
      )
      emitEvent(
        ctx,
        'label.group_created',
        'label_group',
        id,
        `created label group ${op.name}`,
      )
      return { id }
    }
    case 'label_create': {
      const group = groupByName(ctx, op.group)
      const id = newId('lbl')
      ctx.db.run(
        'INSERT INTO label (id, workspace_id, group_id, name, color) VALUES (?, ?, ?, ?, ?)',
        [id, ctx.workspaceId, group.id, op.name, op.color],
      )
      emitEvent(ctx, 'label.created', 'label', id, `created label ${op.name}`)
      return { id }
    }
    case 'label_update': {
      const label = labelByRef(ctx, op.label)
      ctx.db.run(
        'UPDATE label SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?',
        [op.name ?? null, op.color ?? null, label.id],
      )
      emitEvent(
        ctx,
        'label.updated',
        'label',
        label.id,
        `updated label ${label.name}`,
      )
      return { id: label.id }
    }
    case 'label_merge': {
      const from = labelByRef(ctx, op.from)
      const into = labelByRef(ctx, op.into)
      if (from.id === into.id)
        throw new ApiError(400, 'cannot merge a label into itself')
      ctx.db.run(
        `INSERT OR IGNORE INTO item_label (item_id, label_id)
         SELECT item_id, ? FROM item_label WHERE label_id = ?`,
        [into.id, from.id],
      )
      ctx.db.run('DELETE FROM item_label WHERE label_id = ?', [from.id])
      ctx.db.run('DELETE FROM label WHERE id = ?', [from.id])
      emitEvent(
        ctx,
        'label.merged',
        'label',
        into.id,
        `merged label ${from.name} into ${into.name}`,
      )
      return { id: into.id }
    }
    case 'label_delete': {
      const label = labelByRef(ctx, op.label)
      ctx.db.run('DELETE FROM item_label WHERE label_id = ?', [label.id])
      ctx.db.run('DELETE FROM label WHERE id = ?', [label.id])
      emitEvent(
        ctx,
        'label.deleted',
        'label',
        label.id,
        `deleted label ${label.name}`,
      )
      return { id: label.id }
    }
  }
}

/** Seed the default workspace taxonomy (discovery §4). */
export function seedDefaultLabels(ctx: ICtx): void {
  const groupId = newId('lgr')
  ctx.db.run(
    'INSERT INTO label_group (id, workspace_id, board_id, name) VALUES (?, ?, NULL, ?)',
    [groupId, ctx.workspaceId, 'Type'],
  )
  const taxonomy: [string, string][] = [
    ['Bug', 'red'],
    ['Feature', 'green'],
    ['Engineering', 'blue'],
    ['Tech debt', 'yellow'],
    ['Urgent', 'orange'],
    ['Docs', 'sky'],
    ['Marketing', 'purple'],
  ]
  for (const [name, color] of taxonomy) {
    ctx.db.run(
      'INSERT INTO label (id, workspace_id, group_id, name, color) VALUES (?, ?, ?, ?, ?)',
      [newId('lbl'), ctx.workspaceId, groupId, name, color],
    )
  }
}
