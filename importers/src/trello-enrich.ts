/**
 * Trello enrichment CLI: backfills a completed import with what a board
 * export (or the MCP connector) cannot provide, via the Trello REST API:
 *
 *   1. Archived cards (boards/{id}/cards/closed) become archived items.
 *   2. Attachments (cards/{id}/attachments) land on every imported item:
 *      link attachments by url, uploaded files downloaded (up to 8 MB) and
 *      stored inline.
 *
 * Usage:
 *   bun src/trello-enrich.ts --dir <export-json-dir> [--key SW=board1.json ...]
 *     [--dry-run] [--out enrich-report.json]
 *
 * --dir holds the same zTrelloBoard JSON files trello-import reads; board ids
 * come from each file. Item creates replay by op_id (trello:<cardId>), so
 * running this after (or repeatedly over) trello-import cannot duplicate
 * anything; attachment adds have no op_id and are deduped by reading what
 * each item already has.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { TItemOp, TOpResult } from '@nubisco/acta-shared'
import { flagValue, flagValues, hasFlag, parseArgs } from './lib/args'
import { ActaClient, type IItemAttachment } from './lib/client'
import { ImportReport } from './lib/report'
import {
  TRELLO_API,
  downloadTrelloAttachment,
  trelloCredsFromEnv,
  type ITrelloCreds,
} from './trello/fetch'
import {
  zTrelloAttachment,
  zTrelloBoard,
  zTrelloCard,
  type TTrelloBoard,
  type TTrelloCard,
} from './trello/model'
import { planTrelloImport } from './trello/plan'
import { forcedKeyFor, parseKeyAssignments } from './trello-import'

const ENRICH_ATTACHMENT_MAX = 8 * 1024 * 1024
/** Pacing between Trello REST calls; sustained bursts trip rate limits. */
const REST_PACE_MS = 150

function usage(): void {
  console.error(
    'usage: bun src/trello-enrich.ts --dir <export-json-dir>\n' +
      '         [--key KEY=board.json ...] [--dry-run] [--out enrich-report.json]\n' +
      'env: ACTA_URL, ACTA_TOKEN, TRELLO_KEY, TRELLO_TOKEN',
  )
}

let lastRestCall = 0
async function pace(): Promise<void> {
  const wait = lastRestCall + REST_PACE_MS - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRestCall = Date.now()
}

async function trelloGet(path: string, creds: ITrelloCreds): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    await pace()
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(
      `${TRELLO_API}${path}${sep}key=${creds.key}&token=${creds.token}`,
    )
    if (res.status === 429 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 2000))
      continue
    }
    if (!res.ok) throw new Error(`trello api ${res.status} for ${path}`)
    return res.json()
  }
}

function resultsById(results: TOpResult[]): Map<string, TOpResult> {
  return new Map(results.map((r) => [r.op_id, r]))
}

/** List names as the import created them (Trello order, sibling dedupe). */
function listNamesById(board: TTrelloBoard): Map<string, string> {
  const lists = [...board.lists].sort((a, b) => a.pos - b.pos)
  const byId = new Map<string, string>()
  const used = new Set<string>()
  for (const list of lists) {
    let name = list.name
    let n = 2
    while (used.has(name.toLowerCase())) {
      name = `${list.name} (${n})`
      n += 1
    }
    used.add(name.toLowerCase())
    byId.set(list.id, name)
  }
  return byId
}

/** Trello label id → Acta label name, matching the import plan: named labels
 *  by name, color-only ones as color-<base>, empty ones dropped. */
function labelNamesById(board: TTrelloBoard): Map<string, string> {
  const byId = new Map<string, string>()
  for (const label of board.labels) {
    if (label.name) byId.set(label.id, label.name)
    else if (label.color)
      byId.set(label.id, `color-${label.color.split('_')[0]}`)
  }
  return byId
}

