/**
 * Time to first response and time to resolution (LA-370).
 *
 * First response: the first comment, list move, completion or reopening by a
 * person who is not the card's creator. Agents and the system never count.
 * Resolution: reaching a done-role list, or being completed, measured to the
 * last time when a card was reopened. Both read from the event log, and a
 * range is judged on what had happened by its end.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
} from 'bun:test'
import { newId } from '@nubisco/acta-shared'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import { labelWrite } from '../src/services/labels'
import {
  measureCard,
  quantile,
  responseTimes,
} from '../src/services/responseTimes'
import type { ICtx } from '../src/core/ctx'

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Monday 2026-10-19 00:00 UTC, the start of "this week" in these tests. */
const WEEK0 = Date.UTC(2026, 9, 19)

let db: BunSqliteDriver
let jose: ICtx
let ivan: ICtx
let form: ICtx
let rule: ICtx

async function actor(
  workspaceId: string,
  kind: 'human' | 'agent' | 'system',
  handle: string,
): Promise<ICtx> {
  const id = newId('act')
  await db.run(
    `INSERT INTO actor (id, workspace_id, kind, handle, name, role, created_at)
     VALUES (?, ?, ?, ?, ?, 'member', ?)`,
    [id, workspaceId, kind, handle, handle, Date.now()],
  )
  return {
    db,
    workspaceId,
    actor: { id, kind, handle, role: 'member', scopes: ['read', 'write'] },
  }
}

let opSeq = 0
/** A fresh op id: op_log is workspace-wide, so a reused one replays. */
const nextOp = () => `op-${++opSeq}`

/** Run `fn` with the clock at `ts`. */
async function at<T>(ts: number, fn: () => Promise<T>): Promise<T> {
  setSystemTime(new Date(ts))
  return fn()
}

const write = (ctx: ICtx, ops: unknown[]) => itemWrite(ctx, ops as never, 'SU')

async function create(
  ctx: ICtx,
  ts: number,
  opId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const [result] = await at(ts, () =>
    write(ctx, [
      {
        op: 'create',
        op_id: `card-${opId}`,
        title: opId,
        list: 'Inbox',
        ...extra,
      },
    ]),
  )
  if (!result.ok) throw new Error(result.error)
  return result.key as string
}

const comment = (ctx: ICtx, ts: number, key: string) =>
  at(ts, () =>
    write(ctx, [{ op: 'comment', op_id: nextOp(), key, body: 'on it' }]),
  )
const move = (ctx: ICtx, ts: number, key: string, list: string) =>
  at(ts, () => write(ctx, [{ op: 'move', op_id: nextOp(), key, list }]))
const complete = (ctx: ICtx, ts: number, key: string) =>
  at(ts, () => write(ctx, [{ op: 'complete', op_id: nextOp(), key }]))
const reopen = (ctx: ICtx, ts: number, key: string) =>
  at(ts, () => write(ctx, [{ op: 'reopen', op_id: nextOp(), key }]))

const thisWeek = (space = 'SU') =>
  responseTimes(jose, { space, from: WEEK0, to: WEEK0 + 7 * DAY })

beforeEach(async () => {
  setSystemTime(new Date(WEEK0 - 30 * DAY))
  db = await openDb(':memory:')
  const workspaceId = await bootstrapWorkspace(db, {
    adminEmail: 'jose@nubisco.io',
    adminHandle: 'jose',
  })
  const joseId = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
  jose = {
    db,
    workspaceId,
    actor: {
      id: joseId,
      kind: 'human',
      handle: 'jose',
      role: 'admin',
      scopes: ['read', 'write', 'admin'],
    },
  }
  ivan = await actor(workspaceId, 'human', 'ivan')
  form = await actor(workspaceId, 'agent', 'contact-form-support')
  rule = await actor(workspaceId, 'system', 'rules')

  await spaceWrite(jose, [
    { op: 'create', op_id: 's', key: 'SU', name: 'Support' },
    {
      op: 'list_create',
      op_id: 'l1',
      space: 'SU',
      name: 'Inbox',
      role: 'inbox',
    },
    {
      op: 'list_create',
      op_id: 'l2',
      space: 'SU',
      name: 'Triaging',
      role: 'active',
    },
    { op: 'list_create', op_id: 'l3', space: 'SU', name: 'Done', role: 'done' },
    // A space whose only way to say done is the completed flag.
    { op: 'create', op_id: 's2', key: 'NO', name: 'No done list' },
    {
      op: 'list_create',
      op_id: 'l4',
      space: 'NO',
      name: 'Inbox',
      role: 'inbox',
    },
    {
      op: 'list_create',
      op_id: 'l5',
      space: 'NO',
      name: 'Doing',
      role: 'active',
    },
  ] as never)
  await labelWrite(jose, [
    { op: 'group_create', op_id: 'g', name: 'Need', exclusive: true },
    {
      op: 'label_create',
      op_id: 'b',
      group: 'Need',
      name: 'Bug report',
      color: 'red',
    },
    {
      op: 'label_create',
      op_id: 'p',
      group: 'Need',
      name: 'Pre-sales',
      color: 'purple',
    },
  ] as never)
})

