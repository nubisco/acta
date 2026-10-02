import { newId, type TLabelOp, type TOpResult } from '@nubisco/acta-shared'
import type { ICtx } from '../core/ctx'
import { ApiError } from '../core/ctx'
import { emitEvent } from '../core/events'
import { withOp } from '../core/ops'
import { spaceByKey, labelByRef } from '../core/store'

export async function labelWrite(
  ctx: ICtx,
  ops: TLabelOp[],
): Promise<TOpResult[]> {
  const results: TOpResult[] = []
  for (const op of ops) {
    results.push(await withOp(ctx, op.op_id, () => applyLabelOp(ctx, op)))
  }
  return results
}

/**
 * A label group by id, by name, or by `SPACE/Name`.
 *
 * Name alone used to be the only way, resolved across the whole workspace,
 * which is fine until two boards each want a group called "Fixes version".
 * That is not a hypothetical: a group is scoped to a space precisely so each
 * product board can carry its own versions, so the moment there is a second
 * product there are two groups with one name. Picking whichever row came
 * back first would write the label into the wrong board's vocabulary.
 *
 * So an ambiguous name is refused rather than guessed at, and the refusal
 * says how to disambiguate.
 */
async function groupByRef(ctx: ICtx, ref: string): Promise<{ id: string }> {
  const byId = await ctx.db.query<{ id: string }>(
    'SELECT id FROM label_group WHERE workspace_id = ? AND id = ?',
    [ctx.workspaceId, ref],
  )
  if (byId.length > 0) return byId[0]

  // `SPACE/Name`, so a caller holding only names can still be exact.
  const slash = ref.indexOf('/')
  if (slash > 0) {
    const space = await spaceByKey(ctx, ref.slice(0, slash))
    const scoped = await ctx.db.query<{ id: string }>(
      `SELECT id FROM label_group
        WHERE workspace_id = ? AND space_id = ? AND lower(name) = lower(?)`,
      [ctx.workspaceId, space.id, ref.slice(slash + 1)],
    )
    if (scoped.length > 0) return scoped[0]
  }

  const rows = await ctx.db.query<{ id: string; space_key: string | null }>(
    `SELECT g.id, b.key AS space_key FROM label_group g
       LEFT JOIN space b ON b.id = g.space_id
      WHERE g.workspace_id = ? AND lower(g.name) = lower(?)`,
    [ctx.workspaceId, ref],
  )
  if (rows.length === 0) throw new ApiError(404, `label group ${ref} not found`)
  if (rows.length > 1) {
    const where = rows.map((r) => r.space_key ?? 'the whole workspace')
    throw new ApiError(
      409,
      `label group ${ref} exists in more than one place (${where.join(', ')}); name it as SPACE/${ref}`,
    )
  }
  return rows[0]
}

