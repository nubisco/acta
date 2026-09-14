# For developers

This half of the documentation is for running Acta, integrating with it, or
working on it. If you are using an Acta someone else runs, you want
[the users' half](/users/) instead.

## Running it

Acta is one process: API, MCP endpoint and web app on a single port, with
SQLite and a directory of attachments. No separate database server, queue or
cache.

- **[Install](/developers/install)**: Docker, behind a reverse proxy, on
  Cloudflare Workers, or from source.
- **[Configuration](/developers/configuration)**: every environment variable,
  read out of the code rather than from memory.
- **[Authentication](/developers/authentication)**: email one-time codes,
  OpenID Connect against your own provider, and access tokens.

## Moving in

- **[From Trello](/developers/migrate-trello)**: boards, cards, comments,
  attachments and members, with a dry run and a reconciliation first.
- **[From Confluence](/developers/migrate-confluence)**: page trees, version
  history and cross-references, including an honest list of what does not
  convert.

## Building on it

- **[The MCP endpoint](/developers/mcp)**: what it is, why it is shaped for
  token economy, and the two kinds of token.
- **[Tools](/developers/mcp-tools)**: the tool reference.

The REST API under `/api/v1` mirrors the same services, so anything an agent
can do a script can do.

## Working on Acta

- **[Architecture](/developers/architecture)**: the two runtimes, the write
  path, and the three things that catch people out.
- **[The data model](/developers/data-model)**: the tables that carry the
  ideas.

Contributions go through the
[contributing guide](https://github.com/nubisco/acta/blob/master/CONTRIBUTING.md)
and an Individual CLA.

::: warning Before your first schema change
A failed migration is memoized per isolate, so a bad one is not a degraded
feature: it is every request failing until a redeploy. Read the migrations
section of [Architecture](/developers/architecture) first.
:::
