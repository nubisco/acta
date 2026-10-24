# Data safety

What Acta deletes on its own, how a workspace is exported and deleted, and what
happens when a person's account is erased. All of it runs from the same
scheduled tick as notifications: the cron trigger on Cloudflare, a one-minute
interval on Bun. The code is in `server/src/services/` (`retention.ts`,
`storageAlert.ts`, `workspaceExport.ts`, `workspaceDeletion.ts`,
`maintenance.ts`).

## Retention

Once a day, in batches of 500 rows, with a statement budget per tick. A run
that does not finish carries on at the next tick.

| What                                     | Kept for                                                    |
| ---------------------------------------- | ----------------------------------------------------------- |
| Activity (`event`) and its notifications | The workspace's history window, 90 days today               |
| Idempotency records (`op_log`)           | 30 days. Due-date reminder records stay while the card does |
| Webhook deliveries                       | 30 days                                                     |
| Notifications, once read                 | 30 days after reading                                       |
| AI usage and daily report runs           | 400 days                                                    |
| One-time sign-in codes                   | A day after they expire                                     |
| Saved page versions                      | The newest 20, then the last one of each day                |

The history window comes from `retentionDaysFor(workspaceId)`, which is where
plans set it (90 days on Free, a year on Team).

## The database size alert

Every hosted workspace shares one D1 database, and D1 stops at 10 GB. Past
5 GB, the admins of the instance's first workspace (the one bootstrap made)
get a notification, at most once a day. On Bun the size is
`page_count * page_size`, on D1 it is the `size_after` every result carries.

## Exporting a workspace

An admin asks from Settings, Workspace (`POST /api/v1/workspace/exports`). The
export is made off the request, and the cron picks up any the request did not
finish. It is a zip:

- `tables/<table>.jsonl`, every table holding the workspace's content
- `docs/<slug>.md`, every page
- `attachments/<id>-<filename>`, uploaded files up to 64 MB in total, with any
  beyond that listed in the README
- `README.txt`

Credentials are never included: tokens, OAuth grants, sign-in codes, webhook
and connection secrets, the AI key, the Slack webhook. Private pages are
included only for the admin who owns them. The admin is told in the bell, and
by email when the instance sends email, with a link that works for 7 days
without signing in (`GET /api/v1/exports/:id?token=...`). Settings downloads it
through the session (`GET /api/v1/workspace/exports/:id/download`).

## Deleting a workspace

An admin types the workspace's address to confirm
(`POST /api/v1/workspace/deletion`). From then on the workspace is read-only:
reads, exports and `DELETE /api/v1/workspace/deletion` (cancel) still work,
every other write answers 403. Thirty days later the cron purges every row and
every stored file, children before parents, so foreign keys hold throughout.
The instance's first workspace cannot be deleted.

## Erasing a person

When the identity provider sends `user.deleted` with the person's `user_id`,
every actor bound to that account, in every workspace, becomes "Deleted user":
email, picture and provider id removed, disabled, every token revoked, agents
acting for them disabled, and their notifications, stars, follows and
assignments removed. What they wrote stays with the workspace it was written
in.

## Proposal: a database per paid workspace

_A proposal for Jose to decide. Nothing here is built._

One shared D1 database caps the whole hosted service at 10 GB. The CFO review
estimates 25 to 40 busy paid workspaces fill it. A Cloudflare account can hold
50,000 D1 databases, so the way out is a database per paid workspace, with
Free workspaces staying on the shared one.

How it would work:

1. A small routing table in the shared database maps a workspace to its
   database binding name. A request resolves its workspace first (it already
   does, from the URL segment or the token), then picks the driver.
2. Workers cannot bind databases at runtime, so each dedicated database is
   reached through the D1 HTTP API or a set of pre-provisioned bindings
   allocated in `wrangler.toml` in blocks. The HTTP API is simpler and adds a
   few milliseconds per query. Pre-provisioned bindings keep the native speed
   and need a deploy to add a block.
3. Moving a workspace is the export above, imported into the new database,
   with the workspace read-only for the minutes it takes, then the routing row
   flips and the shared rows are purged.
4. Cross-workspace reads (the workspace list for a person, the cron sweeps)
   iterate over the routing table.

The trigger to start: the size alert at 5 GB, or 15 paid workspaces, whichever
comes first. That leaves room to move calmly rather than at the cap.
