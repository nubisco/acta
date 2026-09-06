import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zTrelloBoard, trelloIdToDate } from '../src/trello/model'
import {
  boardKeyFor,
  inferListRole,
  planTrelloImport,
  type ITrelloPlanOptions,
} from '../src/trello/plan'

const SEEDED = new Set([
  'bug',
  'feature',
  'engineering',
  'tech debt',
  'urgent',
  'docs',
  'marketing',
])

function fixture(name: string) {
  return zTrelloBoard.parse(
    JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')),
  )
}

function baseOpts(): ITrelloPlanOptions {
  return {
    memberMap: { josesilva: 'jose' },
    existingWorkspaceLabels: new Set(SEEDED),
    existingBoardKeys: new Set(),
    doneAsArchived: false,
  }
}

describe('boardKeyFor', () => {
  it('uses initials for multi-word names', () => {
    expect(boardKeyFor('Nubisco Labs', new Set())).toBe('NL')
    expect(boardKeyFor('Nubisco UI', new Set())).toBe('NU')
  })

  it('uses the first two letters for single words', () => {
    expect(boardKeyFor('Stagewright', new Set())).toBe('ST')
  })

  it('avoids collisions and stays within the key grammar', () => {
    const taken = new Set(['ST'])
    const key = boardKeyFor('Stagewright', taken)
    expect(key).toBe('ST2')
    expect(key).toMatch(/^[A-Z][A-Z0-9]{1,4}$/)
  })

  it('never starts with a digit', () => {
    expect(boardKeyFor('3d Printing', new Set())).toMatch(/^[A-Z]/)
  })
})

describe('inferListRole', () => {
  it('maps the house list names', () => {
    expect(inferListRole('Backlog')).toBe('backlog')
    expect(inferListRole('To Do')).toBe('backlog')
    expect(inferListRole('In Progress')).toBe('active')
    expect(inferListRole('Blocked / Waiting')).toBe('blocked')
    expect(inferListRole('Waiting on User')).toBe('blocked')
    expect(inferListRole('Review / Testing')).toBe('review')
    expect(inferListRole('Done')).toBe('done')
    expect(inferListRole('Published')).toBe('done')
    expect(inferListRole('Inbox')).toBe('inbox')
    expect(inferListRole('Email Marketing')).toBe('none')
  })
})

