# Tools

Thirteen tools, plus `attachment_add` when the instance has an attachment
store configured (it does in every standard deployment). Those marked
**write** require a token with the write scope.

| Tool                 |           | Does                                                                                                                                                                                                     |
| -------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace_overview` |           | One-call bootstrap: workspace name, every space with its lists and item counts, label groups, members (human and agent), document tree roots. Call this first.                                           |
| `space_get`          |           | Items of one space as compact rows. Filter by list, label, assignee, state, free text, or `updated_since` for delta reads. `detail=full` adds descriptions.                                              |
| `item_get`           |           | Full detail for up to 50 items by key: description, comments, checklists, links and backlinks, attachments, optionally the activity tail. Old keys from cross-space moves resolve automatically.         |
| `item_write`         | **write** | Batch item mutations. See below.                                                                                                                                                                         |
| `space_write`        | **write** | Create and change spaces and lists: `create` (with the `kanban6` template), `update`, `archive`, `list_create`, `list_update`, `list_archive`.                                                           |
| `doc_tree`           |           | The document hierarchy as a flat, depth-annotated list. Optionally scoped to a subtree.                                                                                                                  |
| `doc_get`            |           | One document: frontmatter, body, `rev`. `include: ["sections"]` adds the heading map with per-section hashes; `"versions"` the history; `"backlinks"` the referrers. `at_version` reads an old revision. |
| `doc_write`          | **write** | Batch document mutations. See below.                                                                                                                                                                     |
| `search`             |           | Full-text across item titles and descriptions, comments and documents. Returns type, key or slug, title, snippet.                                                                                        |
| `activity_query`     |           | The audit trail. Filter by entity, actor, `actor_kind`, verb pattern (`item.*`), and `since` for a cheap delta.                                                                                          |
| `label_write`        | **write** | `group_create`, `label_create`, `label_update`, `label_merge` (folds one label into another and reassigns every item), `label_delete`.                                                                   |
| `webhook_write`      | **write** | Outbound webhooks: `create` (url plus event patterns, optional HMAC secret), `update`, `delete`.                                                                                                         |
| `rule_write`         | **write** | Automation rules from a fixed catalogue. See below.                                                                                                                                                      |
| `attachment_add`     | **write** | Attach a URL, or inline base64 up to 1 MB, to an item or document.                                                                                                                                       |

## Writing items

`item_write` takes up to 100 ops and returns `{op_id, ok, key, rev}` for each.

| Op                       | Notes                                                          |
| ------------------------ | -------------------------------------------------------------- |
| `create`                 | Labels, assignees and checklists inline.                       |
| `update`                 | Optional `if_rev` for an optimistic lock.                      |
| `move`                   | Across spaces too, which re-keys the item and leaves an alias. |
| `comment`                | `[[@handle]]` in the body notifies that member.                |
| `checklist_set`          | Replaces a named checklist.                                    |
| `label`, `assign`        | Add and remove.                                                |
| `archive`, `restore`     |                                                                |
| `complete`, `reopen`     |                                                                |
| `depends_on`, `undepend` | Declare that one item waits for another. Cycles are refused.   |
| `size`                   | A unitless estimate, and whether the item is a milestone.      |
| `delete`                 | Permanent, and refused unless the item is archived first.      |

Every op carries an `op_id` you choose. The same `op_id` applied twice does the
work once, so a retry after a timeout is safe:

```json
{
  "ops": [
    {
      "op": "create",
      "op_id": "a1",
      "space": "ENG",
      "list": "To Do",
      "title": "Rotate the signing key",
      "labels": ["security"]
    },
    {
      "op": "comment",
      "op_id": "a2",
      "key": "ENG-142",
      "body": "Blocked until [[ENG-140]] lands. cc [[@dana]]"
    }
  ]
}
```

## Writing documents

| Op               | Notes                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `create`         |                                                                                                     |
| `replace`        | Needs `if_rev`.                                                                                     |
| `patch_section`  | Needs the section slug and `if_hash` from `doc_get`. Conflicts only when that same section changed. |
| `append`         | No read needed. Ideal for logs and running notes.                                                   |
| `move`, `rename` |                                                                                                     |
| `archive`        |                                                                                                     |
| `delete`         | Hard delete, leaf pages only.                                                                       |

`patch_section` is the one worth learning. Read with sections, change one, send
it back:

```json
{
  "ops": [
    {
      "op": "patch_section",
      "op_id": "d1",
      "ref": "manual/runbook",
      "section": "restarting-the-worker",
      "if_hash": "9f2c…",
      "content": "## Restarting the worker\n\nDrain first, then …"
    }
  ]
}
```

Two agents editing different sections of the same page both succeed.

## Automation rules

`rule_write` manages rules from a fixed catalogue:

```json
{
  "op": "create",
  "op_id": "r1",
  "name": "Triage security reports",
  "trigger": "item.created",
  "condition": "space=ENG label=security",
  "action": "assign"
}
```

Triggers are event patterns. Conditions use the embed-query grammar
(`space=X list=Y label=Z assignee=H state=open|done|archived`). Actions are
`move_item`, `apply_label`, `assign`, `comment`, `complete` or `call_webhook`.

Rule actions are attributed to the system actor with `caused_by` chaining, and
never re-trigger rules, so a pair of rules cannot loop.

## Errors

A refused call comes back as a tool result with `isError: true` and a message,
not as a JSON-RPC error, so an agent can read the reason and try something
else. JSON-RPC errors are reserved for a malformed request or an unknown tool.

Conflicts are honest. `update` with a stale `if_rev`, or `patch_section` with a
stale `if_hash`, fails rather than overwriting. Re-read, merge, retry.
