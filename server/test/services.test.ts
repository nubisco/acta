import { beforeEach, describe, expect, it } from 'bun:test'
import { contentHash, sectionMap } from '@nubisco/acta-shared'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import type { ICtx } from '../src/core/ctx'
import { openDb, type BunSqliteDriver } from '../src/db'
import { boardWrite } from '../src/services/boards'
import { docWrite } from '../src/services/docs'
import { itemWrite } from '../src/services/items'
import { labelWrite } from '../src/services/labels'
import {
  activityQuery,
  boardGet,
  docGet,
  docTree,
  itemGet,
  search,
  workspaceOverview,
} from '../src/services/reads'

let db: BunSqliteDriver
let ctx: ICtx

beforeEach(() => {
  db = openDb(':memory:')
  const workspaceId = bootstrapWorkspace(db, {
    adminEmail: 'a@b.c',
    adminHandle: 'jose',
  })
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
})

function seedBoard(): void {
  const results = boardWrite(ctx, [
    {
      op: 'create',
      op_id: 'b1',
      key: 'SW',
      name: 'Stagewright',
      template: 'kanban6',
    },
  ])
  expect(results[0].ok).toBe(true)
}

describe('boards', () => {
  it('creates a kanban6 board', () => {
    seedBoard()
    const overview = workspaceOverview(ctx)
    const board = overview.boards.find((b) => b.key === 'SW')
    expect(board?.lists.map((l) => l.name)).toEqual([
      'Backlog',
      'To Do',
      'In Progress',
      'Blocked / Waiting',
      'Review / Testing',
      'Done',
    ])
  })

  it('is idempotent per op_id', () => {
    seedBoard()
    const replay = boardWrite(ctx, [
      {
        op: 'create',
        op_id: 'b1',
        key: 'SW',
        name: 'Stagewright',
        template: 'kanban6',
      },
    ])
    expect(replay[0].ok).toBe(true)
    const dup = boardWrite(ctx, [
      {
        op: 'create',
        op_id: 'b2',
        key: 'SW',
        name: 'Again',
        template: 'kanban6',
      },
    ])
    expect(dup[0].ok).toBe(false)
  })
})

