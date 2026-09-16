/**
 * API operation schemas (design-spec §4). Shared by the REST routes, the MCP
 * tools, the web client, and the importers, so every surface speaks the same
 * batch-op dialect.
 */

import { z } from 'zod'
import { SPACE_KEY_RE, DOC_SLUG_RE, ITEM_KEY_RE } from './keys'
import { ANCHOR_CONTEXT_LENGTH, ANCHOR_MAX_LENGTH } from './anchors'

export const zSpaceKey = z.string().regex(SPACE_KEY_RE)
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
// Imported provenance (migrations). Stored verbatim, shown by the UI so
// migrated content keeps its true author and dates instead of the importer's.
// --------------------------------------------------------------------------

export const zImportedMeta = z.object({
  /** Where this came from: 'trello', 'confluence', or another system name. */
  source: z.string().min(1).max(40),
  /** Original author display name. */
  author: z.string().max(200).optional(),
  /** Original creation timestamp (ISO 8601). */
  created_at: z.string().max(40).optional(),
  /** Original last-update timestamp (ISO 8601). */
  updated_at: z.string().max(40).optional(),
  /** Canonical URL in the source system. */
  url: z.string().max(500).optional(),
  /** Revision count in the source system, when it had versions. */
  versions: z.number().int().min(1).optional(),
})
export type TImportedMeta = z.infer<typeof zImportedMeta>

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
  space: zSpaceKey.optional(),
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
  imported_meta: zImportedMeta.optional(),
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
  space: zSpaceKey.optional(),
  list: z.string().min(1),
  pos: z.number().optional(),
})

export const zItemCommentOp = z.object({
  op: z.literal('comment'),
  op_id: zOpId,
  key: zItemKey,
  body: z.string().min(1).max(50_000),
  imported_meta: zImportedMeta.optional(),
})

export const zItemDependsOp = z.object({
  op: z.literal('depends_on'),
  op_id: zOpId,
  /** The card that waits. */
  key: zItemKey,
  /** The card that must finish first. */
  blocker: zItemKey,
})

export const zItemUndependOp = z.object({
  op: z.literal('undepend'),
  op_id: zOpId,
  key: zItemKey,
  blocker: zItemKey,
})

export const zItemSizeOp = z.object({
  op: z.literal('size'),
  op_id: zOpId,
  key: zItemKey,
  /** Unitless. Null clears it back to unsized. */
  size: z.number().min(0).max(1000).nullable(),
  is_milestone: z.boolean().optional(),
})

export const zItemSetMetaOp = z.object({
  op: z.literal('set_meta'),
  op_id: zOpId,
  key: zItemKey,
  /** null clears previously stored provenance. Does not bump rev. */
  imported_meta: zImportedMeta.nullable(),
})

export const zItemCommentUpdateOp = z.object({
  op: z.literal('comment_update'),
  op_id: zOpId,
  key: zItemKey,
  comment_id: z.string().min(1),
  body: z.string().min(1).max(50_000).optional(),
  /** undefined keeps stored provenance, null clears it. */
  imported_meta: zImportedMeta.nullable().optional(),
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

export const zItemChecklistDeleteOp = z.object({
  op: z.literal('checklist_delete'),
  op_id: zOpId,
  key: zItemKey,
  checklist: z.string().min(1),
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

/**
 * Permanent removal, and the only item op that destroys rather than changes.
 * Refused unless the item is already archived: archive is the reversible
 * everyday action, so deleting always takes two deliberate steps.
 */
export const zItemDeleteOp = z.object({
  op: z.literal('delete'),
  op_id: zOpId,
  key: zItemKey,
})

export const zItemOp = z.discriminatedUnion('op', [
  zItemCreateOp,
  zItemUpdateOp,
  zItemMoveOp,
  zItemCommentOp,
  zItemCommentUpdateOp,
  zItemChecklistSetOp,
  zItemChecklistDeleteOp,
  zItemLabelOp,
  zItemAssignOp,
  zItemSetMetaOp,
  zItemDependsOp,
  zItemUndependOp,
  zItemSizeOp,
  zItemDeleteOp,
  simpleItemOp('archive'),
  simpleItemOp('restore'),
  simpleItemOp('complete'),
  simpleItemOp('reopen'),
])
export type TItemOp = z.infer<typeof zItemOp>

export const zItemWrite = z.object({
  default_space: zSpaceKey.optional(),
  ops: z.array(zItemOp).min(1).max(100),
})

// --------------------------------------------------------------------------
// space_write ops
// --------------------------------------------------------------------------

export const zSpaceOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    op_id: zOpId,
    key: zSpaceKey,
    name: z.string().min(1).max(200),
    description: z.string().max(10_000).optional(),
    template: z.enum(['kanban6', 'none']).default('kanban6'),
  }),
  z.object({
    op: z.literal('update'),
    op_id: zOpId,
    key: zSpaceKey,
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(10_000).optional(),
  }),
  z.object({ op: z.literal('archive'), op_id: zOpId, key: zSpaceKey }),
  z.object({
    op: z.literal('list_create'),
    op_id: zOpId,
    space: zSpaceKey,
    name: z.string().min(1).max(200),
    role: zListRole.default('none'),
    pos: z.number().optional(),
  }),
  z.object({
    op: z.literal('list_update'),
    op_id: zOpId,
    space: zSpaceKey,
    list: z.string().min(1),
    name: z.string().min(1).max(200).optional(),
    role: zListRole.optional(),
    pos: z.number().optional(),
  }),
  z.object({
    op: z.literal('list_archive'),
    op_id: zOpId,
    space: zSpaceKey,
    list: z.string().min(1),
  }),
])
export type TSpaceOp = z.infer<typeof zSpaceOp>

