/**
 * A board's Done column stops growing for ever (Jose, 2026-10-09).
 *
 * Done cards leave the board once they have been done longer than the
 * space's window (14 days unless set otherwise), or when somebody presses
 * "Clear done now". The clock is when the card became done, never its last
 * edit, so commenting on an old card does not bring it back. Nothing is
 * archived: the cards stay searchable and count toward goals.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import { spaceGet } from '../src/services/reads'
import type { ICtx } from '../src/core/ctx'

let db: BunSqliteDriver
let ctx: ICtx
const DAY = 86_400_000

beforeEach(async () => {
  db = await openDb(':memory:')
  const workspaceId = await bootstrapWorkspace(db, {
    adminEmail: 'jose@nubisco.io',
    adminHandle: 'jose',
  })
  const me = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
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
  await itemWrite(
    ctx,
    [
      { op: 'create', op_id: 'a', list: 'Done', title: 'Old done' },
      { op: 'create', op_id: 'b', list: 'Done', title: 'Fresh done' },
      { op: 'create', op_id: 'c', list: 'To Do', title: 'Open' },
    ] as never,
    'ST',
  )
  // ST-1 has been done for a month.
  await db.run("UPDATE item SET done_at = ? WHERE key = 'ST-1'", [
    Date.now() - 30 * DAY,
  ])
})

const board = async () =>
  spaceGet(ctx, {
    space: 'ST',
    state: 'open',
    detail: 'compact',
    limit: 100,
    done: 'space',
  })

describe('the done window', () => {
  it('stamps a card when it becomes done, and clears the stamp when it is not', async () => {
    const at = async (key: string) =>
      (
        await db.query<{ done_at: number | null }>(
          'SELECT done_at FROM item WHERE key = ?',
          [key],
        )
      )[0].done_at
    expect(await at('ST-2')).toBeGreaterThan(Date.now() - DAY)
    expect(await at('ST-3')).toBeNull()
    await itemWrite(ctx, [
      { op: 'move', op_id: 'm', key: 'ST-3', list: 'Done' },
    ] as never)
    expect(await at('ST-3')).not.toBeNull()
    await itemWrite(ctx, [
      { op: 'move', op_id: 'm2', key: 'ST-2', list: 'To Do' },
    ] as never)
    expect(await at('ST-2')).toBeNull()
  })

  it('leaves out cards done longer ago than 14 days, and says how many', async () => {
    const got = await board()
    expect(got.items.map((i) => i.key).sort()).toEqual(['ST-2', 'ST-3'])
    expect(got.done_hidden).toBe(1)
    expect(got.space.done_window_days).toBe(14)
  })

  it('does not bring a card back for being edited', async () => {
    await itemWrite(ctx, [
      { op: 'comment', op_id: 'c1', key: 'ST-1', body: 'still relevant?' },
      { op: 'update', op_id: 'u1', key: 'ST-1', title: 'Old done, renamed' },
    ] as never)
    expect((await board()).items.map((i) => i.key)).not.toContain('ST-1')
  })

  it('follows the space setting, including showing everything', async () => {
    await spaceWrite(ctx, [
      { op: 'update', op_id: 'w', key: 'ST', done_window_days: 60 },
    ] as never)
    expect((await board()).done_hidden).toBe(0)
    await spaceWrite(ctx, [
      { op: 'update', op_id: 'w2', key: 'ST', done_window_days: null },
    ] as never)
    const got = await board()
    expect(got.items).toHaveLength(3)
    expect(got.done_hidden).toBe(0)
  })

  it('clears everything done so far, at once', async () => {
    await spaceWrite(ctx, [
      { op: 'clear_done', op_id: 'x', key: 'ST' },
    ] as never)
    const got = await board()
    expect(got.items.map((i) => i.key)).toEqual(['ST-3'])
    expect(got.done_hidden).toBe(2)
  })

  it('leaves every other read alone', async () => {
    const all = await spaceGet(ctx, {
      space: 'ST',
      state: 'open',
      detail: 'compact',
      limit: 100,
    } as never)
    expect(all.items).toHaveLength(3)
    expect('done_hidden' in all).toBe(false)
  })
})

describe('priority', () => {
  it('is set, read back on the board and the card, recorded, and cleared', async () => {
    const write = (priority: string | null, id: string) =>
      itemWrite(ctx, [
        { op: 'prioritize', op_id: id, key: 'ST-3', priority },
      ] as never)
    expect((await write('urgent', 'p1'))[0].ok).toBe(true)
    const row = (await board()).items.find((i) => i.key === 'ST-3')
    expect(row?.priority).toBe('urgent')
    const events = await db.query<{ verb: string; summary: string }>(
      "SELECT verb, summary FROM event WHERE verb = 'item.prioritized'",
    )
    expect(events[0].summary).toContain('urgent')
    await write(null, 'p2')
    expect(
      (await board()).items.find((i) => i.key === 'ST-3')?.priority,
    ).toBeUndefined()
  })

  it('refuses anything that is not a priority', async () => {
    const [r] = await itemWrite(ctx, [
      { op: 'prioritize', op_id: 'bad', key: 'ST-3', priority: 'whenever' },
    ] as never)
    expect(r.ok).toBe(false)
  })
})

describe('the list is the status', () => {
  const where = async (key: string) =>
    (
      await db.query<{ list: string; completed: number }>(
        'SELECT l.name AS list, i.completed FROM item i JOIN list l ON l.id = i.list_id WHERE i.key = ?',
        [key],
      )
    )[0]

  it('completing a card puts it in Done, reopening puts it back where it was', async () => {
    await itemWrite(ctx, [
      { op: 'move', op_id: 'r1', key: 'ST-3', list: 'In Progress' },
      { op: 'complete', op_id: 'r2', key: 'ST-3' },
    ] as never)
    expect(await where('ST-3')).toEqual({ list: 'Done', completed: 1 })
    await itemWrite(ctx, [{ op: 'reopen', op_id: 'r3', key: 'ST-3' }] as never)
    expect(await where('ST-3')).toEqual({ list: 'In Progress', completed: 0 })
  })

  it('moving a card in or out of Done is what makes it done or not', async () => {
    await itemWrite(ctx, [
      { op: 'move', op_id: 'm1', key: 'ST-3', list: 'Done' },
    ] as never)
    expect((await where('ST-3')).completed).toBe(1)
    await itemWrite(ctx, [
      { op: 'move', op_id: 'm2', key: 'ST-3', list: 'Backlog' },
    ] as never)
    expect((await where('ST-3')).completed).toBe(0)
  })

  it('reconciles cards that disagreed with their list, once', async () => {
    await db.run("UPDATE item SET completed = 1 WHERE key = 'ST-3'")
    await db.run("UPDATE item SET completed = 0 WHERE key = 'ST-2'")
    await bootstrapWorkspace(db, {
      adminEmail: 'jose@nubisco.io',
      adminHandle: 'jose',
    })
    expect(await where('ST-3')).toEqual({ list: 'Done', completed: 1 })
    expect((await where('ST-2')).completed).toBe(1)
  })
})
