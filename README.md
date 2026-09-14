<div align="center">

  <br />

  <img src="https://raw.githubusercontent.com/nubisco/acta/master/docs/public/logo.svg" alt="Nubisco" width="96" />

  <br />

# Acta

**Boards and docs in one self-hostable server, co-managed by humans and AI agents.**

  <br />

[![CI](https://github.com/nubisco/acta/actions/workflows/ci.yml/badge.svg)](https://github.com/nubisco/acta/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/nubisco/acta)](https://github.com/nubisco/acta/releases)
[![license](https://img.shields.io/github/license/nubisco/acta)](LICENSE)
[![CLA](https://img.shields.io/badge/CLA-required-0A7F5A)](docs/CLA-INDIVIDUAL.md)
[![Docs](https://img.shields.io/website?url=https%3A%2F%2Fdocs.nubisco.io%2Facta%2F&label=docs)](https://docs.nubisco.io/acta/)
[![Sponsor](https://img.shields.io/badge/sponsor-%E2%9D%A4-db61a2)](https://github.com/sponsors/joseporto)

</div>

---

Acta (Latin: "things done") is an open-core, MCP-first project management and documentation product: kanban boards with stable item keys (`SW-142`) and an enhanced-Markdown wiki, behind one API that treats AI agents as first-class, fully attributed actors.

- **MCP from day one**: every capability is an MCP tool with the same fidelity as the UI, built for token economy (batch idempotent ops, delta reads, section-level doc patches).
- **Humans and agents co-manage**: unified actor model, audit trail on every mutation, safe concurrent editing via revision and section-hash guards.
- **Docs are Markdown**: a precisely specified extension set (callouts, collapsibles, `[[cross-references]]`, live item embeds) over CommonMark + GFM.
- **Self-host first**: one Docker container, SQLite, runs on NAS-class hardware.

Authentication is passwordless: email one-time codes local to your instance, or standard OpenID Connect against your own provider (Keycloak, Auth0, Okta, Entra, Google Workspace and anything else that speaks it). Members can mint personal access tokens that let an editor, a script or an MCP client act as them, with their role and their name in the audit trail.

**[Documentation](https://docs.nubisco.io/acta/)** covers self-hosting, authentication, migrating from Trello and Confluence, and connecting an agent over MCP.

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

The server prints one-time login codes to its log until an email sender is configured, which is fine on a laptop and unacceptable once other people use the instance. See [Install](https://docs.nubisco.io/acta/self-hosting/) and [Authentication](https://docs.nubisco.io/acta/self-hosting/authentication).

## Documentation

Full documentation is at **[docs.nubisco.io/acta](https://docs.nubisco.io/acta/)**:

- [What Acta is](https://docs.nubisco.io/acta/guide/) and its [concepts](https://docs.nubisco.io/acta/guide/concepts)
- [Install](https://docs.nubisco.io/acta/self-hosting/): Docker, Cloudflare Workers, or from source
- [Configuration](https://docs.nubisco.io/acta/self-hosting/configuration) and [Authentication](https://docs.nubisco.io/acta/self-hosting/authentication): one-time codes, OpenID Connect, access tokens
- [The MCP endpoint](https://docs.nubisco.io/acta/mcp/): [connecting a client](https://docs.nubisco.io/acta/mcp/connecting) and the [tool reference](https://docs.nubisco.io/acta/mcp/tools)
- Migrating from [Trello](https://docs.nubisco.io/acta/migrate/trello) and [Confluence](https://docs.nubisco.io/acta/migrate/confluence)
- [Architecture](https://docs.nubisco.io/acta/develop/) and the [data model](https://docs.nubisco.io/acta/develop/data-model)

## Development

```sh
pnpm install
pnpm dev            # server + web in parallel
pnpm quality:check  # test + lint + format:check + types:check
```

`@nubisco/ui` is consumed from a sibling `../ui` checkout via a pnpm link override; CI reproduces the same layout.

## Contributing

Contributions are welcome under the [Individual CLA](docs/CLA-INDIVIDUAL.md); see [CONTRIBUTING.md](./CONTRIBUTING.md). Generic UI components belong in [@nubisco/ui](https://github.com/nubisco/ui), not here.

## Support this project

Acta is free and self-hostable, and stays that way. Building and maintaining it
takes real work, so if it saves your team time, sponsorship is what keeps it
going.

- ❤️ [Sponsor via GitHub](https://github.com/sponsors/joseporto)
- ⭐ Star the repository, which is how other people find it
- 🐛 [Report a bug](https://github.com/nubisco/acta/issues/new/choose) or send a pull request

If you would rather not run it yourself, or you need something built around it,
[talk to Nubisco](https://nubisco.io).

## More from Nubisco

Acta is built and maintained by [**Nubisco**](https://nubisco.io), a Portuguese
software company that builds the tools it needs and opens the ones useful to
other people.

| Project                                             | What it is                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Nubisco UI](https://docs.nubisco.io/ui/)           | The Vue 3 component library this interface is built on. Geometry-first, token-driven, accessible. |
| [Verba](https://docs.nubisco.io/verba/)             | Self-hostable i18n collaboration: structured, reviewable, deployable translations.                |
| [Nubisco CMS](https://docs.nubisco.io/cms/)         | A headless CMS where content is reviewed, batched into releases and published on purpose.         |
| [OpenBridge](https://github.com/nubisco/openbridge) | Home automation bridge and its plugin ecosystem.                                                  |

## License and trademarks

The code in this repository is [MIT licensed](./LICENSE). Hosted, multi-tenant, and SSO modules are developed separately and are not part of this repository.

"Acta", "Nubisco", and the Nubisco logo are trademarks of Nubisco, Lda. The MIT license does not grant permission to use them; forks and derived products must use their own names and branding.

---

<div align="center">
  Built by <a href="https://nubisco.io">Nubisco</a> · <a href="https://github.com/sponsors/joseporto">Sponsor this project</a>
</div>
