/**
 * Home's "Next up": one ranked list, every card with the reasons it is there.
 * Asked for by Jose on 2026-10-09, because nobody could tell what to pick up
 * next. Each signal is checked on its own, so a change to a weight shows up
 * as exactly one failing case.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import { goalWrite } from '../src/services/goals'
import { nextUp, scoreCard, WEIGHTS } from '../src/services/nextUp'
import type { ICtx } from '../src/core/ctx'

const DAY = 86_400_000
const NOW = new Date('2026-10-09T10:00:00Z').getTime()

const card = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  key: 'ST-1',
  title: 'Card',
  space: 'ST',
  space_key: 'ST',
  list: 'To Do',
  role: 'backlog',
  due: null as number | null,
  priority: null as string | null,
  is_milestone: 0,
  updated_at: NOW,
  mine: 1,
  ...over,
})
const score = (
  over: Record<string, unknown>,
  facts: Record<string, unknown> = {},
) =>
  scoreCard(card(over) as never, { today: NOW, blocks: [], ...facts } as never)
const labels = (r: { reasons: { label: string }[] }) =>
  r.reasons.map((x) => x.label)

describe('each signal', () => {
  it('overdue grows by the day, up to a cap', () => {
    const two = score({ due: NOW - 2 * DAY })
    expect(labels(two)).toEqual(['Overdue 2 days'])
    expect(score({ due: NOW - 60 * DAY }).score).toBe(WEIGHTS.overdueMax)
  })

  it('due soon, by how soon', () => {
    expect(labels(score({ due: NOW + 2 * 3600_000 }))).toEqual(['Due today'])
    expect(labels(score({ due: NOW + DAY }))).toEqual(['Due tomorrow'])
    expect(labels(score({ due: NOW + 5 * DAY }))).toEqual(['Due in 5 days'])
    expect(score({ due: NOW + 20 * DAY }).reasons).toEqual([])
  })

  it('priority, a mention, and what it blocks', () => {
    expect(labels(score({ priority: 'urgent' }))).toEqual(['Urgent'])
    expect(labels(score({}, { mentionedBy: 'Ana' }))).toEqual([
      'Ana mentioned you',
    ])
    const blocking = score(
      {},
      {
        blocks: [
          { key: 'CM-12', overdue: true },
          { key: 'CM-13', overdue: false },
        ],
      },
    )
    expect(labels(blocking)).toEqual(['Blocks CM-12 and 1 more'])
    expect(blocking.score).toBe(
      WEIGHTS.blocksBase + WEIGHTS.blocksPerExtra + WEIGHTS.blocksOverdue,
    )
  })

  it('a goal in trouble, being in progress, and going stale', () => {
    expect(
      labels(
        score({}, { goal: { key: 'G-4', status: 'at_risk', overdue: false } }),
      ),
    ).toEqual(['G-4 at risk'])
    expect(
      labels(score({ role: 'active', updated_at: NOW - 9 * DAY })),
    ).toEqual(['In progress', 'Untouched 9 days'])
  })

  it('says when nobody is on a card it surfaces', () => {
    expect(labels(score({ mine: 0, due: NOW + DAY }))).toContain('Nobody on it')
  })
})

describe('the list', () => {
  let ctx: ICtx
  let db: BunSqliteDriver

  beforeEach(async () => {
    db = await openDb(':memory:')
    const workspaceId = await bootstrapWorkspace(db, {
      adminEmail: 'jose@nubisco.io',
      adminHandle: 'jose',
    })
    const me = (
      await db.query<{ id: string }>(
        "SELECT id FROM actor WHERE handle = 'jose'",
      )
    )[0].id
    ctx = {
      db,
      workspaceId,
      actor: {
        id: me,
        kind: 'human',
        handle: 'jose',
        role: 'admin',
        scopes: ['read', 'write', 'admin'],
      },
    }
    await spaceWrite(ctx, [
      { op: 'create', op_id: 's', key: 'ST', name: 'ST', template: 'kanban6' },
    ] as never)
    const today = Date.now()
    await itemWrite(
      ctx,
      [
        {
          op: 'create',
          op_id: 'a',
          list: 'To Do',
          title: 'Quiet',
          assignees: ['jose'],
        },
        {
          op: 'create',
          op_id: 'b',
          list: 'To Do',
          title: 'Late',
          assignees: ['jose'],
          due: today - 3 * DAY,
        },
        {
          op: 'create',
          op_id: 'c',
          list: 'In Progress',
          title: 'Going',
          assignees: ['jose'],
        },
        {
          op: 'create',
          op_id: 'd',
          list: 'To Do',
          title: 'Stuck',
          assignees: ['jose'],
        },
        {
          op: 'create',
          op_id: 'e',
          list: 'Done',
          title: 'Finished',
          assignees: ['jose'],
        },
        { op: 'prioritize', op_id: 'p', key: 'ST-3', priority: 'urgent' },
        { op: 'depends_on', op_id: 'dep', key: 'ST-4', blocker: 'ST-1' },
      ] as never,
      'ST',
    )
  })

  it('ranks by score, explains each, and leaves finished work out', async () => {
    const got = await nextUp(ctx)
    expect(got.items.map((i) => i.key)).toEqual(['ST-2', 'ST-3', 'ST-1'])
    expect(got.items[0].reasons[0].label).toMatch(/^Overdue/)
    expect(got.items[1].reasons.map((r) => r.label)).toEqual([
      'Urgent',
      'In progress',
    ])
    expect(got.items.map((i) => i.key)).not.toContain('ST-5')
  })

  it('keeps work that waits on something else apart, saying what', async () => {
    const got = await nextUp(ctx)
    expect(got.waiting.map((w) => [w.key, w.waiting_on])).toEqual([
      ['ST-4', 'ST-1'],
    ])
    expect(got.counts.overdue).toBe(1)
    expect(got.counts.waiting).toBe(1)
  })

  it('lifts a card that serves a goal in trouble', async () => {
    await goalWrite(ctx, [
      {
        op: 'create',
        op_id: 'g',
        title: 'Ship',
        status: 'off_track',
        items: ['ST-1'],
      },
    ] as never)
    const got = await nextUp(ctx)
    const quiet = got.items.find((i) => i.key === 'ST-1')!
    expect(quiet.reasons.map((r) => r.label)).toContain('G-1 off track')
  })
})