async function applyLabelOp(ctx: ICtx, op: TLabelOp): Promise<{ id?: string }> {
  switch (op.op) {
    case 'group_create': {
      const space = op.space ? await spaceByKey(ctx, op.space) : null
      const id = newId('lgr')
      await ctx.db.run(
        'INSERT INTO label_group (id, workspace_id, space_id, name, exclusive) VALUES (?, ?, ?, ?, ?)',
        [id, ctx.workspaceId, space?.id ?? null, op.name, op.exclusive ? 1 : 0],
      )
      await emitEvent(
        ctx,
        'label.group_created',
        'label_group',
        id,
        `created label group ${op.name}`,
      )
      return { id }
    }
    case 'label_create': {
      const group = await groupByRef(ctx, op.group)
      const id = newId('lbl')
      await ctx.db.run(
        'INSERT INTO label (id, workspace_id, group_id, name, color, pos) VALUES (?, ?, ?, ?, ?, ?)',
        [id, ctx.workspaceId, group.id, op.name, op.color, op.pos ?? null],
      )
      await emitEvent(
        ctx,
        'label.created',
        'label',
        id,
        `created label ${op.name}`,
      )
      return { id }
    }
    case 'label_update': {
      const label = await labelByRef(ctx, op.label)
      // pos is three-valued: absent leaves it, null clears it back to
      // by-name, a number sets it. COALESCE cannot express that, so the
      // flag says whether the value was given at all.
      await ctx.db.run(
        `UPDATE label SET name = COALESCE(?, name), color = COALESCE(?, color),
                pos = CASE WHEN ? THEN ? ELSE pos END
          WHERE id = ?`,
        [
          op.name ?? null,
          op.color ?? null,
          op.pos !== undefined ? 1 : 0,
          op.pos ?? null,
          label.id,
        ],
      )
      await emitEvent(
        ctx,
        'label.updated',
        'label',
        label.id,
        `updated label ${label.name}`,
      )
      return { id: label.id }
    }
    case 'group_update': {
      const group = await groupByRef(ctx, op.group)
      await ctx.db.run(
        `UPDATE label_group SET name = COALESCE(?, name),
                exclusive = CASE WHEN ? THEN ? ELSE exclusive END
          WHERE id = ?`,
        [
          op.name ?? null,
          op.exclusive !== undefined ? 1 : 0,
          op.exclusive ? 1 : 0,
          group.id,
        ],
      )
      // Turning a group exclusive does not go back and prune the cards that
      // already carry several. Quietly deleting somebody's data to satisfy a
      // setting is not a thing a settings screen should do, and the next
      // edit of each card settles it.
      await emitEvent(
        ctx,
        'label.group_updated',
        'label_group',
        group.id,
        `updated label group ${op.group}`,
      )
      return { id: group.id }
    }
    case 'label_reorder': {
      const group = await groupByRef(ctx, op.group)
      // Positions assigned from the given order, so the caller hands over
      // what a drag produced and never has to invent numbers. Spaced out so
      // a later single-label move has room between neighbours.
      let pos = 1024
      for (const ref of op.labels) {
        const label = await labelByRef(ctx, ref)
        await ctx.db.run(
          'UPDATE label SET pos = ? WHERE id = ? AND group_id = ?',
          [pos, label.id, group.id],
        )
        pos += 1024
      }
      await emitEvent(
        ctx,
        'label.group_updated',
        'label_group',
        group.id,
        `reordered label group ${op.group}`,
      )
      return { id: group.id }
    }
    case 'label_merge': {
      const from = await labelByRef(ctx, op.from)
      const into = await labelByRef(ctx, op.into)
      if (from.id === into.id)
        throw new ApiError(400, 'cannot merge a label into itself')
      await ctx.db.run(
        `INSERT OR IGNORE INTO item_label (item_id, label_id)
         SELECT item_id, ? FROM item_label WHERE label_id = ?`,
        [into.id, from.id],
      )
      await ctx.db.run('DELETE FROM item_label WHERE label_id = ?', [from.id])
      await ctx.db.run('DELETE FROM label WHERE id = ?', [from.id])
      await emitEvent(
        ctx,
        'label.merged',
        'label',
        into.id,
        `merged label ${from.name} into ${into.name}`,
      )
      return { id: into.id }
    }
    case 'label_delete': {
      const label = await labelByRef(ctx, op.label)
      await ctx.db.run('DELETE FROM item_label WHERE label_id = ?', [label.id])
      await ctx.db.run('DELETE FROM label WHERE id = ?', [label.id])
      await emitEvent(
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
export async function seedDefaultLabels(ctx: ICtx): Promise<void> {
  const groupId = newId('lgr')
  await ctx.db.run(
    'INSERT INTO label_group (id, workspace_id, space_id, name) VALUES (?, ?, NULL, ?)',
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
    await ctx.db.run(
      'INSERT INTO label (id, workspace_id, group_id, name, color) VALUES (?, ?, ?, ?, ?)',
      [newId('lbl'), ctx.workspaceId, groupId, name, color],
    )
  }
}