afterEach(() => {
  setSystemTime()
})

describe('first response', () => {
  it('is the first comment by a person who is not the creator, and agents never count', async () => {
    const key = await create(form, WEEK0 + HOUR, 'a')
    // The form, and an assistant, talking to the card is not an answer.
    await comment(form, WEEK0 + 2 * HOUR, key)
    await move(rule, WEEK0 + 2 * HOUR, key, 'Triaging')
    await comment(ivan, WEEK0 + 4 * HOUR, key)
    await comment(jose, WEEK0 + 5 * HOUR, key)

    const report = await thisWeek()
    expect(report.spaces[0].all.first_response).toEqual({
      count: 1,
      median_ms: 3 * HOUR,
      p90_ms: 3 * HOUR,
    })
    expect(report.spaces[0].all.received).toBe(1)
    expect(report.spaces[0].all.unanswered).toBe(0)
  })

  it('ignores the creator, even when the creator is a person', async () => {
    const key = await create(jose, WEEK0 + HOUR, 'b')
    await comment(jose, WEEK0 + 2 * HOUR, key)
    await move(jose, WEEK0 + 3 * HOUR, key, 'Triaging')
    expect((await thisWeek()).spaces[0].all.first_response.count).toBe(0)
    expect((await thisWeek()).spaces[0].all.unanswered).toBe(1)

    await move(ivan, WEEK0 + 6 * HOUR, key, 'Inbox')
    expect((await thisWeek()).spaces[0].all.first_response.median_ms).toBe(
      5 * HOUR,
    )
  })

  it('counts a move between lists, and not a reorder inside one', async () => {
    const key = await create(form, WEEK0, 'c')
    await at(WEEK0 + HOUR, () =>
      write(ivan, [{ op: 'move', op_id: 'r', key, list: 'Inbox', pos: 1 }]),
    )
    expect((await thisWeek()).spaces[0].all.first_response.count).toBe(0)
    await move(ivan, WEEK0 + 2 * HOUR, key, 'Triaging')
    expect((await thisWeek()).spaces[0].all.first_response.median_ms).toBe(
      2 * HOUR,
    )
  })

  it('counts closing a request as answering it', async () => {
    const key = await create(form, WEEK0, 'd')
    await complete(ivan, WEEK0 + 7 * HOUR, key)
    const all = (await thisWeek()).spaces[0].all
    expect(all.first_response.median_ms).toBe(7 * HOUR)
    expect(all.resolution.median_ms).toBe(7 * HOUR)
  })

  it('reads the older event shape, which named the list and nothing else', async () => {
    const reorder = await create(form, WEEK0, 'e')
    const moved = await create(form, WEEK0, 'f')
    await move(ivan, WEEK0 + HOUR, reorder, 'Inbox')
    await move(ivan, WEEK0 + 2 * HOUR, moved, 'Done')
    // As written before list ids were recorded.
    await db.run(
      `UPDATE event SET payload = json_remove(json_remove(json_remove(payload, '$.to_list'), '$.from_list'), '$.list_id')
        WHERE verb IN ('item.created', 'item.moved')`,
    )
    const all = (await thisWeek()).spaces[0].all
    expect(all.first_response.count).toBe(1)
    expect(all.first_response.median_ms).toBe(2 * HOUR)
    expect(all.resolution.median_ms).toBe(2 * HOUR)
  })
})

