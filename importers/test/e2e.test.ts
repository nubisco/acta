/**
 * End-to-end importer tests against an in-process Acta server (no network):
 * the ActaClient's fetch is wired to app.request, then both importers run
 * for real, twice, to prove the op_id idempotency contract.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from '../../server/src/app'
import { createToken } from '../../server/src/core/auth'
import type { ICtx } from '../../server/src/core/ctx'
import { openDb, type BunSqliteDriver } from '../../server/src/db'
import { docGet, itemGet } from '../../server/src/services/reads'
import { ActaClient } from '../src/lib/client'
import { ImportReport } from '../src/lib/report'
import { normalizePage } from '../src/confluence/model'
import { planConfluenceImport } from '../src/confluence/plan'
import { runConfluenceImport } from '../src/confluence/run'
import { zTrelloBoard } from '../src/trello/model'
import { planTrelloImport, type ITrelloPlanOptions } from '../src/trello/plan'
import { runTrelloImport } from '../src/trello/run'

let db: BunSqliteDriver
let app: ReturnType<typeof createApp>
let ctx: ICtx
let client: ActaClient

function fixtureBoard(name: string) {
  return zTrelloBoard.parse(
    JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')),
  )
}

function fixturePages() {
  return (
    JSON.parse(
      readFileSync(
        join(import.meta.dir, 'fixtures', 'confluence-pages.json'),
        'utf8',
      ),
    ) as unknown[]
  ).map(normalizePage)
}

beforeEach(async () => {
  db = openDb(':memory:')
  app = createApp(db, {
    bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
    dataDir: `/tmp/acta-importer-test-${Math.random().toString(36).slice(2)}`,
  })
  const workspaceId = db.query<{ id: string }>('SELECT id FROM workspace')[0].id
  const admin = db.query<{ id: string }>(
    "SELECT id FROM actor WHERE handle = 'jose'",
  )[0]
  ctx = {
    db,
    workspaceId,
    actor: {
      id: admin.id,
      kind: 'human',
      handle: 'jose',
      role: 'admin',
      scopes: ['read', 'write', 'admin'],
    },
  }
  const token = await createToken(db, workspaceId, admin.id, 'agent', [
    'read',
    'write',
    'admin',
  ])
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    app.request(input as string, init)) as typeof fetch
  client = new ActaClient({ baseUrl: 'http://acta.test', token, fetchImpl })
})

async function trelloOpts(): Promise<ITrelloPlanOptions> {
  const overview = await client.overview()
  return {
    memberMap: { josesilva: 'jose' },
    existingWorkspaceLabels: new Set(
      overview.labels
        .filter((l) => l.board_key === null)
        .map((l) => l.name.toLowerCase()),
    ),
    existingBoardKeys: new Set(overview.boards.map((b) => b.key)),
    existingActorHandles: new Set(overview.actors.map((a) => a.handle)),
    doneAsArchived: new Set(['SW']),
  }
}

async function importTrello(): Promise<ImportReport> {
  const plan = planTrelloImport(
    [
      { board: fixtureBoard('trello-stagewright.json'), forcedKey: 'SW' },
      { board: fixtureBoard('trello-labs.json'), forcedKey: 'LABS' },
    ],
    await trelloOpts(),
  )
  const report = new ImportReport('trello-import', false)
  await runTrelloImport(plan, client, report, { dryRun: false })
  return report
}

async function importConfluence(): Promise<ImportReport> {
  const existingSlugs = new Set((await client.docTree()).map((d) => d.slug))
  const plan = planConfluenceImport(fixturePages(), {
    root: 'manual',
    existingSlugs,
  })
  const report = new ImportReport('confluence-import', false)
  await runConfluenceImport(plan, client, report, { dryRun: false })
  return report
}

describe('trello import end to end', () => {
  it('imports boards, lists, items, labels, checklists, comments, flags and attachments', async () => {
    const report = await importTrello()
    if (!report.ok()) report.print()
    expect(report.ok()).toBe(true)

    const overview = await client.overview()
    const sw = overview.boards.find((b) => b.key === 'SW')!
    expect(sw.lists.map((l) => l.name)).toEqual([
      'Backlog',
      'In Progress',
      'Blocked / Waiting',
      'Review / Testing',
      'Done',
      'Old stuff',
    ])
    expect(overview.boards.some((b) => b.key === 'LABS')).toBe(true)

    // Key mapping recorded from op results, source ids in the report.
    const mapping = report.mappings as Record<string, { key: string }>
    const submissionKey = mapping['trello:68851e80000000000000c001'].key
    const submission = itemGet(ctx, { keys: [submissionKey] }).items[0] as {
      list: string
      description: string
      labels?: string[]
      assignees?: string[]
    }
    expect(submission.list).toBe('Blocked / Waiting')
    expect(submission.description).toContain('UPDATE: resubmitted')
    expect(submission.labels).toEqual(['Bug'])
    expect(submission.assignees).toEqual(['jose'])

    const epicKey = mapping['trello:68851e80000000000000c003'].key
    const epic = itemGet(ctx, { keys: [epicKey] }).items[0] as {
      checklists?: { name: string; items: { text: string; done: boolean }[] }[]
      comments?: { body: string }[]
    }
    expect(epic.checklists!.map((c) => c.name)).toEqual(['Phase 0', 'Phase 1'])
    expect(epic.checklists![1].items).toEqual([
      { text: 'Design', done: true },
      { text: 'Build', done: false },
    ])
    expect(epic.comments).toHaveLength(2)
    expect(epic.comments![0].body).toStartWith(
      '**[imported]** Ivan Marjanovic · 2026-08-28T09:00:00.000Z:',
    )

    const crashKey = mapping['trello:68851e80000000000000c002'].key
    const crash = itemGet(ctx, { keys: [crashKey] }).items[0] as {
      due?: number
      done?: boolean
      labels?: string[]
    }
    expect(crash.due).toBe(Date.parse('2026-09-10T09:00:00.000Z'))
    expect(crash.done).toBe(true)
    expect(crash.labels).toEqual(['color-green'])

    // closed card archived; done-as-archived applied on SW but not LABS.
    const oldKey = mapping['trello:68851e80000000000000c005'].key
    expect(
      (itemGet(ctx, { keys: [oldKey] }).items[0] as { archived?: boolean })
        .archived,
    ).toBe(true)
    const shipKey = mapping['trello:68851e80000000000000c004'].key
    expect(
      (itemGet(ctx, { keys: [shipKey] }).items[0] as { archived?: boolean })
        .archived,
    ).toBe(true)
    const gradKey = mapping['trello:68851e80000000000000c102'].key
    expect(
      (itemGet(ctx, { keys: [gradKey] }).items[0] as { archived?: boolean })
        .archived,
    ).toBeUndefined()

    // url attachment added; file upload skipped (no Trello credentials).
    const supportKey = mapping['trello:68851e80000000000000c006'].key
    const support = itemGet(ctx, { keys: [supportKey] }).items[0] as {
      attachments?: { filename: string; url: string | null }[]
    }
    expect(support.attachments).toHaveLength(1)
    expect(support.attachments![0].url).toBe(
      'https://docs.google.com/document/d/abc123',
    )

    // Named labels merged once into the workspace Type group; color label is
    // board-scoped.
    const infra = overview.labels.filter((l) => l.name === 'Infra')
    expect(infra).toHaveLength(1)
    expect(infra[0].board_key).toBeNull()
    expect(infra[0].group_name).toBe('Type')
    const colorGreen = overview.labels.find((l) => l.name === 'color-green')!
    expect(colorGreen.board_key).toBe('SW')
    expect(overview.labels.filter((l) => l.name === 'Bug')).toHaveLength(1)
  })

  it('is idempotent when re-run (same op ids, no duplicates)', async () => {
    const first = await importTrello()
    expect(first.ok()).toBe(true)
    const countItems = () =>
      db.query<{ n: number }>('SELECT COUNT(*) AS n FROM item')[0].n
    const countComments = () =>
      db.query<{ n: number }>('SELECT COUNT(*) AS n FROM comment')[0].n
    const countAttachments = () =>
      db.query<{ n: number }>('SELECT COUNT(*) AS n FROM attachment')[0].n
    const countLabels = () =>
      db.query<{ n: number }>('SELECT COUNT(*) AS n FROM label')[0].n
    const before = {
      items: countItems(),
      comments: countComments(),
      attachments: countAttachments(),
      labels: countLabels(),
    }
    expect(before.items).toBe(9)

    const second = await importTrello()
    if (!second.ok()) second.print()
    expect(second.ok()).toBe(true)
    expect(countItems()).toBe(before.items)
    expect(countComments()).toBe(before.comments)
    expect(countAttachments()).toBe(before.attachments)
    expect(countLabels()).toBe(before.labels)
  })

  it('dry-run performs no writes', async () => {
    const throwingClient = new ActaClient({
      baseUrl: 'http://acta.test',
      token: 'x',
      fetchImpl: (() => {
        throw new Error('dry-run must not touch the server')
      }) as unknown as typeof fetch,
    })
    const plan = planTrelloImport(
      [{ board: fixtureBoard('trello-stagewright.json'), forcedKey: 'SW' }],
      {
        memberMap: { josesilva: 'jose' },
        existingWorkspaceLabels: new Set(['bug']),
        existingBoardKeys: new Set(),
        doneAsArchived: false,
      },
    )
    const report = new ImportReport('trello-import', true)
    await runTrelloImport(plan, throwingClient, report, { dryRun: true })
    expect(report.ok()).toBe(true)
    expect(db.query<{ n: number }>('SELECT COUNT(*) AS n FROM item')[0].n).toBe(
      0,
    )
  })
})

describe('confluence import end to end', () => {
  it('builds the doc tree with converted bodies, layout and provenance report', async () => {
    // The Trello board link target must exist for the [[board:SW]] ref.
    await importTrello()
    const report = await importConfluence()
    if (!report.ok()) report.print()
    expect(report.ok()).toBe(true)

    const home = docGet(ctx, 'manual') as { title: string; body: string }
    expect(home.title).toBe('Nubisco Home')
    expect(home.body).toContain('> [!INFO] Read me')
    expect(home.body).toContain('[[doc:manual/the-nubisco-manual]]')

    const manual = docGet(ctx, 'manual/the-nubisco-manual') as { body: string }
    expect(manual.body).toContain(':::details Details inside')
    expect(manual.body).toContain('| Role | Owner |')
    expect(manual.body).toContain('- One\n  - Nested')

    const product = docGet(ctx, 'manual/the-nubisco-manual/stagewright') as {
      layout?: string
      body: string
    }
    expect(product.layout).toBe('wide')
    expect(product.body).toContain('[[board:SW]]')
    expect(product.body).toContain('```ts\nconst x = 1\n```')
    expect(product.body).toContain('Unmapped Confluence macro: toc')
    expect(report.unknownMacros.join(' ')).toContain('toc')

    const tree = await client.docTree()
    const depths = new Map(tree.map((d) => [d.slug, d.depth]))
    expect(depths.get('manual')).toBe(0)
    expect(depths.get('manual/the-nubisco-manual')).toBe(1)
    expect(depths.get('manual/the-nubisco-manual/stagewright')).toBe(2)

    // Personal space page skipped with a reason, provenance in the mappings.
    const skipped = report.sections.find((s) => s.name === 'skipped pages')!
    expect(skipped.skips[0].reason).toContain('personal space')
    const mapping = report.mappings['confluence:100'] as {
      imported_author: string
      confluence_version_count: number
    }
    expect(mapping.imported_author).toBe('José Silva')
    expect(mapping.confluence_version_count).toBe(3)
  })

  it('is idempotent when re-run and keeps versions at 1', async () => {
    await importTrello()
    const first = await importConfluence()
    expect(first.ok()).toBe(true)
    const second = await importConfluence()
    if (!second.ok()) second.print()
    expect(second.ok()).toBe(true)
    expect(
      db.query<{ n: number }>('SELECT COUNT(*) AS n FROM document')[0].n,
    ).toBe(3)
    const revs = db.query<{ rev: number }>('SELECT rev FROM document')
    expect(revs.every((r) => r.rev === 1)).toBe(true)
  })
})
