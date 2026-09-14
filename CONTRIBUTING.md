# Contributing to Acta

Thanks for your interest in contributing.

## Ground rules

- Conventional Commits. The primary branch is `master`, releases are cut by
  semantic-release, and `CHANGELOG.md` is generated: never hand-edit it.
- `pnpm quality:check` (test, lint, format:check, types:check) must pass. Git
  hooks enforce it on commit and on push.
- Generic UI components belong in
  [@nubisco/ui](https://github.com/nubisco/ui), not here. This repository
  contains domain composition only. If a component is missing a capability,
  add it upstream rather than reimplementing it locally.
- The MCP tool surface and the REST API share one service layer. A capability
  added to one must be added to both, with tests.
- The enhanced-Markdown extension set is a contract (see `design-spec.md` §2).
  Changes to it need a design discussion first.

## Getting set up

Requires [Bun](https://bun.sh), Node 20+ and pnpm (`corepack enable`).

```sh
pnpm install
pnpm dev            # server on :4460, web dev server on :5173
```

The server prints one-time sign-in codes to its own log, so you can sign in
without configuring mail.

```sh
pnpm test           # every package
pnpm lint
pnpm types:check
pnpm build          # also the only thing that compiles SCSS, see below
```

## Layout

| Path         | What it is                                                                          |
| ------------ | ----------------------------------------------------------------------------------- |
| `server/`    | Hono on Bun. REST API, MCP endpoint, webhooks, rules, search. Serves the built SPA. |
| `web/`       | Vue 3 SPA on `@nubisco/ui`.                                                         |
| `shared/`    | Ids, zod schemas, enhanced-Markdown utilities.                                      |
| `importers/` | Trello and Confluence import CLIs.                                                  |
| `docs/`      | The VitePress site published to docs.nubisco.io/acta/.                              |

## Three things that catch people out

**Two runtimes, one app.** The server runs on Bun and on Cloudflare Workers.
The tests run on Bun. Code that passes them can still fail on workerd: storing
the global `fetch` and calling it as `this.fetchImpl(...)` works on Bun and
throws _Illegal invocation_ on workerd, which is a production outage with a
green test suite. Bind anything you hold off the global object.

**Migrations are the sharpest edge.** A failed migration is memoized per
isolate, so a bad one is not a degraded feature: it is every request failing
until a redeploy. Test a schema change against a fixture in the _old_ shape,
with rows and with the real old constraints. See
`server/test/token-migration.test.ts` for the pattern.

**`types:check` and the tests do not compile SCSS.** A malformed stylesheet
passes both and fails only in `pnpm build`. Run the build before you push
anything that touched styles.

## Pull requests

1. Branch from `master`. It is protected; work by branch and pull request.
2. Keep the change focused. A refactor and a fix in one diff is two reviews
   happening at once.
3. Explain _why_ in the commit body, not just what. The diff already says what.
4. Add tests that would fail without your change. For a bug, the test that
   reproduces it is the most valuable part of the contribution.
5. Fill in the pull request template, including the CLA confirmation.

## Reporting bugs

Open an issue with the bug report template. The useful ones say what you did,
what you expected, what happened, and which version or commit. If it involves
an import, the reconciliation report is worth attaching.

For anything security-related, do not open an issue. See
[SECURITY.md](./SECURITY.md).

## Contributor License Agreement

To keep Acta sustainable and legally consistent, contributions are made under
the Individual CLA:

- See [docs/CLA-INDIVIDUAL.md](./docs/CLA-INDIVIDUAL.md)
- You keep ownership of your contributions
- You grant Nubisco a broad licence to use them in the project and related works

By opening a pull request you confirm you agree to the CLA in the pull request
template, and you agree to licence your contribution under the MIT licence.

## Code of Conduct

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).
