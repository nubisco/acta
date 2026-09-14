# Migrating from Confluence

The importer reads Confluence pages (from a directory of JSON, or fetched
live) and writes them to Acta as documents, converting storage-format XHTML to
Markdown and preserving the page tree, versions and authorship.

Like the Trello importer it is **idempotent**, so running it again after fixing
something cannot duplicate pages.

## Before you start

```sh
export ACTA_URL=https://acta.example.com
export ACTA_TOKEN=acta_pat_...
```

::: tip Import Trello first
If you are migrating both, do Trello first and pass the resulting map here.
Confluence pages that link to Trello boards and cards then become real Acta
references instead of dead links. Getting the order wrong is not fatal, but
fixing it later means editing pages by hand.
:::

## 1. Get the pages

**Live**, which is usually simplest:

```sh
export CONFLUENCE_BASE=https://yourorg.atlassian.net/wiki
export CONFLUENCE_EMAIL=you@example.com
export CONFLUENCE_API_TOKEN=...   # id.atlassian.com → Security → API tokens
```

**Or from files.** `--dir` accepts a directory of JSON files or a single file.
Each file may hold one page, an array of pages, or a raw REST response
(`{results: [...]}`), as long as bodies are in storage format
(`body.storage.value`).

## 2. Dry run

```sh
cd importers
bun src/confluence-import.ts --fetch ENG OPS --dry-run
```

Nothing is written. You get the planned document tree, the reconciliation, and
crucially the **conversion issues**: macros the converter did not recognise,
links it could not resolve, and attachments it skipped.

Read the unknown-macro list before importing. It is the honest measure of how
much of your wiki is Confluence-specific.

## 3. Import

```sh
bun src/confluence-import.ts \
  --fetch ENG OPS \
  --root archive \
  --trello-map trello-map.json \
  --source-base https://yourorg.atlassian.net/wiki \
  --out confluence-report.json
```

## Options

| Flag                     | Does                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `--dir <path>`           | Directory of page JSON, or a single JSON file.                                                          |
| `--fetch <SPACEKEY ...>` | Fetch spaces live instead.                                                                              |
| `--root <slug>`          | Land the tree under a slug, e.g. `archive`. Stub pages are created for path segments that do not exist. |
| `--trello-map map.json`  | Trello board shortlink to Acta space key, so links become `[[space:KEY]]`.                              |
| `--include-personal`     | Include personal spaces (`~username`), which are excluded by default.                                   |
| `--source-base <url>`    | Your wiki's base URL, recorded so each page links back to its original.                                 |
| `--dry-run`              | Print the plan, reconciliation and conversion issues; write nothing.                                    |
| `--out report.json`      | Write the report.                                                                                       |

## What converts

| Confluence                                       | Acta                                            |
| ------------------------------------------------ | ----------------------------------------------- |
| Page tree (ancestors)                            | Document tree by slug                           |
| Headings, lists, tables, quotes, rules, code     | The Markdown equivalents                        |
| Task lists                                       | Task lists                                      |
| `info`, `tip`, `note`, `warning`, `panel` macros | Callouts                                        |
| `expand` macro                                   | A collapsible `:::details` block                |
| `code` macro                                     | A fenced block, language preserved              |
| Page links                                       | `[[doc:slug]]` references                       |
| Trello links                                     | `[[space:KEY]]` references, with `--trello-map` |
| Version history                                  | Document versions                               |
| Authors and timestamps                           | Preserved as provenance                         |

## What does not

**Unrecognised macros** are not silently dropped, which would be the worst
possible outcome. Each becomes a callout marked with the macro name, holding
whatever body content it had. The page keeps its meaning and shows you exactly
where a human needs to look. Every one is listed in the report.

Expect to find: `jira`, `roadmap`, `chart`, `gallery`, `include`,
`excerpt-include`, and anything from a marketplace app. These have no Acta
equivalent and mostly never will.

**Page layouts** (`ac:layout`, multi-column sections) are flattened. Cells
become sequential content. Markdown has no columns, so this is a real loss of
presentation, though not of text.

**Inline and footer comments** are not imported. Confluence attaches inline
comments to text ranges that no longer exist after conversion.

**Attachments** the converter could not resolve are listed as skipped rather
than assumed. Check that list.

## Afterwards

1. Work the unknown-macro list. Sort by frequency; a macro used once is a
   page to fix by hand, a macro used two hundred times is a decision.
2. Check pages that used layouts, because they read worst.
3. Follow a few cross-references, especially into Trello-derived spaces.
4. Make Confluence read-only rather than cancelling it, until you are certain.
   Export first regardless.
