/**
 * API operation schemas (design-spec §4). Shared by the REST routes, the MCP
 * tools, the web client, and the importers, so every surface speaks the same
 * batch-op dialect.
 */

import { z } from 'zod'
import { BOARD_KEY_RE, DOC_SLUG_RE, ITEM_KEY_RE } from './keys'

export const zBoardKey = z.string().regex(BOARD_KEY_RE)
export const zItemKey = z.string().regex(ITEM_KEY_RE)
export const zDocSlug = z.string().regex(DOC_SLUG_RE)
export const zOpId = z.string().min(1).max(200)
export const zListRole = z.enum([
  'backlog',
  'active',
  'blocked',
  'review',
  'done',
  'inbox',
  'none',
])

// --------------------------------------------------------------------------
// item_write ops
// --------------------------------------------------------------------------

const itemFields = {
  title: z.string().min(1).max(500),
  description: z.string().max(100_000),
  due: z.number().int().nullable(),
  labels: z.array(z.string()).max(50),
  assignees: z.array(z.string()).max(20),
}

export const zItemCreateOp = z.object({
  op: z.literal('create'),
  op_id: zOpId,
  board: zBoardKey.optional(),
  list: z.string().min(1),
  title: itemFields.title,
  description: itemFields.description.optional(),
  labels: itemFields.labels.optional(),
  assignees: itemFields.assignees.optional(),
  due: itemFields.due.optional(),
  pos: z.number().optional(),
  checklists: z
    .array(
      z.object({
        name: z.string().min(1),
        items: z.array(
          z.object({ text: z.string(), done: z.boolean().default(false) }),
        ),
      }),
    )
    .optional(),
})

export const zItemUpdateOp = z.object({
  op: z.literal('update'),
  op_id: zOpId,
  key: zItemKey,
  if_rev: z.number().int().optional(),
  title: itemFields.title.optional(),
  description: itemFields.description.optional(),
  due: itemFields.due.optional(),
})

export const zItemMoveOp = z.object({
  op: z.literal('move'),
  op_id: zOpId,
  key: zItemKey,
  board: zBoardKey.optional(),
  list: z.string().min(1),
  pos: z.number().optional(),
})

export const zItemCommentOp = z.object({
  op: z.literal('comment'),
  op_id: zOpId,
  key: zItemKey,
  body: z.string().min(1).max(50_000),
})

export const zItemChecklistSetOp = z.object({
  op: z.literal('checklist_set'),
  op_id: zOpId,
  key: zItemKey,
  checklist: z.string().min(1),
  items: z
    .array(z.object({ text: z.string(), done: z.boolean().default(false) }))
    .optional(),
  check: z.array(z.string()).optional(),
  uncheck: z.array(z.string()).optional(),
})

export const zItemLabelOp = z.object({
  op: z.literal('label'),
  op_id: zOpId,
  key: zItemKey,
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
})

export const zItemAssignOp = z.object({
  op: z.literal('assign'),
  op_id: zOpId,
  key: zItemKey,
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
})

const simpleItemOp = <N extends string>(name: N) =>
  z.object({ op: z.literal(name), op_id: zOpId, key: zItemKey })

export const zItemOp = z.discriminatedUnion('op', [
  zItemCreateOp,
  zItemUpdateOp,
  zItemMoveOp,
  zItemCommentOp,
  zItemChecklistSetOp,
  zItemLabelOp,
  zItemAssignOp,
  simpleItemOp('archive'),
  simpleItemOp('restore'),
  simpleItemOp('complete'),
  simpleItemOp('reopen'),
])
export type TItemOp = z.infer<typeof zItemOp>

export const zItemWrite = z.object({
  default_board: zBoardKey.optional(),
  ops: z.array(zItemOp).min(1).max(100),
})

// --------------------------------------------------------------------------
// board_write ops
// --------------------------------------------------------------------------

export const zBoardOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    op_id: zOpId,
    key: zBoardKey,
    name: z.string().min(1).max(200),
    description: z.string().max(10_000).optional(),
    template: z.enum(['kanban6', 'none']).default('kanban6'),
  }),
  z.object({
    op: z.literal('update'),
    op_id: zOpId,
    key: zBoardKey,
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(10_000).optional(),
  }),
  z.object({ op: z.literal('archive'), op_id: zOpId, key: zBoardKey }),
  z.object({
    op: z.literal('list_create'),
    op_id: zOpId,
    board: zBoardKey,
    name: z.string().min(1).max(200),
    role: zListRole.default('none'),
    pos: z.number().optional(),
  }),
  z.object({
    op: z.literal('list_update'),
    op_id: zOpId,
    board: zBoardKey,
    list: z.string().min(1),
    name: z.string().min(1).max(200).optional(),
    role: zListRole.optional(),
    pos: z.number().optional(),
  }),
  z.object({
    op: z.literal('list_archive'),
    op_id: zOpId,
    board: zBoardKey,
    list: z.string().min(1),
  }),
])
export type TBoardOp = z.infer<typeof zBoardOp>

