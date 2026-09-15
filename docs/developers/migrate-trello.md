# Migrating from Trello

The importer reads Trello board exports (or fetches boards live) and writes to
a running Acta instance through the batch endpoints. It brings across lists,
cards, labels, checklists, comments, attachments, due dates and members.

It is **idempotent**: every op id derives from the Trello source id, so running
it twice cannot duplicate anything. That is what makes the recommended
approach safe, which is to run it repeatedly until the reconciliation is clean.

## Before you start

You need a running Acta instance and a token that can write to it. A
[personal access token](/developers/mcp#authentication) with read and write is fine, and
has the advantage that the import is attributed to you.

```sh
export ACTA_URL=https://acta.example.com
export ACTA_TOKEN=acta_pat_...
```

## 1. Get the boards

**From the Trello UI**: on each board, _Share → Print, export and share →
Export as JSON_. Save the files.

**Or fetch them live**, which is easier for more than a couple of boards:

```sh
export TRELLO_KEY=...    # https://trello.com/power-ups/admin
export TRELLO_TOKEN=...
```

::: warning Use a read-only token if you can
The importer only reads Trello, but a token with write access is a token that
_could_ write. Mint the narrowest one that works, and revoke it when the
migration is done.
:::

## 2. Map the people

Trello usernames mean nothing to Acta. Write a `member-map.json`:

```json
{
  "danaexample": "dana",
  "rtaylor2": "riley"
}
```

The keys are Trello usernames, the values are Acta handles. Members you leave
out are skipped and reported, rather than silently dropped: assignments to
them simply do not appear, and the report tells you how many.

Create the Acta members first, from **Settings → People**.

## 3. Choose the space keys

Every Acta space needs a short uppercase key, which becomes the card prefix.
Assign one per board:

```sh
--key ENG=engineering.json --key OPS=operations.json
```

Choose carefully. The key is in every card reference you will ever write.

## 4. Dry run

```sh
cd importers
bun src/trello-import.ts \
  --files engineering.json operations.json \
  --key ENG=engineering.json --key OPS=operations.json \
  --map member-map.json \
  --dry-run
```

This writes nothing. It prints the full plan and a reconciliation: how many
lists, cards, comments, checklists and attachments the source has, and how
many the plan accounts for. Read it. Any gap is a question to answer before
you write anything.

## 5. Import

Drop `--dry-run` and keep a report:

```sh
bun src/trello-import.ts \
  --files engineering.json operations.json \
  --key ENG=engineering.json --key OPS=operations.json \
  --map member-map.json \
  --out import-report.json
```

## Options

| Flag                        | Does                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| `--files <a.json ...>`      | Board exports to read.                                                     |
| `--fetch <boardId ...>`     | Fetch live instead, using `TRELLO_KEY`/`TRELLO_TOKEN`.                     |
| `--key KEY=file.json`       | Space key for a board. Repeatable.                                         |
| `--map member-map.json`     | Trello username to Acta handle.                                            |
| `--dry-run`                 | Print the plan and reconciliation, write nothing.                          |
| `--done-as-archived [KEYS]` | Archive cards that land in a done list, for all boards or the listed keys. |
| `--allow-missing-comments`  | Proceed when fewer comments are found than the card badges claim.          |
| `--out report.json`         | Write the reconciliation report.                                           |
| `--fix-comments`            | Imports nothing, rewrites comments imported before provenance existed.     |

## What comes across

| Trello           | Acta                                                       |
| ---------------- | ---------------------------------------------------------- |
| Board            | Space                                                      |
| List             | List, with a role inferred from its name                   |
| Card             | Item, with a permanent key                                 |
| Card description | Item description                                           |
| Labels           | Labels, plus a `<KEY> Colors` group for colour-only labels |
| Checklists       | Checklists                                                 |
| Comments         | Comments, with the original author and timestamp           |
| Attachments      | Attachments, downloaded and stored                         |
| Due dates        | Due dates                                                  |
| Members          | Assignees, via your map                                    |

Every imported item records where it came from, so a card shows that it was
imported and links back to the Trello original.

## Comments are the part that goes wrong

Trello's board export contains a truncated slice of board _activity_, not the
union of every card's comments. On a busy board this silently loses older
comments, and it does so without any error.

The importer counts what it found against each card's `badges.comments`, which
is the per-card truth, and refuses to proceed if they disagree. That refusal
is the feature. If you hit it, fetch the boards live with `--fetch` instead of
using the exports, which reads comments per card.

Only pass `--allow-missing-comments` once you know why the numbers differ and
have decided you can live with it.

## Afterwards

1. Compare counts: spaces, cards per list, comments on a few busy cards.
2. Spot-check attachments actually open.
3. Check the report for skipped members and any other skips.
4. **Then** make Trello read-only, rather than deleting anything. Keep the
   exports, because they cost nothing and settle arguments.

If you are also [migrating Confluence](/developers/migrate-confluence), do it after this
one and pass the Trello map, so that page references to Trello cards are
rewritten into Acta references rather than left as dead links.