describe('items', () => {
  beforeEach(seedBoard)

  it('creates, moves, labels, comments, checks off in one batch', () => {
    const results = itemWrite(
      ctx,
      [
        {
          op: 'create',
          op_id: 'i1',
          list: 'To Do',
          title: 'Fix the tuner',
          description: 'See [[doc:manual/vision]].',
          labels: ['Bug'],
          checklists: [
            {
              name: 'Plan',
              items: [
                { text: 'a', done: false },
                { text: 'b', done: false },
              ],
            },
          ],
        },
        { op: 'move', op_id: 'i2', key: 'SW-1', list: 'In Progress' },
        { op: 'comment', op_id: 'i3', key: 'SW-1', body: 'On it.' },
        {
          op: 'checklist_set',
          op_id: 'i4',
          key: 'SW-1',
          checklist: 'Plan',
          check: ['a'],
        },
        { op: 'complete', op_id: 'i5', key: 'SW-1' },
      ],
      'SW',
    )
    expect(results.every((r) => r.ok)).toBe(true)

    const got = itemGet(ctx, { keys: ['SW-1'] })
    const item = got.items[0] as Record<string, any>
    expect(item.list).toBe('In Progress')
    expect(item.labels).toEqual(['Bug'])
    expect(item.done).toBe(true)
    expect(item.comments).toHaveLength(1)
    expect(item.checklists[0].items).toEqual([
      { text: 'a', done: true },
      { text: 'b', done: false },
    ])
    expect(item.links.out).toEqual([
      { ref_type: 'doc', target: 'manual/vision' },
    ])
  })

  it('enforces if_rev and reports current rev on conflict', () => {
    itemWrite(
      ctx,
      [{ op: 'create', op_id: 'i1', list: 'To Do', title: 'X' }],
      'SW',
    )
    const first = itemWrite(ctx, [
      { op: 'update', op_id: 'i2', key: 'SW-1', if_rev: 1, title: 'Y' },
    ])
    expect(first[0].ok).toBe(true)
    const stale = itemWrite(ctx, [
      { op: 'update', op_id: 'i3', key: 'SW-1', if_rev: 1, title: 'Z' },
    ])
    expect(stale[0].ok).toBe(false)
    expect((stale[0] as { current?: { rev: number } }).current?.rev).toBe(2)
  })

  it('replays ops idempotently', () => {
    const ops = [
      { op: 'create' as const, op_id: 'same', list: 'To Do', title: 'Once' },
    ]
    const a = itemWrite(ctx, ops, 'SW')
    const b = itemWrite(ctx, ops, 'SW')
    expect(a[0]).toEqual(b[0])
    expect(
      boardGet(ctx, {
        board: 'SW',
        state: 'open',
        detail: 'compact',
        limit: 100,
      }).items,
    ).toHaveLength(1)
  })

  it('keeps the old key as an alias across board moves', () => {
    boardWrite(ctx, [
      {
        op: 'create',
        op_id: 'b2',
        key: 'SUP',
        name: 'Support',
        template: 'kanban6',
      },
    ])
    itemWrite(
      ctx,
      [{ op: 'create', op_id: 'i1', list: 'To Do', title: 'Graduate me' }],
      'SW',
    )
    const moved = itemWrite(ctx, [
      { op: 'move', op_id: 'i2', key: 'SW-1', board: 'SUP', list: 'Backlog' },
    ])
    expect(moved[0].ok).toBe(true)
    expect((moved[0] as { key: string }).key).toBe('SUP-1')
    const viaAlias = itemGet(ctx, { keys: ['SW-1'] })
    expect((viaAlias.items[0] as { key: string }).key).toBe('SUP-1')
  })

  it('filters board_get by list, label, and state', () => {
    labelWrite(ctx, [
      { op: 'group_create', op_id: 'l1', name: 'Components', board: 'SW' },
      {
        op: 'label_create',
        op_id: 'l2',
        group: 'Components',
        name: 'engine',
        color: 'blue',
      },
    ])
    itemWrite(
      ctx,
      [
        {
          op: 'create',
          op_id: 'i1',
          list: 'To Do',
          title: 'A',
          labels: ['engine'],
        },
        { op: 'create', op_id: 'i2', list: 'To Do', title: 'B' },
        { op: 'create', op_id: 'i3', list: 'Done', title: 'C' },
        { op: 'archive', op_id: 'i4', key: 'SW-3' },
      ],
      'SW',
    )
    expect(
      boardGet(ctx, {
        board: 'SW',
        state: 'open',
        detail: 'compact',
        limit: 100,
      }).items,
    ).toHaveLength(2)
    expect(
      boardGet(ctx, {
        board: 'SW',
        state: 'open',
        label: 'engine',
        detail: 'compact',
        limit: 100,
      }).items,
    ).toHaveLength(1)
    expect(
      boardGet(ctx, {
        board: 'SW',
        state: 'archived',
        detail: 'compact',
        limit: 100,
      }).items,
    ).toHaveLength(1)
  })
})

describe('labels', () => {
  beforeEach(seedBoard)

  it('merges labels and reassigns items', () => {
    labelWrite(ctx, [
      { op: 'group_create', op_id: 'g1', name: 'Extra', board: 'SW' },
      {
        op: 'label_create',
        op_id: 'g2',
        group: 'Extra',
        name: 'bugz',
        color: 'red',
      },
    ])
    itemWrite(
      ctx,
      [
        {
          op: 'create',
          op_id: 'i1',
          list: 'To Do',
          title: 'A',
          labels: ['bugz'],
        },
      ],
      'SW',
    )
    const merged = labelWrite(ctx, [
      { op: 'label_merge', op_id: 'm1', from: 'bugz', into: 'Bug' },
    ])
    expect(merged[0].ok).toBe(true)
    const item = itemGet(ctx, { keys: ['SW-1'] }).items[0] as {
      labels: string[]
    }
    expect(item.labels).toEqual(['Bug'])
  })
})

