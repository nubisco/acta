/**
 * Rules kernel stub (design-spec §6): fixed trigger/condition/action catalog,
 * rules are data. Executed on the event stream with system-actor attribution,
 * caused_by chaining, and a depth-1 loop guard.
 */

import { newId, parseEmbedQuery, type IEmbedQuery } from '@nubisco/acta-shared'
import { z } from 'zod'
import type { ICtx } from '../core/ctx'
import { ApiError, now } from '../core/ctx'
import { emitEvent, onEvent, type IEvent } from '../core/events'
import { withOp } from '../core/ops'
import type { ISqlDriver } from '../db'
import { itemWrite } from './items'
import { matchesPattern } from './webhooks'

export const zRuleAction = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('move_item'),
    board: z.string().optional(),
    list: z.string().min(1),
  }),
  z.object({ kind: z.literal('apply_label'), label: z.string().min(1) }),
  z.object({ kind: z.literal('assign'), actor: z.string().min(1) }),
  z.object({ kind: z.literal('comment'), body: z.string().min(1).max(10_000) }),
  z.object({ kind: z.literal('complete') }),
  z.object({ kind: z.literal('call_webhook'), url: z.url() }),
])

export const zRuleOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    op_id: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    trigger: z.string().min(1).max(100),
    condition: z.string().max(500).optional(),
    action: zRuleAction,
    enabled: z.boolean().default(true),
  }),
  z.object({
    op: z.literal('update'),
    op_id: z.string().min(1).max(200),
    id: z.string().min(1),
    name: z.string().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('delete'),
    op_id: z.string().min(1).max(200),
    id: z.string().min(1),
  }),
])
export type TRuleOp = z.infer<typeof zRuleOp>
export const zRuleWrite = z.object({ ops: z.array(zRuleOp).min(1).max(20) })

export function ruleWrite(ctx: ICtx, ops: TRuleOp[]) {
  return ops.map((op) =>
    withOp(ctx, op.op_id, () => {
      switch (op.op) {
        case 'create': {
          if (op.condition && parseEmbedQuery(op.condition) === null)
            throw new ApiError(400, `invalid condition: ${op.condition}`)
          const id = newId('rul')
          ctx.db.run(
            'INSERT INTO rule (id, workspace_id, name, trigger, condition, action, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
              id,
              ctx.workspaceId,
              op.name,
              op.trigger,
              op.condition ?? null,
              JSON.stringify(op.action),
              op.enabled ? 1 : 0,
              now(),
            ],
          )
          emitEvent(ctx, 'rule.created', 'rule', id, `created rule ${op.name}`)
          return { id }
        }
        case 'update': {
          const rows = ctx.db.query<{ id: string }>(
            'SELECT id FROM rule WHERE workspace_id = ? AND id = ?',
            [ctx.workspaceId, op.id],
          )
          if (rows.length === 0)
            throw new ApiError(404, `rule ${op.id} not found`)
          ctx.db.run(
            'UPDATE rule SET name = COALESCE(?, name), enabled = COALESCE(?, enabled) WHERE id = ?',
            [
              op.name ?? null,
              op.enabled === undefined ? null : op.enabled ? 1 : 0,
              op.id,
            ],
          )
          emitEvent(ctx, 'rule.updated', 'rule', op.id, `updated rule`)
          return { id: op.id }
        }
        case 'delete': {
          ctx.db.run('DELETE FROM rule WHERE workspace_id = ? AND id = ?', [
            ctx.workspaceId,
            op.id,
          ])
          emitEvent(ctx, 'rule.deleted', 'rule', op.id, `deleted rule`)
          return { id: op.id }
        }
      }
    }),
  )
}

