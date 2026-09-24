# The data model

Thirty-odd tables in `server/src/db/schema.ts`. These are the ones that carry
the ideas; the rest are joins and logs.

## Identity

**`workspace`** One row per installation. Its `slug` is the URL segment.

**`actor`** Everyone and everything that can act: `human`, `agent` or
`system`. Agents may carry `on_behalf_of` pointing at a person. Unique handle
per workspace.

**`auth_token`** Hashed credentials, never plaintext. Three kinds:

| Kind       | Minted by                  | Acts as             | Notes                                           |
| ---------- | -------------------------- | ------------------- | ----------------------------------------------- |
| `session`  | Signing in                 | The member          | Expires; lives in an `httpOnly` cookie          |
| `agent`    | An administrator           | Its own agent actor | Scoped `read`/`write`/`admin`                   |
| `personal` | Any member, for themselves | That member         | Labelled, never `admin`, records `last_used_at` |

## Work

**`space`** A board. Has `key`, and `next_seq` which mints item numbers.

**`list`** A column, with a `role` (`backlog`, `active`, `blocked`, `review`,
`done`, `inbox`, `none`). The role exists so "is this finished" survives
someone renaming the column.

**`item`** A card. Its key is `space.key` + a sequence number and is permanent.

**`item_key_alias`** Old keys. A cross-space move re-keys an item and records
its previous key here, so a reference written a year ago still resolves.

**`item_dependency`** `blocker_id` → `blocked_id`, keyed on the pair. The
sequence view is computed from these: topological layers for the steps,
longest chain by size for the critical path. Cycles are refused at write time,
because a cycle has no order and the moment to say so is while someone is
asserting the edge.

**`label_group`, `label`, `item_label`, `item_assignee`** Labels may be
workspace-wide or scoped to a space.

**`checklist`, `checklist_item`, `comment`, `attachment`** As expected.

## Documents

**`document`** Slug-addressed, with a `rev`. The tree is `parent_id` plus a
`REAL` `pos` ordering siblings, not the slug. New pages go 1024 after the last
sibling, and a move between two siblings takes the midpoint, renumbering the
siblings in the same op when the gap gets too small. A move changes only
`parent_id` and `pos`, never the slug, so links survive it even when the slug
no longer describes where the page lives. A page can never become a descendant
of itself.

**`doc_version`** Every save. Reads can target an old version.

**`link`** Extracted cross-references: `(src_kind, src_id) → (ref_type,
target)` where `ref_type` is `item`, `space`, `doc`, `actor` or `query`.
Rebuilt on save, which is what makes backlinks possible.

**`fts`** An FTS5 virtual table over item titles and descriptions, comments and
documents. FTS5 has no `RENAME COLUMN`, so any column change means dropping and
reindexing from the source rows.

**`link_preview`** Open Graph metadata behind a link preview card, keyed by
URL, with a TTL: a day for a page that answered, an hour for one that did not,
so a document full of links to a site with no metadata is not refetched on
every open. The one table with no `workspace_id`, because it caches what a
public web page said about itself and that does not differ per tenant.

Everything that fills it goes out through `server/src/core/safeFetch.ts`. The
URL comes from a document, which makes it an SSRF sink: the scheme must be
http or https, the hostname is resolved and every address it resolves to is
checked against the private and special-use ranges, redirects are followed by
hand and re-checked at each hop, and size and time are both capped. Read that
file before changing anything that fetches a URL a person supplied.

## The spine

**`event`** Every mutation: `ts`, `actor_id`, `actor_kind`, `on_behalf_of`,
`verb` (`item.moved`), `entity`, `entity_id`, `summary`, `payload`,
`caused_by`. The activity feed, notifications, webhooks and rules are all
readers of this table, and `since` cursors over it are how an agent asks what
changed cheaply.

**`op_log`** `op_id` → recorded result. The idempotency record: a replayed op
returns what it returned the first time. Only successes are recorded, so a
failed op can be retried with the same id.

**`notification`** Per-actor, unique on `(actor_id, event_id)` so one event
cannot notify someone twice. `reason` is `mention`, `assigned` or `involved`,
in that order of precedence. `item_key` or `doc_slug` says what it opens.

`remind_at` is when it becomes eligible to be chased outside the app, stamped
at write time from the recipient's own `actor.notify_after_seconds` rather
than read from that setting later: changing your preference should govern what
happens next, not silently re-time a week of notifications you already have.
`reminded_at` and `reminded_via` are set once, by the sweep, so a reminder
cannot repeat every five minutes for as long as the row stays unread.

**`webhook`, `webhook_delivery`, `rule`** Outbound delivery with a failure
count, and the automation catalogue.

## Conventions

- Ids are prefixed ULIDs (`act_...`, `itm_...`), so the prefix says what a
  bare id is and the creation time is recoverable from it.
- Timestamps are unix milliseconds, integers.
- Nothing is hard-deleted by default: items archive, documents archive, tokens
  revoke. The few hard deletes are explicit and refuse to run on live rows.
