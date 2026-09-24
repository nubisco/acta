# Architecture

A monorepo of four packages plus the docs you are reading.

| Package      | What it is                                                                              |
| ------------ | --------------------------------------------------------------------------------------- |
| `server/`    | Hono on Bun. REST API, MCP endpoint, webhooks, rules, search. Serves the built SPA.     |
| `web/`       | Vue 3 SPA on [@nubisco/ui](https://github.com/nubisco/ui).                              |
| `shared/`    | Ids, zod schemas, enhanced-Markdown utilities. Used by both sides and by the importers. |
| `importers/` | Trello and Confluence CLIs.                                                             |

## Two runtimes, one app

The server runs on Bun (`src/index.ts`) and on Cloudflare Workers
(`src/worker.ts`). Both build the same Hono app from `src/app.ts`; the
entrypoints differ only in what they inject: a SQLite driver or a D1 one, a
filesystem blob store or R2, a file reader or the assets binding.

::: warning The trap this design sets
Code that works on Bun can still fail on workerd, and the tests run on Bun.
The one that cost a production outage: storing the global `fetch` on an
instance and calling it as `this.fetchImpl(...)`. Node and Bun ignore the
receiver; workerd refuses to run its global fetch with any `this` but
`globalThis` and throws _Illegal invocation_. Every test passed.

Bind anything you store off the global object, and be suspicious of green
tests for anything touching platform builtins.
:::

## The write path

Every mutation goes through the same three things.

**Ops.** Writes are batches of ops, each with a client-supplied `op_id`.
`withOp` records the result of a successful op against its id, so a replay
returns the recorded result rather than doing the work twice. Failures are not
recorded, so a failed op can be retried with the same id.

**Events.** A mutation appends an event: actor, verb, entity, summary, and
`caused_by` when a rule triggered it. Events are queued during the transaction
and flushed after it commits, so a rolled-back write emits nothing.

**Listeners.** Notifications, webhooks and the rules kernel subscribe to
flushed events. A listener can never break the write path: it has already
committed by the time they run.

Rule-triggered changes are attributed to the system actor and never re-trigger
rules, which is what stops two rules from looping.

## The clock

Two things happen because time passed rather than because somebody wrote: a
due date arriving, and a notification going unread long enough to be worth an
email. `services/notificationSweep.ts` is both, in one function, called from a
cron trigger on Workers (`scheduled` in `worker.ts`) and from an interval on
Bun (`index.ts`). Writing it once is the point, because a reminder that only
fired on the hosted instance would be a feature self-hosters are told they
have and do not.

It has to be safe to run twice, since two isolates, a retried cron and a
restart can all cause that. Due-date events carry an op id built from the card
and the date, so moving a date earns one fresh reminder and leaving it alone
earns none. A reminder stamps `reminded_at` in the same statement that
selected the rows.

Reaching somebody outside the app goes through `INotificationChannel`. Email
is the one that exists. The seam is there because an instant channel, Slack,
changes the arithmetic rather than adding to it: a Slack message that links
back marks the notification read when the link is followed, and the email is
then never owed at all.

## The database

SQLite, or D1 which is SQLite. There is no ORM and no migration files:
`db/schema.ts` holds the schema as `CREATE TABLE IF NOT EXISTS`, and the
driver applies it on boot.

Changes that CREATE IF NOT EXISTS cannot express have their own lists:

- `ADDITIVE_COLUMNS`: `ALTER TABLE ... ADD COLUMN`, append-only. The driver
  swallows the duplicate-column error that means it already ran.
- `RENAMES`: idempotent by failure, for the same reason.
- `LINK_REBUILD`, `TOKEN_REBUILD`: SQLite cannot alter a `CHECK` in place, so
  the table is rebuilt. Each is guarded by a detector that inspects
  `sqlite_master`, because rebuilding on every boot would leave a window with
  no table at all.

::: danger Migrations are the sharpest edge in this codebase
A failed migration is memoized per isolate, so getting one wrong is not a
degraded feature: it is every request failing until a redeploy.

Test a schema change against a fixture in the _old_ shape, carrying rows and
carrying the real old constraints. A `CHECK` migration once shipped green
because the fixture had no `CHECK`, so the statement that would have failed in
production could not fail in the test. See `test/token-migration.test.ts` for
the shape to copy: it asserts the old constraint actually rejects the new value
before proving the migration makes it work.
:::

## Testing

```sh
pnpm test          # everything
pnpm -C server test
pnpm -C web test
pnpm lint
pnpm types:check
```

Server and importer tests run on `bun test`, web on Vitest.

Note that `types:check` and the test suites do **not** compile SCSS. A
malformed stylesheet passes both and fails only in `pnpm build`, so run the
build before deploying anything that touched styles.

## Conventions

- Interfaces are `I`-prefixed, type aliases `T`-prefixed. Enforced by lint.
- The web app takes generic components from `@nubisco/ui` and never
  reimplements them locally. Missing capability is added upstream.
- Use the library's design tokens. An invented token name silently falls back
  and opts the element out of the theme, which looks like a styling preference
  and is a typo. `.nb-layer-{0-3}` sets surface depth for everything nested
  inside it.
- Conventional Commits; the changelog and version bump are generated from them.

## Contributing

See [CONTRIBUTING.md](https://github.com/nubisco/acta/blob/master/CONTRIBUTING.md).
Contributions require a CLA. Work by branch, then pull request: `master` is
protected.
