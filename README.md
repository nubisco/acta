<div align="center">

  <br />

# Acta

**Boards and docs in one self-hostable server, co-managed by humans and AI agents.**

  <br />

[![CI](https://github.com/nubisco/acta/actions/workflows/ci.yml/badge.svg)](https://github.com/nubisco/acta/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/nubisco/acta)](https://github.com/nubisco/acta/releases)
[![license](https://img.shields.io/github/license/nubisco/acta)](LICENSE)
[![CLA](https://img.shields.io/badge/CLA-required-0A7F5A)](docs/CLA-INDIVIDUAL.md)
[![Sponsor](https://img.shields.io/badge/sponsor-%E2%9D%A4-db61a2)](https://github.com/sponsors/joseporto)

</div>

---

Acta (Latin: "things done") is an open-core, MCP-first project management and documentation product: kanban boards with stable item keys (`SW-142`) and an enhanced-Markdown wiki, behind one API that treats AI agents as first-class, fully attributed actors.

- **MCP from day one**: every capability is an MCP tool with the same fidelity as the UI, built for token economy (batch idempotent ops, delta reads, section-level doc patches).
- **Humans and agents co-manage**: unified actor model, audit trail on every mutation, safe concurrent editing via revision and section-hash guards.
- **Docs are Markdown**: a precisely specified extension set (callouts, collapsibles, `[[cross-references]]`, live item embeds) over CommonMark + GFM.
- **Self-host first**: one Docker container, SQLite, runs on NAS-class hardware.

Authentication is passwordless email OTP, local to your instance. A pluggable provider interface for external identity (generic OIDC) is on the roadmap, so self-hosters can bring their own IAM.

## Layout

- `server/` Hono app on Bun: REST API (`/api/v1`), MCP endpoint (`/mcp`), webhooks, rules kernel, serves the built SPA
- `web/` Vue 3 SPA built on [@nubisco/ui](https://github.com/nubisco/ui)
- `shared/` ids, zod schemas, enhanced-Markdown utilities
- `importers/` Trello and Confluence import CLIs
- `docs/` VitePress documentation

## Self-hosting

```sh
docker compose up -d   # see docker-compose.yml; data lives in the acta-data volume
```

The server prints one-time login codes to its log until an email sender is configured.

## Development

```sh
pnpm install
pnpm dev            # server + web in parallel
pnpm quality:check  # test + lint + format:check + types:check
```

`@nubisco/ui` is consumed from a sibling `../ui` checkout via a pnpm link override; CI reproduces the same layout.

## Contributing

Contributions are welcome under the [Individual CLA](docs/CLA-INDIVIDUAL.md); see [CONTRIBUTING.md](./CONTRIBUTING.md). Generic UI components belong in [@nubisco/ui](https://github.com/nubisco/ui), not here.

## License and trademarks

The code in this repository is [MIT licensed](./LICENSE). Hosted, multi-tenant, and SSO modules are developed separately and are not part of this repository.

"Acta", "Nubisco", and the Nubisco logo are trademarks of Nubisco, Lda. The MIT license does not grant permission to use them; forks and derived products must use their own names and branding.

---

<div align="center">
  Built by <a href="https://nubisco.io">Nubisco</a> · <a href="https://github.com/sponsors/joseporto">Sponsor this project</a>
</div>