describe('docs', () => {
  it('creates a tree, patches sections, guards conflicts', () => {
    const created = docWrite(ctx, [
      {
        op: 'create',
        op_id: 'd1',
        slug: 'manual',
        title: 'Manual',
        body: '# Intro\n\nHello.\n\n## Vision\n\nOld vision.',
        layout: 'default',
        tags: [],
      },
      {
        op: 'create',
        op_id: 'd2',
        slug: 'manual/vision',
        title: 'Vision',
        parent: 'manual',
        body: 'Long form.',
        layout: 'default',
        tags: [],
      },
    ])
    expect(created.every((r) => r.ok)).toBe(true)

    const tree = docTree(ctx)
    expect(tree.docs).toEqual([
      expect.objectContaining({ slug: 'manual', depth: 0 }),
      expect.objectContaining({ slug: 'manual/vision', depth: 1 }),
    ])

    const doc = docGet(ctx, 'manual', { include: ['sections'] }) as {
      sections: { slug: string; hash: string }[]
      rev: number
    }
    const vision = doc.sections.find((s) => s.slug === 'vision')
    expect(vision).toBeDefined()

    const patched = docWrite(ctx, [
      {
        op: 'patch_section',
        op_id: 'd3',
        ref: 'manual',
        section: 'vision',
        if_hash: vision!.hash,
        body: '## Vision\n\nNew vision.',
        mode: 'replace',
      },
    ])
    expect(patched[0].ok).toBe(true)

    // Same-section edit with the stale hash conflicts.
    const conflict = docWrite(ctx, [
      {
        op: 'patch_section',
        op_id: 'd4',
        ref: 'manual',
        section: 'vision',
        if_hash: vision!.hash,
        body: '## Vision\n\nRacing edit.',
        mode: 'replace',
      },
    ])
    expect(conflict[0].ok).toBe(false)

    const after = docGet(ctx, 'manual') as { body: string; rev: number }
    expect(after.body).toContain('New vision.')
    expect(after.body).toContain('Hello.')
    expect(after.rev).toBe(2)

    // Version history intact.
    const versions = docGet(ctx, 'manual', { include: ['versions'] }) as {
      versions: { rev: number }[]
    }
    expect(versions.versions.map((v) => v.rev)).toEqual([2, 1])
  })

  it('appends without needing a read', () => {
    docWrite(ctx, [
      {
        op: 'create',
        op_id: 'd1',
        slug: 'log',
        title: 'Decision log',
        body: '# Log',
        layout: 'default',
        tags: [],
      },
      {
        op: 'append',
        op_id: 'd2',
        ref: 'log',
        body: '## 2026-09-04\n\nChose Acta.',
      },
    ])
    const doc = docGet(ctx, 'log') as { body: string }
    expect(doc.body).toBe('# Log\n\n## 2026-09-04\n\nChose Acta.')
    const sections = sectionMap(doc.body)
    expect(contentHash(doc.body)).toBe(contentHash(doc.body))
    expect(sections).toHaveLength(2)
  })
})

describe('search and activity', () => {
  beforeEach(seedBoard)

  it('finds items, docs, and comments', () => {
    itemWrite(
      ctx,
      [
        {
          op: 'create',
          op_id: 'i1',
          list: 'To Do',
          title: 'Fix latency',
          description: 'audio glitch on start',
        },
        {
          op: 'comment',
          op_id: 'i2',
          key: 'SW-1',
          body: 'root cause is the xruns counter',
        },
      ],
      'SW',
    )
    docWrite(ctx, [
      {
        op: 'create',
        op_id: 'd1',
        slug: 'notes',
        title: 'Notes',
        body: 'the xruns counter is documented here',
        layout: 'default',
        tags: [],
      },
    ])
    const items = search(ctx, { query: 'glitch', limit: 20 })
    expect(items.results[0]).toMatchObject({ type: 'item', ref: 'SW-1' })
    const both = search(ctx, { query: 'xruns', limit: 20 })
    expect(both.results.map((r) => r.type).sort()).toEqual(['comment', 'doc'])
  })

  it('records attribution and supports delta reads', () => {
    itemWrite(
      ctx,
      [{ op: 'create', op_id: 'i1', list: 'To Do', title: 'A' }],
      'SW',
    )
    const all = activityQuery(ctx, { limit: 50 })
    expect(all.events.some((e) => e.verb === 'item.created')).toBe(true)
    const cursorPoint = all.events[0].id
    itemWrite(
      ctx,
      [{ op: 'create', op_id: 'i2', list: 'To Do', title: 'B' }],
      'SW',
    )
    const delta = activityQuery(ctx, { since: cursorPoint, limit: 50 })
    expect(delta.events.every((e) => e.id > cursorPoint)).toBe(true)
    expect(delta.events.some((e) => e.summary.includes('SW-2'))).toBe(true)
    expect(delta.events[0].actor_kind).toBe('human')
  })
})
