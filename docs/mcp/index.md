# The MCP endpoint

Acta speaks the Model Context Protocol at `/mcp`, so an agent can read and
change spaces, items and documents with the same fidelity the web app has.

## What it is

A stateless Streamable HTTP MCP server: every request is one JSON-RPC message
over `POST`, answered with JSON. There are no sessions, no SSE streams and no
server-initiated messages. It exposes **tools only**, no resources and no
prompts.

Each tool is a second client of the same service the REST API calls, not a
reimplementation and not a subset. Every permission check is the service's, so
a tool call is never more powerful than the same person doing the same thing
in the UI.

### Built for token economy

The design assumption is that the expensive resource is context, not requests.

- **`workspace_overview` is a one-call bootstrap.** Spaces, lists, item
  counts, labels, members and document roots. No other read is needed to
  orient, so an agent does not spend a thousand tokens discovering what exists.
- **Writes are batched and idempotent.** Up to 100 ops in one call, each with
  a client-supplied `op_id`, each transactional. A retry after a timeout
  re-sends the same `op_id` and does not duplicate the work.
- **Reads take a delta cursor.** `updated_since` on a space, `since` on the
  activity trail. "What changed since I last looked" is one small response.
- **Documents patch by section.** `doc_get` returns a heading map with a hash
  per section; `doc_write patch_section` sends back one section and its hash.
  Changing a paragraph transfers a paragraph, and conflicts are raised only
  when the _same section_ moved underneath you.

## Authentication

`Authorization: Bearer <token>`. Two kinds of token, and the difference
matters because it decides whose name ends up in the history.

### Personal access tokens

Minted by any member from **Settings → Access tokens**, shown once, stored
hashed, revocable instantly. They act as **you**, with your role, and the
audit trail attributes the work to you.

This is the right choice when you are the one driving: your editor, your
scripts, your machine.

They are deliberately limited. A personal token never carries administrator
rights, even when you are an administrator, and it cannot mint another token.
Administration takes a browser session and a deliberate visit, so a token that
leaks out of a config file cannot quietly become permanent.

Tokens are prefixed `acta_pat_` so that secret scanners and humans reading a
diff can both recognise one, and each records when it was last used, which is
what lets you retire an old one with confidence.

### Agent tokens

Minted by an administrator from **Settings → Members**. Each gets its own
actor with its own handle, optionally marked as acting on behalf of a person.

This is the right choice for something running on its own: a scheduled job, a
long-lived assistant, anything whose work should read as _its_ work. Scopes
are chosen at creation (`read`, `write`, `admin`).

## What is deliberately absent

No OAuth flow. Connector UIs that refuse a pasted header (ChatGPT, the
claude.ai web connector) are therefore not supported; clients that accept a
bearer header are.

No tool for member administration, workspace settings or token management,
because none of those is routine agent work and all of them are the things you
would least like a leaked token to reach.

No sequence or dependency tools yet, although the REST API and the UI both
have them. An agent can read `blocked_by` and `blocks` on an item through
`item_get`, but cannot currently ask for a whole plan in one call.

## Next

- [Connecting a client](/mcp/connecting)
- [Tool reference](/mcp/tools)
