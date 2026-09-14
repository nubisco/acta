# What Acta is

Acta (Latin: _things done_) is a project management and documentation server.
It holds two things that usually live in two products:

- **Spaces**: kanban boards whose cards have stable keys (`ENG-142`) that
  survive being moved, renamed and re-listed.
- **Documents**: a Markdown wiki with a page tree, versions and
  cross-references to cards.

They are in one server because they refer to each other constantly. A plan
cites a decision; a decision record cites the cards that implemented it. When
those live in two products the references are URLs that rot, and nobody notices
until the link is dead.

## Who it is for

**Teams who want their planning tool to be theirs.** One container, SQLite, and
hardware you already own. There is no seat count and nothing phones home.

**Teams working with AI agents.** Acta treats an agent as an actor, not as a
borrowed human account. Every card, comment and document edit records who made
it, and an agent's work is attributed to the agent. The
[MCP endpoint](/mcp/) exposes the same capability the UI has.

**Teams leaving something else.** There are [importers](/migrate/trello) for
Trello and Confluence that carry comments, attachments, history and
cross-references, and report exactly what they could not bring.

## What it is not

It is not a time tracker, a CRM, or a support desk. It is not an issue tracker
for public bug reports from strangers. It has no Gantt-chart contractor
scheduling, no resource levelling and no billing.

It also does not try to be a chat application. Comments exist on cards and
documents because a decision needs to be recorded next to the thing it decides,
not so that you can hold conversations in it.

## The shape of it

```
┌──────────────┐        ┌──────────────┐
│  Web app     │        │  Agent       │
│  (Vue SPA)   │        │  (MCP)       │
└──────┬───────┘        └──────┬───────┘
       │  /api/v1              │  /mcp
       └───────────┬───────────┘
                   ▼
        ┌─────────────────────┐
        │  Acta server        │
        │  Hono on Bun        │
        │  ─────────────────  │
        │  items · documents  │
        │  events · rules     │
        │  webhooks · search  │
        └──────────┬──────────┘
                   ▼
          SQLite (or D1) + blobs
```

The MCP endpoint is not a wrapper around a subset of the API. It is a second
client of the same services, which is why an agent can do what you can do.

## Where to go next

- [Concepts](/guide/concepts): spaces, items, keys, actors, events.
- [Working in Acta](/guide/using): the day-to-day of the web app.
- [Run your own instance](/self-hosting/): Docker, Cloudflare, or from source.
- [Connect an agent](/mcp/): tokens, clients, tools.
