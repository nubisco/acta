/**
 * Applies a Trello plan against a running Acta server (or, in dry-run mode,
 * only reconciles the plan). Create ops go first, in stable order, because
 * item keys are assigned server-side in op order; follow-up ops (comments,
 * complete, archive) then use the keys returned by the create batch.
 */

import type { TItemOp, TOpResult } from '@nubisco/acta-shared'
import type { ActaClient } from '../lib/client'
import type { ImportReport } from '../lib/report'
import type { IPlannedAttachment, ITrelloBoardPlan, ITrelloPlan } from './plan'

export interface ITrelloRunOptions {
  dryRun: boolean
  /** Present only when TRELLO_KEY/TRELLO_TOKEN were provided. */
  downloadAttachment?: (
    att: IPlannedAttachment,
  ) => Promise<{ bytes: Uint8Array; mime: string | null } | null>
}

const INLINE_ATTACHMENT_MAX = 1_048_576

function resultsById(results: TOpResult[]): Map<string, TOpResult> {
  return new Map(results.map((r) => [r.op_id, r]))
}

export function printTrelloPlan(plan: ITrelloPlan): void {
  console.log('\n== plan ==')
  if (plan.labelOps.length > 0)
    console.log(`workspace label ops: ${plan.labelOps.length}`)
  for (const board of plan.boards) {
    console.log(`\nboard ${board.key} (${board.name})`)
    for (const op of board.boardOps) {
      if (op.op !== 'list_create') continue
      const items = board.items.filter((i) => i.listName === op.name)
      console.log(
        `  list "${op.name}" [${op.role}]: ${items.length} item(s), ${items.filter((i) => i.archive).length} archived`,
      )
    }
  }
}

/** Board + list creation. Runs before label ops (board groups need the board). */
async function runBoardStructure(
  board: ITrelloBoardPlan,
  client: ActaClient,
  report: ImportReport,
  opts: ITrelloRunOptions,
): Promise<void> {
  const section = report.section(`board ${board.key} (${board.name})`)
  for (const [kind, n] of Object.entries(board.counts)) section.source(kind, n)
  for (const skip of board.skips)
    section.skipped(skip.kind, skip.id, skip.reason, skip.n ?? 1)
  for (const note of board.notes) section.note(note)

  if (opts.dryRun) {
    section.created(
      'lists',
      board.boardOps.filter((op) => op.op === 'list_create').length,
    )
  } else {
    const results = resultsById(await client.writeBoards(board.boardOps))
    for (const op of board.boardOps) {
      const result = results.get(op.op_id)
      if (op.op === 'create') {
        if (result && !result.ok)
          section.note(
            `board create: ${result.error} (continuing into existing board)`,
          )
        continue
      }
      if (op.op !== 'list_create') continue
      if (result?.ok) section.created('lists')
      else section.failed('lists', op.op_id, result?.error ?? 'no result')
    }
  }
}