export const zSpaceWrite = z.object({ ops: z.array(zSpaceOp).min(1).max(50) })

// --------------------------------------------------------------------------
// doc_write ops
// --------------------------------------------------------------------------

/**
 * Where an inline comment points, as a W3C text quote plus a position hint.
 * See anchors.ts for how it is resolved.
 *
 * `exact` alone is how an agent asks: quote the text, and add `prefix` or
 * `suffix` if the phrase repeats. `start` and `end` are what the app sends
 * with them, having seen the text it selected. Stored beside the document,
 * never in its markdown.
 */
export const zAnchorInput = z
  .object({
    exact: z.string().min(1).max(ANCHOR_MAX_LENGTH),
    prefix: z
      .string()
      .max(ANCHOR_CONTEXT_LENGTH * 4)
      .optional(),
    suffix: z
      .string()
      .max(ANCHOR_CONTEXT_LENGTH * 4)
      .optional(),
    start: z.number().int().min(0).optional(),
    end: z.number().int().min(0).optional(),
  })
  .refine(
    (a) =>
      (a.start === undefined) === (a.end === undefined) &&
      (a.start === undefined || (a.end ?? 0) >= a.start),
    { message: 'start and end come together, with end >= start' },
  )
export type TAnchorInput = z.infer<typeof zAnchorInput>

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
    space: zSpaceKey.optional(),
    imported_meta: zImportedMeta.optional(),
  }),
  z.object({
    op: z.literal('comment'),
    op_id: zOpId,
    ref: zDocSlug,
    body: z.string().min(1).max(50_000),
    /** Anchors the comment to a stretch of the text. Omit for a page comment. */
    anchor: zAnchorInput.optional(),
    imported_meta: zImportedMeta.optional(),
  }),
  z.object({
    op: z.literal('comment_resolve'),
    op_id: zOpId,
    ref: zDocSlug,
    comment_id: z.string().min(1),
    /** false reopens a resolved comment. */
    resolved: z.boolean().default(true),
  }),
  z.object({
    op: z.literal('comment_update'),
    op_id: zOpId,
    ref: zDocSlug,
    comment_id: z.string().min(1),
    body: z.string().min(1).max(50_000).optional(),
    /** undefined keeps stored provenance, null clears it. */
    imported_meta: zImportedMeta.nullable().optional(),
  }),
  z.object({
    op: z.literal('set_meta'),
    op_id: zOpId,
    ref: zDocSlug,
    /** null clears previously stored provenance. Does not bump rev. */
    imported_meta: zImportedMeta.nullable(),
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
  /** Hard delete. Leaf pages only: refused while child pages exist. */
  z.object({ op: z.literal('delete'), op_id: zOpId, ref: zDocSlug }),
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
    space: zSpaceKey.optional(),
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

export const zSpaceGet = z.object({
  space: zSpaceKey,
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
  space: zSpaceKey.optional(),
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
  space: zSpaceKey.optional(),
  list: z.string().optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(100_000).optional(),
  labels: z.array(z.string()).max(20).optional(),
  meta: z.record(z.string(), z.string()).optional(),
  /**
   * Text too long to belong in a description: a pasted stack trace, an
   * engine log, the full body of a support message whose excerpt is all the
   * description should carry. Each entry becomes a file attachment on the
   * card, so nothing is lost to a truncation the sender cannot see.
   */
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(300),
        text: z.string().min(1).max(1_000_000),
        mime: z.string().max(100).optional(),
      }),
    )
    .max(5)
    .optional(),
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
  /** Inline comments: whether the anchor was found in the current text. */
  anchor_status?: 'anchored' | 'detached'
}

export interface IOpErr {
  op_id: string
  ok: false
  error: string
  current?: unknown
}

export type TOpResult = IOpOk | IOpErr