export const zBoardWrite = z.object({ ops: z.array(zBoardOp).min(1).max(50) })

// --------------------------------------------------------------------------
// doc_write ops
// --------------------------------------------------------------------------

export const zDocOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    op_id: zOpId,
    slug: zDocSlug,
    title: z.string().min(1).max(300),
    parent: zDocSlug.optional(),
    body: z.string().max(500_000).default(''),
    layout: z.enum(['default', 'wide']).default('default'),
    tags: z.array(z.string()).max(20).default([]),
    board: zBoardKey.optional(),
  }),
  z.object({
    op: z.literal('replace'),
    op_id: zOpId,
    ref: zDocSlug,
    if_rev: z.number().int(),
    body: z.string().max(500_000),
  }),
  z.object({
    op: z.literal('patch_section'),
    op_id: zOpId,
    ref: zDocSlug,
    section: z.string().min(1),
    if_hash: z.string().min(1),
    body: z.string().max(500_000),
    mode: z.enum(['replace', 'append', 'insert_after']).default('replace'),
  }),
  z.object({
    op: z.literal('append'),
    op_id: zOpId,
    ref: zDocSlug,
    body: z.string().min(1).max(100_000),
  }),
  z.object({
    op: z.literal('move'),
    op_id: zOpId,
    ref: zDocSlug,
    parent: zDocSlug.nullable().optional(),
    position: z.number().optional(),
  }),
  z.object({
    op: z.literal('rename'),
    op_id: zOpId,
    ref: zDocSlug,
    title: z.string().min(1).max(300).optional(),
    slug: zDocSlug.optional(),
  }),
  z.object({ op: z.literal('archive'), op_id: zOpId, ref: zDocSlug }),
])
export type TDocOp = z.infer<typeof zDocOp>

export const zDocWrite = z.object({ ops: z.array(zDocOp).min(1).max(50) })

// --------------------------------------------------------------------------
// label_write ops
// --------------------------------------------------------------------------

export const zLabelOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('group_create'),
    op_id: zOpId,
    name: z.string().min(1).max(100),
    board: zBoardKey.optional(),
  }),
  z.object({
    op: z.literal('label_create'),
    op_id: zOpId,
    group: z.string().min(1),
    name: z.string().min(1).max(100),
    color: z.string().min(1).max(30).default('gray'),
  }),
  z.object({
    op: z.literal('label_update'),
    op_id: zOpId,
    label: z.string().min(1),
    name: z.string().min(1).max(100).optional(),
    color: z.string().min(1).max(30).optional(),
  }),
  z.object({
    op: z.literal('label_merge'),
    op_id: zOpId,
    from: z.string().min(1),
    into: z.string().min(1),
  }),
  z.object({
    op: z.literal('label_delete'),
    op_id: zOpId,
    label: z.string().min(1),
  }),
])
export type TLabelOp = z.infer<typeof zLabelOp>

export const zLabelWrite = z.object({ ops: z.array(zLabelOp).min(1).max(50) })

// --------------------------------------------------------------------------
// Reads
// --------------------------------------------------------------------------

export const zBoardGet = z.object({
  board: zBoardKey,
  list: z.string().optional(),
  label: z.string().optional(),
  assignee: z.string().optional(),
  state: z.enum(['open', 'done', 'archived', 'all']).default('open'),
  text: z.string().optional(),
  updated_since: z.number().int().optional(),
  detail: z.enum(['compact', 'full']).default('compact'),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(100),
})

export const zItemGet = z.object({
  keys: z.array(zItemKey).min(1).max(50),
  include: z
    .array(
      z.enum(['comments', 'checklists', 'links', 'activity', 'attachments']),
    )
    .optional(),
})

export const zSearch = z.object({
  query: z.string().min(1).max(500),
  types: z.array(z.enum(['item', 'doc', 'comment'])).optional(),
  board: zBoardKey.optional(),
  limit: z.number().int().min(1).max(50).default(20),
})

export const zActivityQuery = z.object({
  entity: z.string().optional(),
  actor: z.string().optional(),
  actor_kind: z.enum(['human', 'agent', 'system']).optional(),
  verb: z.string().optional(),
  since: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
})

// --------------------------------------------------------------------------
// Ingest
// --------------------------------------------------------------------------

export const zIngest = z.object({
  board: zBoardKey.optional(),
  list: z.string().optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(100_000).optional(),
  labels: z.array(z.string()).max(20).optional(),
  meta: z.record(z.string(), z.string()).optional(),
})

// --------------------------------------------------------------------------
// Op results
// --------------------------------------------------------------------------

export interface IOpOk {
  op_id: string
  ok: true
  key?: string
  slug?: string
  id?: string
  rev?: number
}

export interface IOpErr {
  op_id: string
  ok: false
  error: string
  current?: unknown
}

export type TOpResult = IOpOk | IOpErr