async function runBoardItems(
  board: ITrelloBoardPlan,
  client: ActaClient,
  report: ImportReport,
  opts: ITrelloRunOptions,
): Promise<void> {
  const section = report.section(`board ${board.key} (${board.name})`)

  // Item creates -----------------------------------------------------------
  const keyByCard = new Map<string, string>()
  if (opts.dryRun) {
    board.items.forEach((item, i) => {
      keyByCard.set(item.cardId, `${board.key}-${i + 1}`)
    })
  } else {
    const createResults = resultsById(
      await client.writeItems(board.items.map((item) => item.create)),
    )
    for (const item of board.items) {
      const result = createResults.get(item.create.op_id)
      if (result?.ok && result.key) keyByCard.set(item.cardId, result.key)
    }
  }

  // Follow-ups: comments, complete flag, archive, provenance ---------------
  const followUps: TItemOp[] = []
  for (const item of board.items) {
    const key = keyByCard.get(item.cardId)
    if (!key) continue
    for (const comment of item.comments)
      followUps.push({
        op: 'comment',
        op_id: comment.opId,
        key,
        body: comment.body,
        imported_meta: comment.meta,
      })
    if (item.complete)
      followUps.push({
        op: 'complete',
        op_id: `trello:${item.cardId}:complete`,
        key,
      })
    if (item.archive)
      followUps.push({
        op: 'archive',
        op_id: `trello:${item.cardId}:archive`,
        key,
      })
    // set_meta on every item, so items whose create op merely replayed (an
    // earlier import without provenance) get enriched too.
    followUps.push({
      op: 'set_meta',
      op_id: `trello:meta:${item.cardId}`,
      key,
      imported_meta: item.meta,
    })
  }
  const followUpResults = opts.dryRun
    ? new Map<string, TOpResult>()
    : resultsById(await client.writeItems(followUps))

  section.source('metas', board.items.length)
  for (const item of board.items) {
    const kind = item.archive ? 'items_archived' : 'items_open'
    const key = keyByCard.get(item.cardId)
    if (!key) {
      section.failed(kind, item.cardId, 'item create failed')
      section.skipped('metas', item.cardId, 'item was not created')
      continue
    }
    if (opts.dryRun) {
      section.created('metas')
    } else {
      const meta = followUpResults.get(`trello:meta:${item.cardId}`)
      if (meta?.ok) section.created('metas')
      else
        section.failed(
          'metas',
          item.cardId,
          meta && !meta.ok ? meta.error : 'no result',
        )
    }
    let itemOk = true
    if (!opts.dryRun && item.archive) {
      const archived = followUpResults.get(`trello:${item.cardId}:archive`)
      if (!archived?.ok) {
        itemOk = false
        section.failed(
          kind,
          item.cardId,
          `archive failed: ${archived && !archived.ok ? archived.error : 'no result'}`,
        )
      }
    }
    if (itemOk) section.created(kind)
    if (!opts.dryRun && item.complete) {
      const completed = followUpResults.get(`trello:${item.cardId}:complete`)
      if (!completed?.ok)
        report.errors.push(`complete flag failed on ${key} (${item.cardId})`)
    }
    for (const comment of item.comments) {
      if (opts.dryRun) {
        section.created('comments')
        continue
      }
      const result = followUpResults.get(comment.opId)
      if (result?.ok) section.created('comments')
      else
        section.failed(
          'comments',
          comment.opId,
          result && !result.ok ? result.error : 'no result',
        )
    }
    // Inline checklists ride on the create op.
    section.created('checklists', item.checklistCount)

    report.mappings[`trello:${item.cardId}`] = {
      key,
      predicted: opts.dryRun || undefined,
      board: board.key,
      list: item.listName,
      short_link: item.shortLink,
      created_at: item.createdAt,
    }
  }

  await runAttachments(board, keyByCard, client, opts, section)
}

async function runAttachments(
  board: ITrelloBoardPlan,
  keyByCard: Map<string, string>,
  client: ActaClient,
  opts: ITrelloRunOptions,
  section: ReturnType<ImportReport['section']>,
): Promise<void> {
  const withAttachments = board.items.filter((i) => i.attachments.length > 0)
  if (withAttachments.length === 0) return

  // The attachments endpoint has no op_id, so idempotency comes from reading
  // what the item already has and skipping matches.
  const existing = opts.dryRun
    ? new Map<string, { filename: string; url: string | null }[]>()
    : await client.itemAttachments(
        withAttachments
          .map((i) => keyByCard.get(i.cardId))
          .filter((k): k is string => k !== undefined),
      )

  for (const item of withAttachments) {
    const key = keyByCard.get(item.cardId)
    if (!key) {
      section.skipped(
        'attachments',
        item.cardId,
        'item was not created',
        item.attachments.length,
      )
      continue
    }
    const present = existing.get(key) ?? []
    for (const att of item.attachments) {
      if (
        present.some((p) => p.url === att.url || p.filename === att.filename)
      ) {
        section.created('attachments') // already there from a previous run
        continue
      }
      if (!att.upload) {
        if (opts.dryRun) {
          section.created('attachments')
          continue
        }
        try {
          await client.addAttachment({
            item: key,
            filename: att.filename,
            url: att.url,
          })
          section.created('attachments')
        } catch (err) {
          section.failed('attachments', att.trelloId, String(err))
        }
        continue
      }
      // File uploads need Trello credentials and fit under the inline cap.
      if (!opts.downloadAttachment) {
        section.skipped(
          'attachments',
          att.trelloId,
          `file attachment ${att.filename} skipped (no TRELLO_KEY/TRELLO_TOKEN)`,
        )
        continue
      }
      if (att.bytes !== null && att.bytes > INLINE_ATTACHMENT_MAX) {
        section.skipped(
          'attachments',
          att.trelloId,
          `file attachment ${att.filename} skipped (${att.bytes} bytes > 1 MB)`,
        )
        continue
      }
      if (opts.dryRun) {
        section.created('attachments')
        continue
      }
      const downloaded = await opts.downloadAttachment(att)
      if (!downloaded) {
        section.skipped(
          'attachments',
          att.trelloId,
          `download failed for ${att.filename}`,
        )
        continue
      }
      if (downloaded.bytes.byteLength > INLINE_ATTACHMENT_MAX) {
        section.skipped(
          'attachments',
          att.trelloId,
          `file attachment ${att.filename} skipped (larger than 1 MB)`,
        )
        continue
      }
      try {
        await client.addAttachment({
          item: key,
          filename: att.filename,
          mime: downloaded.mime ?? att.mime ?? undefined,
          content_base64: Buffer.from(downloaded.bytes).toString('base64'),
        })
        section.created('attachments')
      } catch (err) {
        section.failed('attachments', att.trelloId, String(err))
      }
    }
  }
}

