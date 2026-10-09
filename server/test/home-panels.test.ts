/**
 * Home's panels beyond Next up, and the layout each person keeps (Jose,
 * 2026-10-09).
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import { docWrite } from '../src/services/docs'
import { goalWrite } from '../src/services/goals'
import {
  docUpdates,
  fallingBehind,
  homeLayoutGet,
  homeLayoutReset,
  homeLayoutSet,
  needsAttention,
} from '../src/services/home'
import type { ICtx } from '../src/core/ctx'

const DAY = 86_400_000
let db: BunSqliteDriver
let jose: ICtx
let ivan: ICtx

const person = (workspaceId: string, id: string, handle: string): ICtx => ({
  db,
  workspaceId,
  actor: {
    id,
    kind: 'human',
    handle,
    role: 'member',
    scopes: ['read', 'write'],
  },
})

beforeEach(async () => {
  db = await openDb(':memory:')
  const ws = await bootstrapWorkspace(db, {
    adminEmail: 'jose@nubisco.io',
    adminHandle: 'jose',
  })
  const joseId = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
  await db.run(
    `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, created_at)
     VALUES ('act_ivan', ?, 'human', 'ivan', 'Ivan Petrov', 'ivan@nubisco.io', 'member', ?)`,
    [ws, Date.now()],
  )
  jose = {
    ...person(ws, joseId, 'jose'),
    actor: {
      ...person(ws, joseId, 'jose').actor,
      role: 'admin',
      scopes: ['read', 'write', 'admin'],
    },
  }
  ivan = person(ws, 'act_ivan', 'ivan')
  await spaceWrite(jose, [
    { op: 'create', op_id: 's', key: 'ST', name: 'ST', template: 'kanban6' },
  ] as never)
  await itemWrite(
    jose,
    [
      {
        op: 'create',
        op_id: 'a',
        list: 'To Do',
        title: 'Mine',
        assignees: ['jose'],
      },
      {
        op: 'create',
        op_id: 'b',
        list: 'To Do',
        title: 'Ivans late one',
        assignees: ['ivan'],
        due: Date.now() - 3 * DAY,
      },
      {
        op: 'create',
        op_id: 'c',
        list: 'In Progress',
        title: 'Stuck',
        assignees: ['ivan'],
      },
    ] as never,
    'ST',
  )
  await db.run("UPDATE item SET updated_at = ? WHERE key = 'ST-3'", [
    Date.now() - 10 * DAY,
  ])
})

describe('falling behind', () => {
  it('names late cards and stuck ones in my spaces, whoever holds them, and late goals', async () => {
    await goalWrite(jose, [
      {
        op: 'create',
        op_id: 'g',
        title: 'Late goal',
        status: 'on_track',
        target_date: Date.now() - 2 * DAY,
      },
    ] as never)
    const got = await fallingBehind(jose)
    expect(got.late.map((c) => [c.key, c.days_late, c.holders])).toEqual([
      ['ST-2', 3, ['ivan']],
    ])
    expect(got.stuck.map((c) => c.key)).toEqual(['ST-3'])
    expect(got.goals.map((g) => g.key)).toEqual(['G-1'])
  })
})

describe('needs your attention', () => {
  it('shows what colleagues did on my cards, one line per card, never my own doing', async () => {
    await itemWrite(ivan, [
      { op: 'comment', op_id: 'c1', key: 'ST-1', body: 'picked this up?' },
      { op: 'comment', op_id: 'c2', key: 'ST-1', body: 'and again' },
      { op: 'comment', op_id: 'c3', key: 'ST-2', body: 'mine' },
    ] as never)
    const got = await needsAttention(jose)
    const st1 = got.entries.find((e) => e.key === 'ST-1')!
    expect(st1.actor).toBe('ivan')
    expect(st1.more).toBe(1)
    // ST-2 was created by jose, so it concerns him too.
    expect(got.entries.map((e) => e.key)).toContain('ST-2')
    expect(
      (await needsAttention(ivan)).entries.every((e) => e.actor !== 'ivan'),
    ).toBe(true)
  })
})

describe('document updates', () => {
  it('lists pages I own that somebody else changed, not my own edits, never hidden ones', async () => {
    await docWrite(jose, [
      {
        op: 'create',
        op_id: 'd',
        slug: 'spec',
        title: 'Spec',
        body: 'v1',
        layout: 'default',
        tags: [],
      },
      {
        op: 'set_visibility',
        op_id: 'v',
        ref: 'spec',
        visibility: 'workspace',
      },
    ] as never)
    expect((await docUpdates(jose)).docs).toEqual([])
    await docWrite(ivan, [
      { op: 'replace', op_id: 'r', ref: 'spec', if_rev: 1, body: 'v2' },
    ] as never)
    const got = await docUpdates(jose)
    expect(got.docs.map((d) => [d.slug, d.why, d.by])).toEqual([
      ['spec', 'owner', 'Ivan Petrov'],
    ])
  })
})

describe('the layout', () => {
  it('is kept per person, validated, and reset', async () => {
    expect(await homeLayoutGet(jose)).toBeNull()
    const layout = {
      version: 1,
      panels: [
        { id: 'goals' },
        { id: 'next-up', wide: true },
        { id: 'spaces', hidden: true },
      ],
    }
    await homeLayoutSet(jose, layout)
    expect(await homeLayoutGet(jose)).toEqual(layout as never)
    expect(await homeLayoutGet(ivan)).toBeNull()
    expect(
      homeLayoutSet(jose, { version: 1, panels: [{ id: 'Bad Id' }] }),
    ).rejects.toThrow('bad home layout')
    await homeLayoutReset(jose)
    expect(await homeLayoutGet(jose)).toBeNull()
  })
})