describe('resolution', () => {
  it('is the move to a done-role list, by anyone', async () => {
    const key = await create(form, WEEK0, 'g')
    await move(rule, WEEK0 + 9 * HOUR, key, 'Done')
    const all = (await thisWeek()).spaces[0].all
    expect(all.resolution).toEqual({
      count: 1,
      median_ms: 9 * HOUR,
      p90_ms: 9 * HOUR,
    })
    expect(all.first_response.count).toBe(0)
  })

  it('runs to the last resolution when a card is reopened, reopened stretch included', async () => {
    const key = await create(form, WEEK0, 'h')
    await complete(ivan, WEEK0 + HOUR, key)
    await reopen(jose, WEEK0 + 2 * HOUR, key)
    // Between the reopening and the second resolution, it is not resolved.
    const midway = await responseTimes(jose, {
      space: 'SU',
      from: WEEK0,
      to: WEEK0 + 5 * HOUR,
    })
    expect(midway.spaces[0].all.resolution.count).toBe(0)

    await move(ivan, WEEK0 + 10 * HOUR, key, 'Done')
    const all = (await thisWeek()).spaces[0].all
    expect(all.resolution).toEqual({
      count: 1,
      median_ms: 10 * HOUR,
      p90_ms: 10 * HOUR,
    })
  })

  it('leaves a past range alone when the card is reopened later', async () => {
    const key = await create(form, WEEK0, 'i')
    await complete(ivan, WEEK0 + HOUR, key)
    const before = await thisWeek()
    await reopen(jose, WEEK0 + 8 * DAY, key)
    expect(await thisWeek()).toEqual(before)
    expect(before.spaces[0].all.resolution.count).toBe(1)
  })

  it('does not credit a card created already done', async () => {
    await create(ivan, WEEK0, 'j', { list: 'Done' })
    const all = (await thisWeek()).spaces[0].all
    expect(all.resolution.count).toBe(0)
    expect(all.received).toBe(1)
  })

  it('is completion alone in a space without a done list', async () => {
    const [made] = await at(WEEK0, () =>
      itemWrite(
        form,
        [{ op: 'create', op_id: 'k', title: 'k', list: 'Inbox' }] as never,
        'NO',
      ),
    )
    const key = (made as { key: string }).key
    await at(WEEK0 + HOUR, () =>
      itemWrite(ivan, [
        { op: 'move', op_id: 'm', key, list: 'Doing' },
      ] as never),
    )
    expect((await thisWeek('NO')).spaces[0].all.resolution.count).toBe(0)
    await complete(ivan, WEEK0 + 3 * HOUR, key)
    expect((await thisWeek('NO')).spaces[0].all.resolution.median_ms).toBe(
      3 * HOUR,
    )
  })
})