export async function runTrelloImport(
  plan: ITrelloPlan,
  client: ActaClient,
  report: ImportReport,
  opts: ITrelloRunOptions,
): Promise<void> {
  // Boards and lists first: board-scoped label groups and item creates both
  // reference them.
  for (const board of plan.boards) {
    await runBoardStructure(board, client, report, opts)
  }
  if (plan.labelOps.length > 0) {
    const section = report.section('workspace labels')
    section.source('label_ops', plan.labelOps.length)
    if (opts.dryRun) {
      section.created('label_ops', plan.labelOps.length)
    } else {
      const results = await client.writeLabels(plan.labelOps)
      for (const result of results) {
        if (result.ok) section.created('label_ops')
        else section.failed('label_ops', result.op_id, result.error)
      }
    }
  }
  for (const board of plan.boards) {
    await runBoardItems(board, client, report, opts)
  }
}

// ---------------------------------------------------------------------------
// --fix-comments: retrofit provenance onto previously imported comments
// ---------------------------------------------------------------------------

const IMPORTED_COMMENT_RE =
  /^\*\*\[imported\]\*\* ([\s\S]+?) · (\S+):\n\n([\s\S]*)$/

export interface IParsedImportedComment {
  author: string
  date: string
  rest: string
}

/** Parses the `**[imported]** {author} · {date}:\n\n{rest}` body prefix. */
export function parseImportedComment(
  body: string,
): IParsedImportedComment | null {
  const match = IMPORTED_COMMENT_RE.exec(body)
  if (!match) return null
  return { author: match[1], date: match[2], rest: match[3] }
}

/**
 * Rewrites comments that still carry the `**[imported]** ...` body prefix
 * from the pre-provenance import: the prefix moves into imported_meta and the
 * body shrinks to the original text. Comments already carrying imported
 * metadata are skipped, so re-runs converge.
 */
export async function runTrelloFixComments(
  plan: ITrelloPlan,
  client: ActaClient,
  report: ImportReport,
  opts: { dryRun: boolean },
): Promise<void> {
  for (const board of plan.boards) {
    const withComments = board.items.filter((i) => i.comments.length > 0)
    if (withComments.length === 0) continue
    const section = report.section(`fix comments ${board.key} (${board.name})`)
    if (opts.dryRun) {
      const n = withComments.reduce((sum, i) => sum + i.comments.length, 0)
      section.note(
        `dry-run: would examine ${n} imported comment(s) on ${withComments.length} item(s)`,
      )
      continue
    }

    // Replaying each create op is the sanctioned way to resolve a card id to
    // its Acta key (op_id dedupe returns the original result).
    const createResults = resultsById(
      await client.writeItems(withComments.map((i) => i.create)),
    )
    const keyByCard = new Map<string, string>()
    for (const item of withComments) {
      const result = createResults.get(item.create.op_id)
      if (result?.ok && result.key) {
        keyByCard.set(item.cardId, result.key)
      } else {
        section.source('comments', item.comments.length)
        section.skipped(
          'comments',
          item.cardId,
          'item was not created',
          item.comments.length,
        )
      }
    }

    const commentsByKey = await client.itemComments([...keyByCard.values()])
    const updates: TItemOp[] = []
    for (const key of keyByCard.values()) {
      for (const comment of commentsByKey.get(key) ?? []) {
        if (comment.imported) {
          section.source('comments')
          section.skipped(
            'comments',
            comment.id,
            'already carries imported metadata',
          )
          continue
        }
        const parsed = parseImportedComment(comment.body)
        if (!parsed) continue // not an imported comment; leave untouched
        section.source('comments')
        if (parsed.rest.length === 0) {
          section.skipped(
            'comments',
            comment.id,
            'imported comment is empty after the prefix',
          )
          continue
        }
        updates.push({
          op: 'comment_update',
          op_id: `trello:fixcmt:${comment.id}`,
          key,
          comment_id: comment.id,
          body: parsed.rest,
          imported_meta: {
            source: 'trello',
            author: parsed.author,
            created_at: parsed.date,
          },
        })
      }
    }

    const results = resultsById(await client.writeItems(updates))
    for (const update of updates) {
      const result = results.get(update.op_id)
      if (result?.ok) section.created('comments')
      else
        section.failed(
          'comments',
          update.op_id,
          result && !result.ok ? result.error : 'no result',
        )
    }
  }
}
