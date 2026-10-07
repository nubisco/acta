/**
 * Goals: what the work is for.
 *
 * Two signals that must never be confused. Status is a person's judgement,
 * posted through check-ins. Progress is measured from the cards that serve
 * the goal, on every read, so it cannot drift from them. Most of what can go
 * wrong is in the second one: which cards count, and counting each once.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { extractRefs, type TGoalOp } from '@nubisco/acta-shared'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import { goalGet, goalList, goalWrite } from '../src/services/goals'
import {
  activityQuery,
  itemGet,
  spaceGet,
  workspaceOverview,
} from '../src/services/reads'
import { notificationList } from '../src/services/notifications'
import type { ICtx } from '../src/core/ctx'

let db: BunSqliteDriver
let workspaceId: string
let jose: ICtx
let ivan: ICtx
let daniela: ICtx
let bot: ICtx

const DAY = 24 * 60 * 60 * 1000

function ctxFor(
  id: string,
  handle: string,
  kind: 'human' | 'agent' = 'human',
  role: 'admin' | 'member' = 'member',
): ICtx {
  return {
    db,
    workspaceId,
    actor: { id, kind, handle, role, scopes: ['read', 'write'] },
  }
}

beforeEach(async () => {
  db = await openDb(':memory:')
  workspaceId = await bootstrapWorkspace(db, {
    adminEmail: 'jose@nubisco.io',
    adminHandle: 'jose',
  })
  const joseId = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
  const add = async (handle: string, kind: 'human' | 'agent') => {
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'member', ?)`,
      [
        `act_${handle}`,
        workspaceId,
        kind,
        handle,
        handle,
        kind === 'human' ? `${handle}@nubisco.io` : null,
        Date.now(),
      ],
    )
    return `act_${handle}`
  }
  jose = ctxFor(joseId, 'jose', 'human', 'admin')
  ivan = ctxFor(await add('ivan', 'human'), 'ivan')
  daniela = ctxFor(await add('daniela', 'human'), 'daniela')
  bot = ctxFor(await add('claude', 'agent'), 'claude', 'agent')
  for (const [key, name] of [
    ['ST', 'Stagewright'],
    ['CMS', 'CMS'],
  ]) {
    await spaceWrite(jose, [
      { op: 'create', op_id: `s-${key}`, key, name, template: 'kanban6' },
    ])
  }
})

let opSeq = 0
async function goal(ctx: ICtx, ops: TGoalOp | TGoalOp[]) {
  const results = await goalWrite(ctx, Array.isArray(ops) ? ops : [ops])
  for (const r of results) if (!r.ok) throw new Error(r.error)
  return results
}

const op = () => `op-${(opSeq += 1)}`

async function card(
  space: string,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await itemWrite(
    jose,
    [{ op: 'create', op_id: op(), list: 'To Do', title, ...extra } as never],
    space,
  )
  if (!res[0].ok) throw new Error(res[0].error)
  return res[0].key!
}

async function complete(key: string) {
  await itemWrite(jose, [{ op: 'complete', op_id: op(), key }])
}

async function size(key: string, value: number | null) {
  await itemWrite(jose, [{ op: 'size', op_id: op(), key, size: value }])
}

async function partOf(key: string, parent: string) {
  const res = await itemWrite(jose, [
    { op: 'set_parent', op_id: op(), key, parent },
  ])
  if (!res[0].ok) throw new Error(res[0].error)
}

async function row(number: number) {
  const { goals } = await goalList(jose, { state: 'all' })
  const found = goals.find((g) => g.number === number)
  if (!found) throw new Error(`no G-${number}`)
  return found
}

describe('numbering and ownership', () => {
  it('numbers goals per workspace and never hands a number out twice', async () => {
    const [a] = await goal(jose, { op: 'create', op_id: 'g1', title: 'One' })
    const [b] = await goal(jose, { op: 'create', op_id: 'g2', title: 'Two' })
    expect(a.ok && a.key).toBe('G-1')
    expect(b.ok && b.key).toBe('G-2')

    await goal(jose, [
      { op: 'archive', op_id: 'a2', goal: 'G-2' },
      { op: 'delete', op_id: 'd2', goal: 2 },
    ])
    const [c] = await goal(jose, { op: 'create', op_id: 'g3', title: 'Three' })
    expect(c.ok && c.key).toBe('G-3')
  })

  it('is owned by whoever creates it, unless an agent does', async () => {
    await goal(jose, { op: 'create', op_id: 'g1', title: 'Mine' })
    await goal(bot, { op: 'create', op_id: 'g2', title: 'Nobody steers this' })
    expect((await row(1)).owner).toBe('jose')
    expect((await row(2)).owner).toBeUndefined()
  })

  it('refuses something that is not a person as owner or follower', async () => {
    const [res] = await goalWrite(jose, [
      { op: 'create', op_id: 'g1', title: 'x', owner: 'claude' },
    ])
    expect(res.ok).toBe(false)
    await goal(jose, { op: 'create', op_id: 'g2', title: 'y' })
    const [follow] = await goalWrite(jose, [
      { op: 'follow', op_id: 'f', goal: 1, add: ['claude'] },
    ])
    expect(follow.ok).toBe(false)
  })

  it('replays an op id rather than creating a second goal', async () => {
    await goal(jose, { op: 'create', op_id: 'same', title: 'Once' })
    await goal(jose, { op: 'create', op_id: 'same', title: 'Once' })
    expect((await goalList(jose, { state: 'all' })).goals).toHaveLength(1)
  })
})

describe('progress', () => {
  it('weighs cards by size, with an unsized card counting as 1', async () => {
    const big = await card('ST', 'Licensing')
    const small = await card('ST', 'Docs page')
    await size(big, 3)
    await goal(jose, {
      op: 'create',
      op_id: 'g',
      title: 'Ship 2.0',
      items: [big, small],
    })
    await complete(small)
    const p = (await row(1)).progress
    expect(p.cards_total).toBe(2)
    expect(p.cards_done).toBe(1)
    expect(p.weight_total).toBe(4)
    expect(p.weight_done).toBe(1)
    expect(p.percent).toBe(25)
  })

  it('counts a card in a done list as done even before it is completed', async () => {
    const key = await card('ST', 'Moved to Done')
    await itemWrite(jose, [{ op: 'move', op_id: op(), key, list: 'Done' }])
    await goal(jose, { op: 'create', op_id: 'g', title: 'x', items: [key] })
    expect((await row(1)).progress.cards_done).toBe(1)
  })

  it('counts every part of a linked card, at any depth, across spaces', async () => {
    const release = await card('ST', 'Release')
    const part = await card('ST', 'Part')
    const deep = await card('CMS', 'Part of the part, elsewhere')
    await partOf(part, release)
    await partOf(deep, part)
    await goal(jose, { op: 'create', op_id: 'g', title: 'x', items: [release] })

    expect((await row(1)).progress.cards_total).toBe(3)
    const detail = (await goalGet(jose, { goals: [1] })).goals[0]
    const items = detail.items as Array<{
      key: string
      linked?: true
      via?: string
    }>
    expect(items.find((i) => i.key === release)?.linked).toBe(true)
    expect(items.find((i) => i.key === deep)?.via).toBe(release)
  })

  it('counts a card once when it is both linked and part of a linked card', async () => {
    const release = await card('ST', 'Release')
    const part = await card('ST', 'Part')
    await partOf(part, release)
    await goal(jose, {
      op: 'create',
      op_id: 'g',
      title: 'x',
      items: [release, part],
    })
    expect((await row(1)).progress.cards_total).toBe(2)
    const items = (await goalGet(jose, { goals: [1] })).goals[0]
      .items as Array<{
      key: string
      linked?: true
      via?: string
    }>
    // It is linked, and says so, rather than claiming to be only a part.
    const shown = items.find((i) => i.key === part)!
    expect(shown.linked).toBe(true)
    expect(shown.via).toBeUndefined()
  })

  it('leaves archived cards out of the count', async () => {
    const a = await card('ST', 'a')
    const b = await card('ST', 'b')
    await goal(jose, { op: 'create', op_id: 'g', title: 'x', items: [a, b] })
    await itemWrite(jose, [{ op: 'archive', op_id: op(), key: b }])
    expect((await row(1)).progress.cards_total).toBe(1)
  })

  it('says how many are moving, waiting and late', async () => {
    const moving = await card('ST', 'moving')
    const waiting = await card('ST', 'waiting')
    const late = await card('ST', 'late', { due: Date.now() - DAY })
    await itemWrite(jose, [
      { op: 'move', op_id: op(), key: moving, list: 'In Progress' },
      { op: 'depends_on', op_id: op(), key: waiting, blocker: moving },
    ])
    await goal(jose, {
      op: 'create',
      op_id: 'g',
      title: 'x',
      items: [moving, waiting, late],
    })
    const p = (await row(1)).progress
    expect(p.cards_active).toBe(1)
    expect(p.cards_waiting).toBe(1)
    expect(p.cards_overdue).toBe(1)
  })

  it('has no percent at all when there is nothing to measure', async () => {
    await goal(jose, { op: 'create', op_id: 'g', title: 'empty' })
    expect((await row(1)).progress.percent).toBeUndefined()
  })
})

describe('sub-goals', () => {
  it('rolls a sub-goal up into its parent, each card once', async () => {
    const a = await card('ST', 'a')
    const b = await card('CMS', 'b')
    await goal(jose, [
      { op: 'create', op_id: 'p', title: 'Parent', items: [a] },
      { op: 'create', op_id: 'c', title: 'Child', parent: 1, items: [a, b] },
    ])
    await complete(b)
    const parent = await row(1)
    expect(parent.sub_goals).toBe(1)
    expect(parent.progress.cards_total).toBe(2)
    expect(parent.progress.cards_done).toBe(1)
  })

  it('leaves a cancelled sub-goal out of its parent', async () => {
    const a = await card('ST', 'a')
    const b = await card('ST', 'b')
    await goal(jose, [
      { op: 'create', op_id: 'p', title: 'Parent', items: [a] },
      { op: 'create', op_id: 'c', title: 'Dropped', parent: 1, items: [b] },
      { op: 'check_in', op_id: 'x', goal: 2, status: 'cancelled' },
    ])
    expect((await row(1)).progress.cards_total).toBe(1)
  })

  it('refuses a loop, including one through the middle of a chain', async () => {
    await goal(jose, [
      { op: 'create', op_id: 'a', title: 'A' },
      { op: 'create', op_id: 'b', title: 'B', parent: 1 },
      { op: 'create', op_id: 'c', title: 'C', parent: 2 },
    ])
    const [self] = await goalWrite(jose, [
      { op: 'set_parent', op_id: 's', goal: 1, parent: 1 },
    ])
    expect(self.ok).toBe(false)
    const [loop] = await goalWrite(jose, [
      { op: 'set_parent', op_id: 'l', goal: 1, parent: 3 },
    ])
    expect(loop.ok).toBe(false)
    expect(!loop.ok && loop.error).toContain('already part of G-1')
  })

  it('lets go of its sub-goals when deleted, and leaves the cards alone', async () => {
    const a = await card('ST', 'a')
    await goal(jose, [
      { op: 'create', op_id: 'p', title: 'Parent', items: [a] },
      { op: 'create', op_id: 'c', title: 'Child', parent: 1 },
    ])
    const [refused] = await goalWrite(jose, [
      { op: 'delete', op_id: 'd0', goal: 1 },
    ])
    expect(refused.ok).toBe(false)
    await goal(jose, [
      { op: 'archive', op_id: 'a', goal: 1 },
      { op: 'delete', op_id: 'd', goal: 1 },
    ])
    expect((await row(2)).parent).toBeUndefined()
    const [item] = (await itemGet(jose, { keys: [a] })).items
    expect(item.key).toBe(a)
    expect(item.goals).toBeUndefined()
  })
})

describe('check-ins', () => {
  it('moves the status and the metric, and keeps the history', async () => {
    await goal(jose, {
      op: 'create',
      op_id: 'g',
      title: 'MRR',
      metric: { name: 'MRR', unit: 'EUR', start: 2000, target: 10000 },
    })
    expect((await row(1)).metric?.percent).toBe(0)
    await goal(jose, {
      op: 'check_in',
      op_id: 'c1',
      goal: 1,
      status: 'at_risk',
      body: 'Slow month',
      metric_value: 4000,
    })
    const r = await row(1)
    expect(r.status).toBe('at_risk')
    expect(r.metric?.current).toBe(4000)
    expect(r.metric?.percent).toBe(25)
    expect(r.last_check_in?.status).toBe('at_risk')
    const detail = (await goalGet(jose, { goals: ['G-1'] })).goals[0]
    expect(detail.check_ins).toHaveLength(1)
  })

  it('refuses a metric value on a goal with no metric', async () => {
    await goal(jose, { op: 'create', op_id: 'g', title: 'x' })
    const [res] = await goalWrite(jose, [
      { op: 'check_in', op_id: 'c', goal: 1, metric_value: 3 },
    ])
    expect(res.ok).toBe(false)
  })

  it('emits a status change only when the status changed', async () => {
    await goal(jose, [
      { op: 'create', op_id: 'g', title: 'x' },
      { op: 'check_in', op_id: 'c1', goal: 1, status: 'on_track' },
      { op: 'check_in', op_id: 'c2', goal: 1, status: 'on_track' },
    ])
    const { events } = await activityQuery(jose, {
      verb: 'goal.status_changed',
      limit: 50,
    })
    expect(events).toHaveLength(1)
    expect(events[0].goal_number).toBe(1)
  })

  it('is edited by its author only, and deleting one does not rewind the status', async () => {
    await goal(jose, { op: 'create', op_id: 'g', title: 'x' })
    const [checkIn] = await goal(ivan, {
      op: 'check_in',
      op_id: 'c',
      goal: 1,
      status: 'off_track',
      body: 'Stuck',
    })
    const id = checkIn.ok ? checkIn.id! : ''
    const [edit] = await goalWrite(jose, [
      {
        op: 'check_in_update',
        op_id: 'e',
        goal: 1,
        check_in_id: id,
        body: 'no',
      },
    ])
    expect(edit.ok).toBe(false)

    const detail = (await goalGet(daniela, { goals: [1] })).goals[0]
    const shown = (detail.check_ins as Array<{ can_edit?: true }>)[0]
    expect(shown.can_edit).toBeUndefined()

    // An admin may remove it. The goal stays where the check-in put it.
    await goal(jose, {
      op: 'check_in_delete',
      op_id: 'd',
      goal: 1,
      check_in_id: id,
    })
    expect((await row(1)).status).toBe('off_track')
  })
})

describe('who hears about it', () => {
  const inbox = async (who: ICtx) => (await notificationList(who)).notifications

  it('tells the owner and followers about a check-in, and not the author', async () => {
    await goal(jose, {
      op: 'create',
      op_id: 'g',
      title: 'x',
      owner: 'ivan',
      followers: ['daniela'],
    })
    await goal(jose, { op: 'check_in', op_id: 'c', goal: 1, status: 'at_risk' })

    const ivanNotes = await inbox(ivan)
    expect(ivanNotes.map((n) => n.verb)).toContain('goal.checked_in')
    expect(
      ivanNotes.find((n) => n.verb === 'goal.checked_in')?.goal_number,
    ).toBe(1)
    expect((await inbox(daniela)).map((n) => n.verb)).toEqual([
      'goal.checked_in',
    ])
    expect(await inbox(jose)).toHaveLength(0)
  })

  it('tells a new owner, and the one it was taken from', async () => {
    await goal(jose, { op: 'create', op_id: 'g', title: 'x', owner: 'ivan' })
    await goal(jose, { op: 'update', op_id: 'u', goal: 1, owner: 'daniela' })
    expect((await inbox(daniela)).map((n) => n.verb)).toContain(
      'goal.owner_changed',
    )
    expect((await inbox(ivan)).map((n) => n.verb)).toContain(
      'goal.owner_changed',
    )
  })

  it('tells somebody named in a check-in', async () => {
    await goal(jose, { op: 'create', op_id: 'g', title: 'x' })
    await goal(jose, {
      op: 'check_in',
      op_id: 'c',
      goal: 1,
      body: 'Waiting on @ivan for numbers',
    })
    const note = (await inbox(ivan))[0]
    expect(note.reason).toBe('mention')
  })

  it('does not ring for an ordinary edit', async () => {
    await goal(jose, {
      op: 'create',
      op_id: 'g',
      title: 'x',
      followers: ['daniela'],
    })
    await goal(jose, { op: 'update', op_id: 'u', goal: 1, title: 'Renamed' })
    expect(await inbox(daniela)).toHaveLength(0)
  })
})

describe('cards and boards', () => {
  it('shows a card the goals it serves, through what it is part of', async () => {
    const release = await card('ST', 'Release')
    const part = await card('ST', 'Part')
    await partOf(part, release)
    await goal(jose, {
      op: 'create',
      op_id: 'g',
      title: 'Ship',
      items: [release],
    })
    const [item] = (await itemGet(jose, { keys: [part] })).items
    expect(item.goals).toEqual([
      { number: 1, key: 'G-1', title: 'Ship', status: 'pending', via: release },
    ])
  })

  it('filters a board to the cards behind a goal, sub-goals and parts included', async () => {
    const release = await card('ST', 'Release')
    const part = await card('ST', 'Part')
    const other = await card('ST', 'Unrelated')
    const viaChild = await card('ST', 'Via the sub-goal')
    const elsewhere = await card('CMS', 'Other board')
    await partOf(part, release)
    await goal(jose, [
      { op: 'create', op_id: 'p', title: 'P', items: [release, elsewhere] },
      { op: 'create', op_id: 'c', title: 'C', parent: 1, items: [viaChild] },
    ])
    const { items } = await spaceGet(jose, {
      space: 'ST',
      goal: 'G-1',
      state: 'open',
      detail: 'compact',
      limit: 100,
    })
    expect(items.map((i) => i.key).sort()).toEqual(
      [release, part, viaChild].sort(),
    )
    expect(items.map((i) => i.key)).not.toContain(other)
  })

  it('unlinks a card that is deleted, rather than failing the delete', async () => {
    const key = await card('ST', 'Doomed')
    await goal(jose, { op: 'create', op_id: 'g', title: 'x', items: [key] })
    await itemWrite(jose, [
      { op: 'archive', op_id: op(), key },
      { op: 'delete', op_id: op(), key },
    ])
    const del = await db.query('SELECT 1 FROM item WHERE key = ?', [key])
    expect(del).toHaveLength(0)
    expect((await row(1)).progress.cards_total).toBe(0)
  })

  it('emits a card event on link, so rules can act on it', async () => {
    const key = await card('ST', 'x')
    await goal(jose, { op: 'create', op_id: 'g', title: 'x' })
    await goal(jose, { op: 'link', op_id: 'l', goal: 1, add: [key] })
    await goal(jose, { op: 'link', op_id: 'l2', goal: 1, add: [key] })
    const { events } = await activityQuery(jose, {
      verb: 'item.goal_linked',
      limit: 50,
    })
    // Linking twice is one link and one event.
    expect(events).toHaveLength(1)
    expect(events[0].item_key).toBe(key)
  })
})

describe('references and the overview', () => {
  it('reads [[goal:12]] and [[goal:G-12]] as the same goal', () => {
    const refs = extractRefs('see [[goal:12]] and [[goal:G-12|the plan]]')
    expect(refs.map((r) => [r.type, r.target])).toEqual([
      ['goal', '12'],
      ['goal', '12'],
    ])
  })

  it('saves a description that names a goal, without indexing it as a link', async () => {
    const key = await card('ST', 'x', { description: 'Serves [[goal:1]]' })
    const links = await db.query<{ ref_type: string }>(
      'SELECT ref_type FROM link',
    )
    expect(links.map((l) => l.ref_type)).not.toContain('goal')
    expect(key).toMatch(/^ST-/)
  })

  it('lists every goal in the overview', async () => {
    await goal(jose, [
      { op: 'create', op_id: 'a', title: 'A' },
      { op: 'create', op_id: 'b', title: 'B', parent: 1 },
    ])
    const { goals } = await workspaceOverview(jose)
    // Through unknown, so toEqual compares the payload as JSON would see it:
    // absent and undefined are the same thing on the wire.
    expect(goals as unknown).toEqual([
      { number: 1, key: 'G-1', title: 'A', status: 'pending' },
      { number: 2, key: 'G-2', title: 'B', status: 'pending', parent: 1 },
    ])
  })
})

describe('the breakdown', () => {
  it('counts goals by status and flags the late and the quiet', async () => {
    await goal(jose, [
      {
        op: 'create',
        op_id: 'a',
        title: 'Late',
        target_date: Date.now() - DAY,
      },
      { op: 'create', op_id: 'b', title: 'Quiet' },
      { op: 'create', op_id: 'c', title: 'Finished' },
      { op: 'check_in', op_id: 'cc', goal: 3, status: 'done' },
    ])
    // Nobody has said a word about G-2 for six weeks.
    await db.run('UPDATE goal SET created_at = ? WHERE number = 2', [
      Date.now() - 42 * DAY,
    ])
    const { goals, summary } = await goalList(jose, { state: 'open' })
    expect(summary.total).toBe(3)
    expect(summary.in_flight).toBe(2)
    expect(summary.by_status.done).toBe(1)
    expect(summary.overdue).toBe(1)
    expect(summary.stale).toBe(1)
    expect(goals.find((g) => g.number === 1)?.overdue).toBe(true)
    expect(goals.find((g) => g.number === 2)?.stale).toBe(true)
    // A goal somebody has finished is never late or quiet.
    expect(goals.find((g) => g.number === 3)?.overdue).toBeUndefined()
  })

  it('reports how far through its window a goal is', async () => {
    await goal(jose, {
      op: 'create',
      op_id: 'g',
      title: 'Halfway',
      start_date: Date.now() - 10 * DAY,
      target_date: Date.now() + 10 * DAY,
    })
    expect((await row(1)).elapsed).toBe(50)
  })

  it('leaves archived goals out of the list and the breakdown', async () => {
    await goal(jose, [
      { op: 'create', op_id: 'a', title: 'A' },
      { op: 'create', op_id: 'b', title: 'B' },
      { op: 'archive', op_id: 'x', goal: 2 },
    ])
    const open = await goalList(jose, { state: 'open' })
    expect(open.goals.map((g) => g.number)).toEqual([1])
    expect(open.summary.total).toBe(1)
    const archived = await goalList(jose, { state: 'archived' })
    expect(archived.goals.map((g) => g.number)).toEqual([2])
  })
})
