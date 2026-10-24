# Acta open-core model

Acta is open core. This page says what is open, what is not, and why the line
sits where it does.

## The core

**License:** AGPL-3.0-or-later. **Code:** everything outside `packages/ee/`.

The core is the whole product, not a demo of it:

- Kanban spaces with stable item keys, checklists, dependencies, attachments
- The enhanced-Markdown docs wiki, with versions
- Goals and check-ins
- The MCP server and the REST API, with agents as attributed actors
- Rules, webhooks, connections and importers
- Notifications: bell, email digests, reminders, live updates
- SSO through the Platform handover and standard OpenID Connect
- Multiple workspaces on one instance, with invitations
- Bring-your-own-key AI features
- The Docker image, the Bun server and the Cloudflare Workers build

Self-hosting the core is free, and a self-hosted instance has no plan limits and
no billing screens. If you run a modified core as a network service, the AGPL
requires you to offer your changes to its users.

## The Enterprise Edition

**License:** proprietary, Nubisco, Lda. **Code:** `packages/ee/`.

The EE holds what Nubisco needs to run Acta as a hosted business:

- Self-serve signup and workspace provisioning
- Plans, their usage limits, and billing through Nubisco's licenses service
- Later: per-workspace SSO configuration and audit export for large customers

The core calls the EE through one seam, `server/src/core/edition.ts`. With no
EE registered, every limit is unlimited and no plan or billing route exists.
The EE entry point, `packages/ee/src/worker.ts`, registers itself and then
serves the core.

## Deployment modes

| Mode                     | Who runs it | Core | EE                       |
| ------------------------ | ----------- | ---- | ------------------------ |
| Self-hosted              | You         | Free | Not included             |
| Hosted (acta.nubisco.io) | Nubisco     | Free | Free plan and paid plans |
| Self-hosted with EE      | You         | Free | Commercial agreement     |

## Why the line is here

The hosted service sells operations, scale and the controls a business needs,
not features withheld from people who run Acta themselves. The split is legal,
not technical: there is no DRM and no obfuscated code. The EE source is
readable and auditable by anyone.

See [COMMERCIAL.md](./COMMERCIAL.md) for commercial use and [LICENSE](./LICENSE)
for the terms.
