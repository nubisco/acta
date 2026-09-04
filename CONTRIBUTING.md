# Contributing to Acta

Thanks for your interest in contributing.

## Ground rules

- Conventional Commits; the primary branch is `master`; releases are cut by semantic-release (never hand-edit CHANGELOG.md).
- `pnpm quality:check` (test, lint, format:check, types:check) must pass; git hooks enforce it on commit and push.
- Generic UI components belong in [@nubisco/ui](https://github.com/nubisco/ui), not here. This repo only contains domain composition.
- The MCP tool surface and the REST API share one service layer; a capability added to one must be added to both, with tests.
- The enhanced-Markdown extension set is a contract (see design-spec.md §2); changes to it require a design discussion first.

## Contributor License Agreement (CLA)

To keep Acta sustainable and legally consistent, all contributions are made under the Individual CLA:

- See [docs/CLA-INDIVIDUAL.md](./docs/CLA-INDIVIDUAL.md)
- You retain ownership of your contributions
- You grant Nubisco a broad license to use them in the project and related works

By opening a pull request, you must explicitly confirm you agree to the CLA in the pull request template.

## Getting started

```sh
pnpm install
pnpm dev
pnpm test
```

By submitting a pull request you agree to license your contribution under the MIT license and the Individual CLA above.
