/**
 * MCP tool surface (design-spec §4). Tools share the REST service layer, so
 * UI/REST/MCP parity is structural. Input schemas are the shared zod schemas,
 * exported to JSON Schema via zod v4.
 */

import { z } from 'zod'
import {
  zActivityQuery,
  zSpaceGet,
  zSpaceWrite,
  zDocSlug,
  zDocWrite,
  zItemGet,
  zItemWrite,
  zLabelWrite,
  zSearch,
} from '@nubisco/acta-shared'
import type { ICtx } from '../core/ctx'
import {
  attachmentAdd,
  attachmentAddBatch,
  attachmentDelete,
  zAttachmentAddBatch,
  zAttachmentAdd,
  type AttachmentStore,
} from '../services/attachments'
import { spaceWrite } from '../services/spaces'
import { docWrite } from '../services/docs'
import { itemWrite } from '../services/items'
import { labelWrite } from '../services/labels'
import { ruleList, ruleWrite, zRuleWrite } from '../services/rules'
import { webhookList, webhookWrite, zWebhookWrite } from '../services/webhooks'
import {
  activityQuery,
  spaceGet,
  docGet,
  docTree,
  itemGet,
  search,
  workspaceOverview,
} from '../services/reads'

export interface IMcpTool {
  name: string
  description: string
  schema: z.ZodType
  /** Tools that mutate require the write scope. */
  write?: boolean
  handler: (ctx: ICtx, args: unknown) => unknown
}

const zDocTree = z.object({
  root: zDocSlug.optional(),
  depth: z.number().int().min(1).max(20).optional(),
})

const zDocGet = z.object({
  ref: zDocSlug,
  at_version: z.number().int().optional(),
  include: z
    .array(z.enum(['backlinks', 'versions', 'sections', 'comments']))
    .optional(),
})

export const MCP_TOOLS: IMcpTool[] = [
  {
    name: 'workspace_overview',
    description:
      'One-call bootstrap: workspace name, all spaces with their lists and item counts, label groups, members (humans and agents), and doc tree roots. Call this first; no other read is needed to orient.',
    schema: z.object({}),
    handler: (ctx) => workspaceOverview(ctx),
  },
  {
    name: 'space_get',
    description:
      'Items of one space, compact rows by default (key, title, list, labels, assignees, comment count, checklist progress, rev, updated). Filter by list, label, assignee, state (open|done|archived|all), free text, or updated_since for delta reads. detail=full adds descriptions. Never read a whole space to change one item; use item_write directly.',
    schema: zSpaceGet,
    handler: (ctx, args) => spaceGet(ctx, args as z.infer<typeof zSpaceGet>),
  },
  {
    name: 'item_get',
    description:
      'Full detail for up to 50 items by key in one call: description, comments, checklists, links (backlinks included), attachments; add "activity" to include the audit tail. Old keys from cross-space moves resolve automatically.',
    schema: zItemGet,
    handler: (ctx, args) => itemGet(ctx, args as z.infer<typeof zItemGet>),
  },
  {
    name: 'item_write',
    description:
      'Batch item mutations, transactional per op, idempotent via op_id (safe to retry). Ops: create (with labels/assignees/checklists inline), update (optional if_rev optimistic lock), move (cross-space moves re-key and alias), comment, comment_update (author only), comment_delete (author, or an admin; the workspace can reserve it to admins), set_parent (makes this card part of another, or null to detach; any card, any depth, any board, refused on a cycle), checklist_set, label, assign, archive, restore, complete, reopen, delete (permanent, refused unless the item is archived first). Up to 100 ops per call; returns {op_id, ok, key, rev} per op.',
    schema: zItemWrite,
    write: true,
    handler: async (ctx, args) => {
      const body = args as z.infer<typeof zItemWrite>
      return { results: await itemWrite(ctx, body.ops, body.default_space) }
    },
  },
  {
    name: 'space_write',
    description:
      'Batch space/list mutations, idempotent via op_id. Ops: create (template kanban6 seeds the standard six lists), update, archive, list_create, list_update (rename/role/pos), list_archive (refuses if open items remain).',
    schema: zSpaceWrite,
    write: true,
    handler: async (ctx, args) => {
      const body = args as z.infer<typeof zSpaceWrite>
      return { results: await spaceWrite(ctx, body.ops) }
    },
  },
  {
    name: 'doc_tree',
    description:
      'The document hierarchy as a flat depth-annotated list (slug, title, depth, rev, updated). Optionally scoped to a subtree root.',
    schema: zDocTree,
    handler: (ctx, args) => {
      const p = args as z.infer<typeof zDocTree>
      return docTree(ctx, p.root, p.depth)
    },
  },
  {
    name: 'doc_get',
    description:
      'One document: frontmatter fields, markdown body, rev. include=["sections"] returns the heading map with per-section content hashes for surgical edits via doc_write patch_section; "versions" lists history; "backlinks" lists referrers; "comments" lists comments, where an inline one carries its anchor (quoted text with prefix/suffix context), anchor_status (anchored, or detached when the quoted text is gone: the comment is kept either way) and resolved {by, ts} once resolved. at_version reads an old revision.',
    schema: zDocGet,
    handler: (ctx, args) => {
      const p = args as z.infer<typeof zDocGet>
      return docGet(ctx, p.ref, {
        at_version: p.at_version,
        include: p.include,
      })
    },
  },
  {
    name: 'doc_write',
    description:
      'Batch document mutations, idempotent via op_id. Ops: create, replace (needs if_rev), patch_section (needs section slug + if_hash from doc_get sections; conflicts only when the same section changed), append (no read needed, ideal for logs), move, rename, set_layout (page width, default or wide, no rev bump), archive, delete (hard delete, leaf pages only), comment (a page comment; add anchor {exact, prefix?, suffix?} to comment inline on quoted text, which must appear in the document, with prefix or suffix to pick one repeat; never changes the document), comment_update (author only), comment_delete (author, or an admin; the workspace can reserve it to admins), comment_resolve (resolved: false reopens). Section edits transfer only the changed section, not the whole document.',
    schema: zDocWrite,
    write: true,
    handler: async (ctx, args) => {
      const body = args as z.infer<typeof zDocWrite>
      return { results: await docWrite(ctx, body.ops) }
    },
  },
  {
    name: 'search',
    description:
      'Unified full-text search across item titles/descriptions, comments, and documents. Returns type, key/slug, title, snippet. Filter by types or space.',
    schema: zSearch,
    handler: (ctx, args) => search(ctx, args as z.infer<typeof zSearch>),
  },
  {
    name: 'activity_query',
    description:
      'The audit trail. Filter by entity (kind or id), actor, actor_kind (human|agent|system), verb pattern (item.* style), and since (event id cursor) for cheap "what changed since my last session" delta reads. Every event carries actor attribution and rule causation.',
    schema: zActivityQuery,
    handler: (ctx, args) =>
      activityQuery(ctx, args as z.infer<typeof zActivityQuery>),
  },
  {
    name: 'label_write',
    description:
      'Batch label management, idempotent via op_id. Ops: group_create (workspace-wide or space-scoped), label_create, label_update, label_merge (folds one label into another and reassigns all items), label_delete.',
    schema: zLabelWrite,
    write: true,
    handler: async (ctx, args) => {
      const body = args as z.infer<typeof zLabelWrite>
      return { results: await labelWrite(ctx, body.ops) }
    },
  },
  {
    name: 'webhook_write',
    description:
      'Manage outbound webhooks, idempotent via op_id. Ops: create (url + event patterns like item.moved, item.*, *; optional HMAC secret for x-acta-signature), update (url/events/enabled; re-enabling resets the failure counter), delete. Every response includes the full current webhook list with failure counts.',
    schema: zWebhookWrite,
    write: true,
    handler: async (ctx, args) => {
      const body = args as z.infer<typeof zWebhookWrite>
      return {
        results: await webhookWrite(ctx, body.ops),
        ...(await webhookList(ctx)),
      }
    },
  },
  {
    name: 'rule_write',
    description:
      'Manage automation rules (fixed catalog), idempotent via op_id. Ops: create {trigger: event pattern, condition?: embed-query grammar (space=X list=Y label=Z assignee=H state=open|done|archived), action: move_item|apply_label|assign|comment|complete|call_webhook}, update (name/enabled), delete. Rule actions are attributed to the system actor with caused_by chaining and never re-trigger rules. Every op response includes the current rule list.',
    schema: zRuleWrite,
    write: true,
    handler: async (ctx, args) => {
      const body = args as z.infer<typeof zRuleWrite>
      return {
        results: await ruleWrite(ctx, body.ops),
        ...(await ruleList(ctx)),
      }
    },
  },
]