describe('planTrelloImport', () => {
  it('creates the board without a template and lists with roles in order', () => {
    const plan = planTrelloImport(
      [{ board: fixture('trello-stagewright.json') }],
      baseOpts(),
    )
    const board = plan.boards[0]
    expect(board.key).toBe('ST')
    const create = board.boardOps[0]
    expect(create.op).toBe('create')
    if (create.op === 'create') expect(create.template).toBe('none')
    const listOps = board.boardOps.filter((op) => op.op === 'list_create')
    expect(
      listOps.map((op) => (op.op === 'list_create' ? op.name : '')),
    ).toEqual([
      'Backlog',
      'In Progress',
      'Blocked / Waiting',
      'Review / Testing',
      'Done',
      'Old stuff',
    ])
    expect(
      listOps.map((op) => (op.op === 'list_create' ? op.role : '')),
    ).toEqual(['backlog', 'active', 'blocked', 'review', 'done', 'none'])
    expect(board.notes.join(' ')).toContain('was archived; imported as open')
  })

  it('honors a forced key and validates it', () => {
    const plan = planTrelloImport(
      [{ board: fixture('trello-stagewright.json'), forcedKey: 'SW' }],
      baseOpts(),
    )
    expect(plan.boards[0].key).toBe('SW')
    expect(() =>
      planTrelloImport(
        [{ board: fixture('trello-stagewright.json'), forcedKey: 'toolong' }],
        baseOpts(),
      ),
    ).toThrow()
  })

  it('orders item creates list by list, by position', () => {
    const plan = planTrelloImport(
      [{ board: fixture('trello-stagewright.json') }],
      baseOpts(),
    )
    const titles = plan.boards[0].items.map((i) => i.create.title)
    expect(titles).toEqual([
      '[SW] Fix crash on load',
      'Old idea',
      'CMS MCP epic',
      'Doodloop App Store submission',
      '[Support] Vasco - upload fails',
      'Ship v1.0',
      'Card in archived list',
    ])
    expect(plan.boards[0].items.map((i) => i.create.op_id)).toContain(
      'trello:68851e80000000000000c001',
    )
  })

  it('merges named labels into one workspace group and reuses seeded names', () => {
    const plan = planTrelloImport(
      [
        { board: fixture('trello-stagewright.json') },
        { board: fixture('trello-labs.json') },
      ],
      baseOpts(),
    )
    const creates = plan.labelOps.filter((op) => op.op === 'label_create')
    // Bug exists in the seeded taxonomy (no op); Infra appears on both boards
    // but is created exactly once, in the workspace Type group.
    const infra = creates.filter(
      (op) => op.op === 'label_create' && op.name === 'Infra',
    )
    expect(infra).toHaveLength(1)
    if (infra[0].op === 'label_create') expect(infra[0].group).toBe('Type')
    expect(
      creates.some((op) => op.op === 'label_create' && op.name === 'Bug'),
    ).toBe(false)
  })

  it('turns color-only labels into board-scoped color labels and drops empty ones', () => {
    const plan = planTrelloImport(
      [{ board: fixture('trello-stagewright.json') }],
      baseOpts(),
    )
    const group = plan.labelOps.find((op) => op.op === 'group_create')
    expect(group && group.op === 'group_create' ? group.name : '').toBe(
      'ST Colors',
    )
    expect(group && group.op === 'group_create' ? group.board : '').toBe('ST')
    const colorLabel = plan.labelOps.find(
      (op) => op.op === 'label_create' && op.name === 'color-green',
    )
    expect(colorLabel).toBeDefined()
    const crash = plan.boards[0].items.find(
      (i) => i.create.title === '[SW] Fix crash on load',
    )!
    expect(crash.create.labels).toEqual(['color-green'])
    expect(
      plan.boards[0].skips.some(
        (s) =>
          s.kind === 'labels' && s.reason.includes('neither name nor color'),
      ),
    ).toBe(true)
  })

  it('maps members via the member map and reports unknowns', () => {
    const plan = planTrelloImport(
      [{ board: fixture('trello-stagewright.json') }],
      baseOpts(),
    )
    const submission = plan.boards[0].items.find(
      (i) => i.create.title === 'Doodloop App Store submission',
    )!
    expect(submission.create.assignees).toEqual(['jose'])
    expect(
      plan.boards[0].skips.some(
        (s) => s.kind === 'assignees' && s.reason.includes('ghostuser'),
      ),
    ).toBe(true)
  })

  it('carries due dates, complete flags and recovers creation dates from ids', () => {
    const plan = planTrelloImport(
      [{ board: fixture('trello-stagewright.json') }],
      baseOpts(),
    )
    const crash = plan.boards[0].items.find(
      (i) => i.create.title === '[SW] Fix crash on load',
    )!
    expect(crash.create.due).toBe(Date.parse('2026-09-10T09:00:00.000Z'))
    expect(crash.complete).toBe(true)
    expect(crash.createdAt).toBe(
      trelloIdToDate('68851e80000000000000c002')!.toISOString(),
    )
  })

  it('sorts checklists and their items by position with done states', () => {
    const plan = planTrelloImport(
      [{ board: fixture('trello-stagewright.json') }],
      baseOpts(),
    )
    const epic = plan.boards[0].items.find(
      (i) => i.create.title === 'CMS MCP epic',
    )!
    expect(epic.create.checklists!.map((c) => c.name)).toEqual([
      'Phase 0',
      'Phase 1',
    ])
    expect(epic.create.checklists![1].items).toEqual([
      { text: 'Design', done: true },
      { text: 'Build', done: false },
    ])
  })

  it('carries trello provenance on the create op and the planned item', () => {
    const plan = planTrelloImport(
      [{ board: fixture('trello-stagewright.json') }],
      baseOpts(),
    )
    const crash = plan.boards[0].items.find(
      (i) => i.create.title === '[SW] Fix crash on load',
    )!
    expect(crash.create.imported_meta).toEqual({
      source: 'trello',
      url: `https://trello.com/c/${crash.shortLink}`,
    })
    // run re-sends the same object as set_meta.
    expect(crash.meta).toEqual(crash.create.imported_meta!)
  })

  it('imports comments with the provenance prefix, sorted by date', () => {
    const plan = planTrelloImport(
      [{ board: fixture('trello-stagewright.json') }],
      baseOpts(),
    )
    const epic = plan.boards[0].items.find(
      (i) => i.create.title === 'CMS MCP epic',
    )!
    expect(epic.comments).toHaveLength(2)
    expect(epic.comments[0].body).toStartWith(
      '**[imported]** Ivan Marjanovic · 2026-08-28T09:00:00.000Z:\n\n',
    )
    expect(epic.comments[0].opId).toBe(
      'trello:68851e80000000000000c003:comment:687f2a800000000000000t01',
    )
    expect(epic.comments[0].meta).toEqual({
      source: 'trello',
      author: 'Ivan Marjanovic',
      created_at: '2026-08-28T09:00:00.000Z',
    })
    // badges said 3 comments; only 2 were in the export actions.
    const skip = plan.boards[0].skips.find((s) => s.kind === 'comments')
    expect(skip?.n).toBe(1)
  })

  it('marks archived cards and, with the flag, cards in done lists', () => {
    const noFlag = planTrelloImport(
      [{ board: fixture('trello-stagewright.json') }],
      baseOpts(),
    )
    const oldIdea = noFlag.boards[0].items.find(
      (i) => i.create.title === 'Old idea',
    )!
    expect(oldIdea.archive).toBe(true)
    const ship = noFlag.boards[0].items.find(
      (i) => i.create.title === 'Ship v1.0',
    )!
    expect(ship.archive).toBe(false)

    const flagged = planTrelloImport(
      [{ board: fixture('trello-stagewright.json'), forcedKey: 'SW' }],
      { ...baseOpts(), doneAsArchived: new Set(['SW']) },
    )
    const shipFlagged = flagged.boards[0].items.find(
      (i) => i.create.title === 'Ship v1.0',
    )!
    expect(shipFlagged.archive).toBe(true)
    expect(flagged.boards[0].counts.items_archived).toBe(2)
    expect(flagged.boards[0].counts.items_open).toBe(5)
  })

  it('scopes --done-as-archived to the listed boards', () => {
    const plan = planTrelloImport(
      [
        { board: fixture('trello-stagewright.json'), forcedKey: 'SW' },
        { board: fixture('trello-labs.json'), forcedKey: 'LABS' },
      ],
      { ...baseOpts(), doneAsArchived: new Set(['SW']) },
    )
    const labsDone = plan.boards[1].items.find(
      (i) => i.create.title === 'Graduated project',
    )!
    expect(labsDone.archive).toBe(false)
  })

  it('plans url and upload attachments with source counts', () => {
    const plan = planTrelloImport(
      [{ board: fixture('trello-stagewright.json') }],
      baseOpts(),
    )
    const support = plan.boards[0].items.find((i) =>
      i.create.title.startsWith('[Support]'),
    )!
    expect(support.attachments).toHaveLength(2)
    expect(support.attachments[0].upload).toBe(false)
    expect(support.attachments[1].upload).toBe(true)
    expect(plan.boards[0].counts.attachments).toBe(2)
  })

  it('keeps reconciliation source counts per board', () => {
    const plan = planTrelloImport(
      [{ board: fixture('trello-stagewright.json') }],
      baseOpts(),
    )
    expect(plan.boards[0].counts).toEqual({
      lists: 6,
      items_open: 6,
      items_archived: 1,
      comments: 3,
      checklists: 2,
      attachments: 2,
    })
  })
})
