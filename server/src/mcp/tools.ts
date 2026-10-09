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
  zGoalGet,
  zGoalList,
  zGoalWrite,
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
import { goalGet, goalList, goalWrite } from '../services/goals'
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
      'One-call bootstrap: workspace name, all spaces with their lists and item counts, label groups, members (humans and agents), doc tree roots, and every goal (number, title, status, parent). Call this first; no other read is needed to orient.',
    schema: z.object({}),
    handler: (ctx) => workspaceOverview(ctx),
  },
  {
    name: 'space_get',
    description:
      'Items of one space, compact rows by default (key, title, list, labels, assignees, comment count, checklist progress, rev, updated). Filter by list, label, assignee, goal (number: the cards serving it, its sub-goals and parts included), state (open|done|archived|all), free text, or updated_since for delta reads. detail=board adds what a board card shows (summary: the first line of the description, size, blocked_by: open blockers, atts, goals: the goals each card serves, inherited through parents); detail=full adds that and whole descriptions. done=space leaves out done cards older than the board window set on the space, as the board shows it, and returns done_hidden, the number left out. The default returns every card. Never read a whole space to change one item; use item_write directly.',
    schema: zSpaceGet,
    handler: (ctx, args) => spaceGet(ctx, args as z.infer<typeof zSpaceGet>),
  },
  {
    name: 'item_get',
    description:
      'Full detail for up to 50 items by key in one call: description, comments, checklists, links (backlinks included), attachments, parent and parts, dependencies, and goals (the goals it serves, with via:KEY when the link is on a card it is part of); add "activity" to include the audit tail. Old keys from cross-space moves resolve automatically.',
    schema: zItemGet,
    handler: (ctx, args) => itemGet(ctx, args as z.infer<typeof zItemGet>),
  },
  {
    name: 'item_write',
    description:
      'Batch item mutations, transactional per op, idempotent via op_id (safe to retry). Ops: create (with labels/assignees/checklists inline), update (optional if_rev optimistic lock), move (cross-space moves re-key and alias), comment, comment_update (author only), comment_delete (author, or an admin; the workspace can reserve it to admins), set_parent (makes this card part of another, or null to detach; any card, any depth, any board, refused on a cycle), checklist_set, label (adding a label from an exclusive group replaces whatever that group held; reference it as "Group/Name" when two groups share value names), assign, archive, restore, complete, reopen, prioritize (priority: low, medium, high or urgent, null clears it; home ranks work by it), delete (permanent, refused unless the item is archived first). Up to 100 ops per call; returns {op_id, ok, key, rev} per op.',
    schema: zItemWrite,
    write: true,
    handler: async (ctx, args) => {
      const body = args as z.infer<typeof zItemWrite>
      return { results: await itemWrite(ctx, body.ops, body.default_space) }
    },
  },
  {
    name: 'goal_list',
    description:
      "Every goal in the workspace with its state, plus a summary (count by status, how many are overdue or have had no check-in for 30 days, and the work across all goals in flight). Goals are workspace-wide and numbered G-1, G-2. Each row carries two separate signals: status (the owner's judgement: pending, on_track, at_risk, off_track, done, paused, cancelled, set by check-ins) and progress (measured from the cards that serve it: total, done, active, waiting, overdue, and percent weighted by card size, unsized counting as 1). Progress counts cards linked to the goal, every card that is part of a linked card at any depth, and the work of its sub-goals (archived and cancelled sub-goals excluded), each card once. Also: owner, parent goal number, start and target dates, elapsed (percent of the date window gone), metric {name, unit, start, target, current, percent} when it has one, last_check_in. Filter by state (open|archived|all), status (comma separated), owner. To list the cards behind a goal, use goal_get or space_get with goal.",
    schema: zGoalList,
    handler: (ctx, args) => goalList(ctx, args as z.infer<typeof zGoalList>),
  },
  {
    name: 'goal_get',
    description:
      'Full detail for up to 20 goals by number (12 or "G-12"): everything goal_list returns plus description, followers, ancestors, children (its sub-goals, each with its own progress), items (every card counted toward this goal itself: linked:true for a direct link, via:KEY for a part reached through a linked card, with done, active, waiting, overdue, size and assignees as handles) and check_ins newest first (status, body, metric_value, can_edit, can_delete). include narrows to ["items"] or ["check_ins"]. Add "tree" to give each item parent (the card it is directly a part of) and blocked_by (its open blockers, [{key, title, space}], on any space).',
    schema: zGoalGet,
    handler: (ctx, args) => goalGet(ctx, args as z.infer<typeof zGoalGet>),
  },
  {
    name: 'goal_write',
    description:
      'Batch goal mutations, idempotent via op_id. A goal is referenced by number (12 or "G-12"). Ops: create (title, description, owner handle (defaults to you if you are a person; null for none), parent goal, status, start_date and target_date as epoch ms, metric {name, unit?, start, target, current?}, items: card keys that serve it, followers: handles); update (title, description, owner, dates, metric; null clears; optional if_rev); set_parent (a goal part of another goal, any depth, refused on a cycle; null makes it top-level); link (add/remove card keys; a card can serve several goals and its parts count too); check_in (the regular word on where it stands: status and/or body and/or metric_value; the goal\'s status and metric follow the latest check-in, and its owner and followers are notified); check_in_update (author only); check_in_delete (author, or an admin; the workspace can reserve it to admins; does not rewind the status); follow (add/remove handles; people only); archive; restore; delete (permanent, refused unless archived; sub-goals become top-level, cards are untouched). Returns {op_id, ok, key: "G-12", rev} per op.',
    schema: zGoalWrite,
    write: true,
    handler: async (ctx, args) => {
      const body = args as z.infer<typeof zGoalWrite>
      return { results: await goalWrite(ctx, body.ops) }
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
      'Batch document mutations, idempotent via op_id. Ops: create, replace (needs if_rev), patch_section (needs section slug + if_hash from doc_get sections; conflicts only when the same section changed), append (no read needed, ideal for logs), move, rename, set_layout (page width, default or wide, no rev bump), set_visibility (private to its owner or shared with the workspace; owner only, pages you create are shared), archive, delete (hard delete, leaf pages only), comment (a page comment; add anchor {exact, prefix?, suffix?} to comment inline on quoted text, which must appear in the document, with prefix or suffix to pick one repeat; never changes the document), comment_update (author only), comment_delete (author, or an admin; the workspace can reserve it to admins), comment_resolve (resolved: false reopens). Section edits transfer only the changed section, not the whole document.',
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
      'Batch label management, idempotent via op_id. Ops: group_create (workspace-wide or space-scoped; exclusive:true means at most one label from the group per card, which is how a group becomes a field like "Fixes version"), group_update, label_create (pos orders it within its group), label_update, label_reorder (the whole group in the order you want, positions assigned for you), label_merge (folds one label into another and reassigns all items), label_delete. A label is referenced by id, by bare name, or by "Group/Name", which is what to use when two groups hold the same values.',
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