/** attachment_add needs the file store; built at server start. */
export function createMcpTools(store: AttachmentStore): IMcpTool[] {
  return [
    // The delete ops on doc_write and item_write remove attachment blobs,
    // which needs the store this factory holds; the static definitions can't
    // reach it.
    ...MCP_TOOLS.map((tool) => {
      if (tool.name === 'doc_write') {
        return {
          ...tool,
          handler: async (ctx: ICtx, args: unknown) => {
            const body = args as z.infer<typeof zDocWrite>
            return { results: await docWrite(ctx, body.ops, store) }
          },
        }
      }
      if (tool.name === 'item_write') {
        return {
          ...tool,
          handler: async (ctx: ICtx, args: unknown) => {
            const body = args as z.infer<typeof zItemWrite>
            return {
              results: await itemWrite(
                ctx,
                body.ops,
                body.default_space,
                store,
              ),
            }
          },
        }
      }
      return tool
    }),
    {
      name: 'attachment_add',
      description:
        'Attach to an item (by key) or doc (by slug): either a url attachment or inline base64 content up to 1 MB (larger files go through POST /api/v1/attachments). Returns the attachment id and the url it is served from, which can be embedded in markdown as ![alt](attachment:<id>).',
      schema: zAttachmentAdd,
      write: true,
      handler: (ctx, args) =>
        attachmentAdd(ctx, store, args as z.infer<typeof zAttachmentAdd>),
    },
    {
      name: 'attachment_add_batch',
      description:
        'Up to 25 attachments in one call, each with its own op_id, returning a result per op. Idempotent: replaying an op_id returns the recorded result instead of attaching a second copy, so a retry after a timeout cannot duplicate what already landed.',
      schema: zAttachmentAddBatch,
      write: true,
      handler: (ctx, args) =>
        attachmentAddBatch(
          ctx,
          store,
          args as z.infer<typeof zAttachmentAddBatch>,
        ),
    },
    {
      name: 'attachment_delete',
      description:
        'Remove one attachment by id. The blob goes with it. Deleting an attachment a document still embeds leaves a broken image, so check the body first.',
      schema: z.object({ id: z.string().min(1) }),
      write: true,
      handler: (ctx, args) =>
        attachmentDelete(ctx, store, (args as { id: string }).id),
    },
  ]
}

export function toolInputSchema(tool: IMcpTool): Record<string, unknown> {
  return z.toJSONSchema(tool.schema, { target: 'draft-7' }) as Record<
    string,
    unknown
  >
}
