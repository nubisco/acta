/**
 * Trello importer CLI (mvp F11).
 *
 * Usage:
 *   bun src/trello-import.ts --files board1.json board2.json \
 *     --map member-map.json [--dry-run] [--done-as-archived [SW,LABS]] \
 *     [--key SW=board1.json ...] [--fetch <boardIdOrShortLink> ...] \
 *     [--out import-report.json]
 *
 * Reads local Trello board-export JSON files (or fetches boards live when
 * TRELLO_KEY/TRELLO_TOKEN are set and --fetch is used) and writes to a
 * running Acta server (ACTA_URL, ACTA_TOKEN) through the batch endpoints.
 * --dry-run prints the full plan and reconciliation without writing.
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { flagValue, flagValues, hasFlag, parseArgs } from './lib/args'
import { ActaClient } from './lib/client'
import { ImportReport } from './lib/report'
import {
  downloadTrelloAttachment,
  fetchTrelloBoard,
  trelloCredsFromEnv,
} from './trello/fetch'
import { zTrelloBoard } from './trello/model'
import { planTrelloImport, type ITrelloPlanInput } from './trello/plan'
import { printTrelloPlan, runTrelloImport } from './trello/run'

const SEEDED_TAXONOMY = [
  'bug',
  'feature',
  'engineering',
  'tech debt',
  'urgent',
  'docs',
  'marketing',
]

function usage(): void {
  console.error(
    'usage: bun src/trello-import.ts --files <board.json ...> [--map member-map.json]\n' +
      '         [--dry-run] [--done-as-archived [KEYS]] [--key KEY=board.json ...]\n' +
      '         [--fetch <boardIdOrShortLink> ...] [--out import-report.json]\n' +
      'env: ACTA_URL, ACTA_TOKEN, TRELLO_KEY, TRELLO_TOKEN',
  )
}

interface IKeyAssignment {
  key: string
  match: string
}

function forcedKeyFor(
  assignments: IKeyAssignment[],
  candidates: string[],
): string | undefined {
  for (const a of assignments) {
    if (candidates.some((c) => c === a.match || basename(c) === a.match))
      return a.key
  }
  return undefined
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const files = flagValues(args, 'files')
  const fetchIds = flagValues(args, 'fetch')
  if (files.length === 0 && fetchIds.length === 0) {
    usage()
    return 2
  }
  const dryRun = hasFlag(args, 'dry-run')
  const outPath = flagValue(args, 'out') ?? 'import-report.json'
  const keyAssignments: IKeyAssignment[] = flagValues(args, 'key').map((v) => {
    const idx = v.indexOf('=')
    if (idx === -1) throw new Error(`--key expects KEY=path, got ${v}`)
    return { key: v.slice(0, idx), match: v.slice(idx + 1) }
  })
  const doneValues = flagValues(args, 'done-as-archived').flatMap((v) =>
    v.split(',').filter(Boolean),
  )
  const doneAsArchived = hasFlag(args, 'done-as-archived')
    ? doneValues.length > 0
      ? new Set(doneValues)
      : true
    : false
  const memberMapFile = flagValue(args, 'map')
  const memberMap: Record<string, string> = memberMapFile
    ? (JSON.parse(readFileSync(memberMapFile, 'utf8')) as Record<
        string,
        string
      >)
    : {}

  const creds = trelloCredsFromEnv()
  const client = new ActaClient()
  const report = new ImportReport('trello-import', dryRun)

  // Workspace context: reuse seeded/existing labels by name, avoid board key
  // collisions, validate mapped member handles.
  let existingWorkspaceLabels = new Set<string>(SEEDED_TAXONOMY)
  let existingBoardKeys = new Set<string>()
  let existingActorHandles: Set<string> | undefined
  try {
    const overview = await client.overview()
    existingWorkspaceLabels = new Set(
      overview.labels
        .filter((l) => l.board_key === null)
        .map((l) => l.name.toLowerCase()),
    )
    existingBoardKeys = new Set(overview.boards.map((b) => b.key))
    existingActorHandles = new Set(overview.actors.map((a) => a.handle))
  } catch (err) {
    if (!dryRun) {
      console.error(`cannot reach the Acta server: ${String(err)}`)
      return 1
    }
    console.log(
      'dry-run without a reachable server: assuming the seeded label taxonomy',
    )
  }

  const inputs: ITrelloPlanInput[] = []
  for (const file of files) {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const board = zTrelloBoard.parse(raw)
    inputs.push({
      board,
      file,
      forcedKey: forcedKeyFor(keyAssignments, [
        file,
        board.id,
        board.shortLink,
      ]),
    })
  }
  for (const id of fetchIds) {
    if (!creds) {
      console.error('--fetch requires TRELLO_KEY and TRELLO_TOKEN')
      return 2
    }
    const board = zTrelloBoard.parse(await fetchTrelloBoard(id, creds))
    inputs.push({
      board,
      forcedKey: forcedKeyFor(keyAssignments, [id, board.id, board.shortLink]),
    })
  }

  const plan = planTrelloImport(inputs, {
    memberMap,
    existingWorkspaceLabels,
    existingBoardKeys,
    existingActorHandles,
    doneAsArchived,
  })

  if (dryRun) printTrelloPlan(plan)
  await runTrelloImport(plan, client, report, {
    dryRun,
    downloadAttachment: creds
      ? (att) => downloadTrelloAttachment(att.url, creds)
      : undefined,
  })

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