describe('the report', () => {
  it('gives median and 90th percentile per label, over the range the response happened in', async () => {
    // Five bug reports answered after 1 to 5 hours, one pre-sales question
    // after 10, one bug report still waiting.
    for (const hours of [1, 2, 3, 4, 5]) {
      const key = await create(form, WEEK0 + DAY, `bug${hours}`, {
        labels: ['Need/Bug report'],
      })
      await comment(ivan, WEEK0 + DAY + hours * HOUR, key)
    }
    const sales = await create(form, WEEK0 + DAY, 'sales', {
      labels: ['Need/Pre-sales'],
    })
    await comment(jose, WEEK0 + DAY + 10 * HOUR, sales)
    await create(form, WEEK0 + 2 * DAY, 'waiting', {
      labels: ['Need/Bug report'],
    })
    // Last week's card answered this week counts this week, and was not
    // received this week.
    const old = await create(form, WEEK0 - 2 * DAY, 'old', {
      labels: ['Need/Bug report'],
    })
    await comment(ivan, WEEK0 + HOUR, old)

    const report = await thisWeek()
    expect(report.from).toBe(WEEK0)
    expect(report.to).toBe(WEEK0 + 7 * DAY)
    const [space] = report.spaces
    expect(space.key).toBe('SU')
    const bug = space.labels.find((l) => l.name === 'Bug report')!
    expect(bug.group).toBe('Need')
    expect(bug.received).toBe(6)
    expect(bug.unanswered).toBe(1)
    // 1, 2, 3, 4, 5 and 49 hours.
    expect(bug.first_response.count).toBe(6)
    expect(bug.first_response.median_ms).toBe(3.5 * HOUR)
    expect(bug.first_response.p90_ms).toBe(27 * HOUR)
    const presales = space.labels.find((l) => l.name === 'Pre-sales')!
    expect(presales.first_response.median_ms).toBe(10 * HOUR)
    expect(space.all.first_response.count).toBe(7)
    expect(space.all.received).toBe(7)

    // Last week saw only the card that was received then, unanswered.
    const last = await responseTimes(jose, {
      space: 'SU',
      from: WEEK0 - 7 * DAY,
      to: WEEK0,
    })
    expect(last.spaces[0].all).toEqual({
      received: 1,
      unanswered: 1,
      first_response: { count: 0, median_ms: null, p90_ms: null },
      resolution: { count: 0, median_ms: null, p90_ms: null },
    })
  })

  it('covers every space with something to say when none is named', async () => {
    const key = await create(form, WEEK0, 'x')
    await comment(ivan, WEEK0 + HOUR, key)
    const report = await responseTimes(jose, {
      from: WEEK0,
      to: WEEK0 + 7 * DAY,
    })
    expect(report.spaces.map((s) => s.key)).toEqual(['SU'])
  })

  it('defaults to the seven days up to now', async () => {
    setSystemTime(new Date(WEEK0))
    const report = await responseTimes(jose, { space: 'SU' })
    expect(report.to).toBe(WEEK0 + 1)
    expect(report.from).toBe(WEEK0 + 1 - 7 * DAY)
  })

  it('refuses a range that ends before it starts, and a space that does not exist', async () => {
    const failure = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (err: unknown) => (err as Error).message,
      )
    expect(
      await failure(
        responseTimes(jose, { space: 'SU', from: WEEK0, to: WEEK0 }),
      ),
    ).toBe('from must be before to')
    expect(await failure(responseTimes(jose, { space: 'ZZ' }))).toBe(
      'space ZZ not found',
    )
  })

  it("reads each card's events through the index", async () => {
    const plan = await db.query<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT e.ts FROM item i JOIN event e ON e.entity_id = i.id
        WHERE i.workspace_id = ? AND i.space_id = ? AND i.created_at < ? AND e.entity = 'item' AND e.ts < ?`,
      ['w', 's', 1, 1],
    )
    expect(plan.map((p) => p.detail).join('\n')).toContain('idx_event_entity')
  })
})

describe('the measurement', () => {
  const roleOf = (id: string | undefined, name: string | undefined) =>
    id === 'done' || name === 'Done' ? 'done' : 'active'
  const ev = (
    ts: number,
    verb: string,
    actor: string,
    kind: string,
    payload?: unknown,
  ) => ({
    ts,
    verb,
    actor_id: actor,
    actor_kind: kind,
    payload: payload ? JSON.stringify(payload) : null,
  })

  it('never lets an agent acting for a person stand in for them', () => {
    const out = measureCard(
      { created_by: 'form', has_done_list: true },
      [
        ev(0, 'item.created', 'form', 'agent', {
          list: 'Inbox',
          list_id: 'inbox',
        }),
        ev(5, 'comment.created', 'assistant', 'agent'),
        ev(9, 'comment.created', 'ivan', 'human'),
      ],
      roleOf,
    )
    expect(out.first_response_at).toBe(9)
  })

  it('resolves again after being moved out of done and back', () => {
    const out = measureCard(
      { created_by: 'form', has_done_list: true },
      [
        ev(0, 'item.created', 'form', 'agent', {
          list: 'Inbox',
          list_id: 'inbox',
        }),
        ev(1, 'item.moved', 'ivan', 'human', {
          list: 'Done',
          to_list: 'done',
          from_list: 'inbox',
        }),
        ev(2, 'item.moved', 'ivan', 'human', {
          list: 'Inbox',
          to_list: 'inbox',
          from_list: 'done',
        }),
        ev(3, 'item.moved', 'ivan', 'human', {
          list: 'Done',
          to_list: 'done',
          from_list: 'inbox',
        }),
      ],
      roleOf,
    )
    expect(out).toEqual({ first_response_at: 1, resolved_at: 3 })
  })

  it('interpolates percentiles between neighbours', () => {
    expect(quantile([], 0.5)).toBeNull()
    expect(quantile([7], 0.9)).toBe(7)
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(3)
    expect(quantile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9)).toBe(91)
  })
})