export function ruleList(ctx: ICtx) {
  return {
    rules: ctx.db
      .query<{
        id: string
        name: string
        trigger: string
        condition: string | null
        action: string
        enabled: number
      }>(
        'SELECT id, name, trigger, condition, action, enabled FROM rule WHERE workspace_id = ?',
        [ctx.workspaceId],
      )
      .map((r) => ({
        id: r.id,
        name: r.name,
        trigger: r.trigger,
        condition: r.condition ?? undefined,
        action: JSON.parse(r.action),
        enabled: r.enabled === 1,
      })),
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function itemMatches(
  db: ISqlDriver,
  workspaceId: string,
  itemId: string,
  condition: IEmbedQuery,
): boolean {
  const rows = db.query<{
    board_key: string
    list_name: string
    completed: number
    archived: number
  }>(
    `SELECT b.key AS board_key, l.name AS list_name, i.completed, i.archived
       FROM item i JOIN board b ON b.id = i.board_id JOIN list l ON l.id = i.list_id
      WHERE i.workspace_id = ? AND i.id = ?`,
    [workspaceId, itemId],
  )
  if (rows.length === 0) return false
  const item = rows[0]
  if (condition.board && condition.board !== item.board_key) return false
  if (
    condition.list &&
    condition.list.toLowerCase() !== item.list_name.toLowerCase()
  )
    return false
  if (
    condition.state === 'open' &&
    (item.archived === 1 || item.completed === 1)
  )
    return false
  if (condition.state === 'done' && item.completed !== 1) return false
  if (condition.state === 'archived' && item.archived !== 1) return false
  if (condition.label) {
    const has = db.query(
      `SELECT 1 FROM item_label il JOIN label lb ON lb.id = il.label_id
        WHERE il.item_id = ? AND lower(lb.name) = lower(?)`,
      [itemId, condition.label],
    )
    if (has.length === 0) return false
  }
  if (condition.assignee) {
    const has = db.query(
      `SELECT 1 FROM item_assignee ia JOIN actor a ON a.id = ia.actor_id
        WHERE ia.item_id = ? AND a.handle = ?`,
      [itemId, condition.assignee],
    )
    if (has.length === 0) return false
  }
  return true
}

export interface IRulesEngineOptions {
  fetchImpl?: typeof fetch
}

/** Subscribe the rules engine to the event stream. Returns an unsubscribe fn. */
export function startRulesEngine(
  db: ISqlDriver,
  opts: IRulesEngineOptions = {},
): () => void {
  const fetchImpl = opts.fetchImpl ?? fetch

  return onEvent((event) => {
    // Loop guard (design-spec §6): actions caused by a rule never re-trigger.
    if (event.caused_by) return
    if (event.entity !== 'item') return

    const rules = db.query<{
      id: string
      name: string
      trigger: string
      condition: string | null
      action: string
    }>(
      'SELECT id, name, trigger, condition, action FROM rule WHERE workspace_id = ? AND enabled = 1',
      [event.workspace_id],
    )
    for (const rule of rules) {
      if (!matchesPattern(rule.trigger, event.verb)) continue
      if (rule.condition) {
        const condition = parseEmbedQuery(rule.condition)
        if (
          !condition ||
          !itemMatches(db, event.workspace_id, event.entity_id, condition)
        )
          continue
      }
      executeRule(db, rule, event, fetchImpl)
    }
  })
}

function executeRule(
  db: ISqlDriver,
  rule: { id: string; name: string; action: string },
  event: IEvent,
  fetchImpl: typeof fetch,
): void {
  const system = db.query<{ id: string; handle: string }>(
    "SELECT id, handle FROM actor WHERE workspace_id = ? AND kind = 'system' LIMIT 1",
    [event.workspace_id],
  )[0]
  const ctx: ICtx = {
    db,
    workspaceId: event.workspace_id,
    actor: {
      id: system.id,
      kind: 'system',
      handle: system.handle,
      role: 'member',
      scopes: ['read', 'write'],
    },
    causedBy: event.id,
  }
  const item = db.query<{ key: string }>('SELECT key FROM item WHERE id = ?', [
    event.entity_id,
  ])
  if (item.length === 0) return
  const key = item[0].key
  const action = JSON.parse(rule.action) as z.infer<typeof zRuleAction>
  const opId = `rule:${rule.id}:${event.id}`

  switch (action.kind) {
    case 'move_item':
      itemWrite(ctx, [
        {
          op: 'move',
          op_id: opId,
          key,
          board: action.board,
          list: action.list,
        },
      ])
      break
    case 'apply_label':
      itemWrite(ctx, [{ op: 'label', op_id: opId, key, add: [action.label] }])
      break
    case 'assign':
      itemWrite(ctx, [{ op: 'assign', op_id: opId, key, add: [action.actor] }])
      break
    case 'comment':
      itemWrite(ctx, [{ op: 'comment', op_id: opId, key, body: action.body }])
      break
    case 'complete':
      itemWrite(ctx, [{ op: 'complete', op_id: opId, key }])
      break
    case 'call_webhook':
      void fetchImpl(action.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rule: rule.name,
          event: event.verb,
          item: key,
          summary: event.summary,
        }),
      }).catch(() => {})
      break
  }
}