async function enrichBoard(
  source: TTrelloBoard,
  file: string,
  key: string,
  client: ActaClient,
  report: ImportReport,
  creds: ITrelloCreds,
  dryRun: boolean,
): Promise<void> {
  const section = report.section(`enrich ${key} (${source.name})`)

  // The import plan rebuilds every export card's create op; replaying those
  // op_ids resolves each card to its Acta item key without changing anything
  // already imported.
  const plan = planTrelloImport([{ board: source, file, forcedKey: key }], {
    memberMap: {},
    existingWorkspaceLabels: new Set(),
    existingBoardKeys: new Set(),
    doneAsArchived: false,
  })
  const items = plan.boards[0].items
  const keyByCard = new Map<string, string>()
  if (!dryRun) {
    const results = resultsById(
      await client.writeItems(items.map((i) => i.create)),
    )
    for (const item of items) {
      const result = results.get(item.create.op_id)
      if (result?.ok && result.key) keyByCard.set(item.cardId, result.key)
      else
        section.note(
          `card ${item.cardId}: create replay failed: ${
            result && !result.ok ? result.error : 'no result'
          }`,
        )
    }
  }

  // Archived cards ---------------------------------------------------------
  const exportCardIds = new Set(source.cards.map((c) => c.id))
  const listNames = listNamesById(source)
  const labelNames = labelNamesById(source)
  const closed = z
    .array(zTrelloCard)
    .parse(
      await trelloGet(
        `/boards/${source.id}/cards/closed` +
          '?fields=name,desc,idList,pos,due,dueComplete,idLabels,shortLink' +
          '&attachments=true',
        creds,
      ),
    )
    .filter((card) => !exportCardIds.has(card.id))
  section.source('archived_cards', closed.length)

  const archivedCards: TTrelloCard[] = []
  const archivedCreates: TItemOp[] = []
  for (const card of closed) {
    const listName = listNames.get(card.idList)
    if (!listName) {
      section.skipped(
        'archived_cards',
        card.id,
        `card list ${card.idList} not present in export`,
      )
      continue
    }
    const labels: string[] = []
    for (const id of card.idLabels) {
      const name = labelNames.get(id)
      if (name && !labels.includes(name)) labels.push(name)
    }
    const due = card.due ? Date.parse(card.due) : Number.NaN
    archivedCards.push(card)
    archivedCreates.push({
      op: 'create',
      op_id: `trello:${card.id}`,
      board: key,
      list: listName,
      title: card.name.slice(0, 500),
      description: card.desc ? card.desc.slice(0, 100_000) : undefined,
      labels: labels.length > 0 ? labels : undefined,
      due: Number.isFinite(due) ? due : undefined,
      imported_meta: {
        source: 'trello',
        url: card.shortLink
          ? `https://trello.com/c/${card.shortLink}`
          : undefined,
      },
    })
  }

  if (dryRun) {
    section.created('archived_cards', archivedCards.length)
  } else {
    const createResults = resultsById(await client.writeItems(archivedCreates))
    for (const card of archivedCards) {
      const result = createResults.get(`trello:${card.id}`)
      if (result?.ok && result.key) keyByCard.set(card.id, result.key)
      else
        section.failed(
          'archived_cards',
          card.id,
          result && !result.ok ? result.error : 'no result',
        )
    }
    const followUps: TItemOp[] = []
    for (const card of archivedCards) {
      const itemKey = keyByCard.get(card.id)
      if (!itemKey) continue
      followUps.push({
        op: 'archive',
        op_id: `trello:${card.id}:archive`,
        key: itemKey,
      })
      if (card.dueComplete)
        followUps.push({
          op: 'complete',
          op_id: `trello:${card.id}:complete`,
          key: itemKey,
        })
    }
    const followUpResults = resultsById(await client.writeItems(followUps))
    for (const card of archivedCards) {
      const itemKey = keyByCard.get(card.id)
      if (!itemKey) continue
      const archived = followUpResults.get(`trello:${card.id}:archive`)
      if (archived?.ok) section.created('archived_cards')
      else
        section.failed(
          'archived_cards',
          card.id,
          `archive failed: ${archived && !archived.ok ? archived.error : 'no result'}`,
        )
      if (card.dueComplete) {
        const completed = followUpResults.get(`trello:${card.id}:complete`)
        if (!completed?.ok)
          report.errors.push(`complete flag failed on ${itemKey} (${card.id})`)
      }
      report.mappings[`trello:${card.id}`] = {
        key: itemKey,
        board: key,
        archived: true,
      }
    }
  }

  // Attachments ------------------------------------------------------------
  const cards = [
    ...items.map((i) => ({ cardId: i.cardId })),
    ...archivedCards.map((c) => ({ cardId: c.id })),
  ]
  // Attachment adds have no op_id; idempotency comes from reading what each
  // item already has and skipping matches.
  const existing = dryRun
    ? new Map<string, IItemAttachment[]>()
    : await client.itemAttachments([...new Set(keyByCard.values())])

  for (const card of cards) {
    const itemKey = keyByCard.get(card.cardId)
    const atts = z
      .array(zTrelloAttachment)
      .parse(await trelloGet(`/cards/${card.cardId}/attachments`, creds))
    if (atts.length === 0) continue
    section.source('attachments', atts.length)
    if (!dryRun && !itemKey) {
      section.skipped(
        'attachments',
        card.cardId,
        'item was not created',
        atts.length,
      )
      continue
    }
    const present = itemKey ? (existing.get(itemKey) ?? []) : []
    for (const att of atts) {
      const filename = att.name || att.url.split('/').pop() || att.id
      if (!att.url) {
        section.skipped('attachments', att.id, 'attachment has no url')
        continue
      }
      if (present.some((p) => p.url === att.url || p.filename === filename)) {
        section.created('attachments') // already there from a previous run
        continue
      }
      if (!att.isUpload) {
        if (dryRun) {
          section.created('attachments')
          continue
        }
        try {
          await client.addAttachment({ item: itemKey!, filename, url: att.url })
          section.created('attachments')
        } catch (err) {
          section.failed('attachments', att.id, String(err))
        }
        continue
      }
      if (att.bytes !== null && att.bytes !== undefined) {
        if (att.bytes > ENRICH_ATTACHMENT_MAX) {
          section.skipped(
            'attachments',
            att.id,
            `file attachment ${filename} skipped (${att.bytes} bytes > 8 MB)`,
          )
          continue
        }
      }
      if (dryRun) {
        section.created('attachments')
        continue
      }
      await pace()
      const downloaded = await downloadTrelloAttachment(att.url, creds)
      if (!downloaded) {
        section.skipped(
          'attachments',
          att.id,
          `download failed for ${filename}`,
        )
        continue
      }
      if (downloaded.bytes.byteLength > ENRICH_ATTACHMENT_MAX) {
        section.skipped(
          'attachments',
          att.id,
          `file attachment ${filename} skipped (larger than 8 MB)`,
        )
        continue
      }
      try {
        await client.addAttachment({
          item: itemKey!,
          filename,
          mime: downloaded.mime ?? att.mimeType ?? undefined,
          content_base64: Buffer.from(downloaded.bytes).toString('base64'),
        })
        section.created('attachments')
      } catch (err) {
        section.failed('attachments', att.id, String(err))
      }
    }
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const dir = flagValue(args, 'dir')
  if (!dir) {
    usage()
    return 2
  }
  const creds = trelloCredsFromEnv()
  if (!creds) {
    console.error(
      'trello-enrich needs TRELLO_KEY and TRELLO_TOKEN in the environment',
    )
    return 2
  }
  const dryRun = hasFlag(args, 'dry-run')
  const outPath = flagValue(args, 'out') ?? 'enrich-report.json'
  const keyAssignments = parseKeyAssignments(flagValues(args, 'key'))

  const client = new ActaClient()
  const report = new ImportReport('trello-enrich', dryRun)

  // Board keys: --key wins; otherwise the imported board with the same name.
  let keyByBoardName = new Map<string, string>()
  try {
    const overview = await client.overview()
    keyByBoardName = new Map(overview.boards.map((b) => [b.name, b.key]))
  } catch (err) {
    if (!dryRun) {
      console.error(`cannot reach the Acta server: ${String(err)}`)
      return 1
    }
    console.log('dry-run without a reachable server: relying on --key mappings')
  }

  const entries = readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
  for (const entry of entries) {
    const file = join(dir, entry)
    const board = zTrelloBoard.parse(JSON.parse(readFileSync(file, 'utf8')))
    const key =
      forcedKeyFor(keyAssignments, [file, entry, board.id, board.shortLink]) ??
      keyByBoardName.get(board.name)
    if (!key) {
      report.errors.push(
        `board "${board.name}" (${entry}): no --key mapping and no imported board with that name`,
      )
      continue
    }
    await enrichBoard(board, file, key, client, report, creds, dryRun)
  }

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
