/**
 * Confluence importer CLI (mvp F12).
 *
 * Usage:
 *   bun src/confluence-import.ts --dir pages/ [--dry-run] [--root manual]
 *     [--trello-map map.json] [--include-personal] [--fetch SPACEKEY ...]
 *     [--out import-report.json]
 *
 * --dir accepts a directory of page JSON files or a single JSON file; each
 * file holds one page, an array of pages, or a Confluence REST response
 * ({results: [...]}) with storage-format bodies. With --fetch and
 * CONFLUENCE_BASE/CONFLUENCE_EMAIL/CONFLUENCE_API_TOKEN set, spaces are
 * pulled live instead. Writes go to ACTA_URL with ACTA_TOKEN; --dry-run
 * prints the full plan and reconciliation without writing.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { flagValue, flagValues, hasFlag, parseArgs } from './lib/args'
import { ActaClient } from './lib/client'
import { ImportReport } from './lib/report'
import {
  confluenceCredsFromEnv,
  fetchConfluenceSpace,
} from './confluence/fetch'
import { normalizePage, type IConfluencePage } from './confluence/model'
import {
  DEFAULT_TRELLO_BOARD_MAP,
  planConfluenceImport,
} from './confluence/plan'
import { printConfluencePlan, runConfluenceImport } from './confluence/run'

function usage(): void {
  console.error(
    'usage: bun src/confluence-import.ts --dir <pages-dir-or-file.json>\n' +
      '         [--dry-run] [--root manual] [--trello-map map.json]\n' +
      '         [--include-personal] [--fetch SPACEKEY ...] [--out import-report.json]\n' +
      'env: ACTA_URL, ACTA_TOKEN, CONFLUENCE_BASE, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN',
  )
}

function pagesFromValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'object' && value !== null && 'results' in value) {
    const results = (value as { results: unknown }).results
    if (Array.isArray(results)) return results
  }
  return [value]
}

function loadPages(path: string): unknown[] {
  const stats = statSync(path)
  if (stats.isDirectory()) {
    const out: unknown[] = []
    for (const entry of readdirSync(path).sort()) {
      if (!entry.endsWith('.json')) continue
      out.push(
        ...pagesFromValue(JSON.parse(readFileSync(join(path, entry), 'utf8'))),
      )
    }
    return out
  }
  return pagesFromValue(JSON.parse(readFileSync(path, 'utf8')))
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const dir = flagValue(args, 'dir')
  const fetchSpaces = flagValues(args, 'fetch')
  if (!dir && fetchSpaces.length === 0) {
    usage()
    return 2
  }
  const dryRun = hasFlag(args, 'dry-run')
  const outPath = flagValue(args, 'out') ?? 'import-report.json'
  const root = flagValue(args, 'root')
  const trelloMapFile = flagValue(args, 'trello-map')
  const trelloBoards: Record<string, string> = trelloMapFile
    ? (JSON.parse(readFileSync(trelloMapFile, 'utf8')) as Record<
        string,
        string
      >)
    : DEFAULT_TRELLO_BOARD_MAP

  const rawPages: unknown[] = dir ? loadPages(dir) : []
  if (fetchSpaces.length > 0) {
    const creds = confluenceCredsFromEnv()
    if (!creds) {
      console.error(
        '--fetch requires CONFLUENCE_BASE, CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN',
      )
      return 2
    }
    for (const space of fetchSpaces)
      rawPages.push(...(await fetchConfluenceSpace(space, creds)))
  }
  const pages: IConfluencePage[] = rawPages.map(normalizePage)

  const client = new ActaClient()
  const report = new ImportReport('confluence-import', dryRun)

  let existingSlugs = new Set<string>()
  try {
    existingSlugs = new Set((await client.docTree()).map((d) => d.slug))
  } catch (err) {
    if (!dryRun) {
      console.error(`cannot reach the Acta server: ${String(err)}`)
      return 1
    }
    console.log(
      'dry-run without a reachable server: assuming an empty doc tree',
    )
  }

  const plan = planConfluenceImport(pages, {
    root,
    trelloBoards,
    existingSlugs,
    includePersonal: hasFlag(args, 'include-personal'),
  })

  if (dryRun) printConfluencePlan(plan)
  await runConfluenceImport(plan, client, report, { dryRun })

  report.print()
  report.write(outPath)
  console.log(`report written to ${outPath}`)
  return report.ok() ? 0 : 1
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (err) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    },
  )
}
