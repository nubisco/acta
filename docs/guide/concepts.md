# Concepts

Six ideas explain most of Acta.

## Workspace

One installation holds one workspace: a name, its members, its spaces and its
documents. Everything below is scoped to it.

## Spaces and lists

A **space** is a board. It has a short uppercase **key** (`ENG`, `OPS`) which
becomes the prefix of every card in it.

A space contains ordered **lists** (the columns). Each list has a **role**,
which is how the server knows what a column _means_ rather than what it is
called:

| Role      | Meaning               |
| --------- | --------------------- |
| `backlog` | Not started           |
| `active`  | Being worked on       |
| `blocked` | Waiting on something  |
| `review`  | Done pending a check  |
| `done`    | Finished              |
| `inbox`   | Untriaged arrivals    |
| `none`    | No particular meaning |

Roles matter because "is this card finished" has to survive you renaming
_Done_ to _Shipped_. The `kanban6` template seeds Backlog, To Do, In Progress,
Blocked / Waiting, Review / Testing and Done.

## Items and keys

An **item** (a card) gets a key when it is created: the space key plus a
number, `ENG-142`. That key is permanent and is the thing you cite.

Moving a card to another space re-keys it and leaves an alias behind, so
`ENG-142` keeps resolving after the card becomes `OPS-17`. This is the reason
keys are worth having at all: a reference written in a document last year must
still work.

## Documents

Documents are Markdown with frontmatter, arranged in a tree by slug
(`manual/onboarding`). Every save creates a version.

Beyond CommonMark and GFM, Acta understands cross-references:

| Syntax                                     | Refers to                                      |
| ------------------------------------------ | ---------------------------------------------- |
| `[[ENG-142]]`                              | An item                                        |
| `[[space:ENG]]`                            | A space                                        |
| `[[doc:manual/vision]]`                    | A document (add `\|label` to retitle the link) |
| `[[@handle]]`                              | A member, which notifies them                  |
| `![[query: space=ENG list="In Progress"]]` | A live embed of matching items                 |

References are extracted on save and stored, so a document knows what points
at it, not only what it points to.

## Actors

Every member, every agent and the server itself is an **actor** with a handle.
Actors have a `kind`:

- `human`: a person who signs in.
- `agent`: a bot identity with its own token, optionally marked as acting
  on behalf of a person.
- `system`: the server, used when a rule fires.

This is what makes the audit trail worth reading. Work done by an agent is
attributed to that agent, not to whoever's credentials it borrowed.

::: tip Acting as yourself
A [personal access token](/mcp/#authentication) is different from an agent
token: it acts as _you_, with your role, and the history says you did it.
That is the right choice when you are driving the tool yourself from an editor
or a script. An agent token is for something running on its own.
:::

## Events

Every mutation appends an event: who, what, when, and `caused_by` when a rule
triggered it. Events drive the activity feed, notifications, webhooks and the
automation rules, and they are queryable with a cursor, so an agent can ask
"what changed since I last looked" cheaply.

## Dependencies and sequence

An item can declare that it waits for another. From those edges Acta computes
a **sequence**: which cards can start now, which are downstream, and the
longest chain by size, which is the one that decides when the whole thing
finishes. Items can carry a unitless **size** and be marked as **milestones**.

This is deliberately an order rather than a set of dates. People know that one
card blocks another long before anyone will commit to a Tuesday.
