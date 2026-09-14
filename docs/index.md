---
layout: home

hero:
  name: Acta
  text: Boards and docs, co-managed with agents
  tagline: >
    Kanban with stable card keys and a Markdown wiki in one self-hostable
    server, behind an API that treats AI agents as first-class, fully
    attributed actors.
  image:
    src: /logo.svg
    alt: Acta
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
  - icon:
      src: /media/mcp-mark.svg
      width: 36
      height: 36
    title: MCP from day one
    details: >
      Every capability is a Model Context Protocol tool with the same fidelity
      the interface has. One call to orient, batched idempotent writes, delta
      reads and section-level document patches.
    link: /mcp/
    linkText: The MCP endpoint
  - icon:
      src: https://api.iconify.design/ph/users-three-bold.svg?color=%2310a9a4
      width: 36
      height: 36
    title: Humans and agents, one audit trail
    details: >
      One actor model covers people, agents and the system. Every mutation
      carries who did it and what caused it, so "an agent changed this" is a
      fact you can query rather than a guess.
    link: /guide/concepts
    linkText: Concepts
  - icon:
      src: https://api.iconify.design/ph/graph-bold.svg?color=%23e0801a
      width: 36
      height: 36
    title: The plan as an order, not a wish
    details: >
      Declare that one card waits for another and Acta works out what can
      start now, what is downstream, and the chain that decides the finish.
    link: /guide/using
    linkText: The sequence view
  - icon:
      src: https://api.iconify.design/ph/shield-check-bold.svg?color=%235c35c4
      width: 36
      height: 36
    title: Yours to run
    details: >
      One container, SQLite, NAS-class hardware. Email codes, or bring your own
      provider over standard OpenID Connect. No seat count, no phone-home.
    link: /self-hosting/
    linkText: Install
  - icon:
      src: https://api.iconify.design/ph/arrows-left-right-bold.svg?color=%23c2417a
      width: 36
      height: 36
    title: A way out of what you have
    details: >
      Importers for Trello and Confluence that carry comments, attachments,
      history and cross-references, and tell you precisely what they could not.
    link: /migrate/trello
    linkText: Migrate
  - icon:
      src: https://api.iconify.design/ph/book-open-bold.svg?color=%232a7de1
      width: 36
      height: 36
    title: Boards and wiki in one place
    details: >
      Plans cite decisions and decisions cite the cards that implemented them.
      References resolve both ways and survive a card being moved or renamed.
    link: /guide/concepts
    linkText: The model
---
