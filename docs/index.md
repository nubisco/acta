---
layout: home

hero:
  name: Acta
  text: Boards and docs, co-managed with agents
  tagline: Kanban with stable item keys and a Markdown wiki in one self-hostable server, behind one API that treats AI agents as first-class, fully attributed actors.
  actions:
    - theme: brand
      text: What Acta is
      link: /guide/
    - theme: alt
      text: Run your own instance
      link: /self-hosting/
    - theme: alt
      text: Connect an agent
      link: /mcp/

features:
  - title: MCP from day one
    details: Every capability is an MCP tool with the same fidelity as the UI. Batch idempotent ops, delta reads and section-level document patches, so an agent spends tokens on thinking rather than on re-reading what it already knows.
    link: /mcp/
    linkText: The MCP endpoint
  - title: Humans and agents, one audit trail
    details: One actor model covers people, agents and the system. Every mutation carries who did it and what caused it, so "an agent changed this" is a fact you can query rather than a guess.
    link: /guide/concepts
    linkText: Concepts
  - title: Yours to run
    details: One container, SQLite, NAS-class hardware. Sign in with email codes or bring your own identity provider over standard OpenID Connect. No seat count, no phone-home.
    link: /self-hosting/
    linkText: Install
  - title: A way out of what you have
    details: Importers for Trello and Confluence that bring across comments, attachments, history and cross-references, and tell you precisely what they could not carry.
    link: /migrate/trello
    linkText: Migrate
---

## The plan as an order, not a wish

The view that is hardest to get from anything else: what can start now, what
waits on what, and the chain that decides when the whole thing finishes.

![The sequence view](/media/sequence.jpg)

## Built by Nubisco

Acta is built and maintained by **[Nubisco](https://nubisco.io)**, a Portuguese
software company that builds tools it needs and opens the ones that are useful
to other people.

|                                                         |                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **[Nubisco UI](https://docs.nubisco.io/ui/)**           | The Vue component library Acta's interface is built on. Geometry-first, token-driven, accessible. |
| **[Verba](https://docs.nubisco.io/verba/)**             | Self-hostable i18n collaboration: structured, reviewable, deployable translations.                |
| **[Nubisco CMS](https://docs.nubisco.io/cms/)**         | A headless CMS where content is reviewed, batched into releases and published on purpose.         |
| **[OpenBridge](https://github.com/nubisco/openbridge)** | Home automation bridge and its plugin ecosystem.                                                  |

If Acta saves your team time, [sponsoring the project](https://github.com/sponsors/joseporto)
is what keeps it maintained. If you would rather we ran it for you, or you need
something built around it, [talk to us](https://nubisco.io).

## Why another one of these

Most project tools were designed for people, then had an API bolted on and an
AI feature bolted on after that. The result is that an agent working in them is
a second-class user: it scrapes screens, re-reads whole documents to change a
sentence, and leaves changes that look like they came from whoever's token it
borrowed.

Acta starts from the other end. The API is the product, the UI and the MCP
endpoint are two equally complete clients of it, and an agent is an actor with
a name that appears in the history like anyone else.

That is also why it is self-hostable first. A tool that holds your plans and
your documentation, and that you point language models at, is a tool you should
be able to run yourself.
