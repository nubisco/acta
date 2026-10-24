/**
 * What a space's Settings page reads back (2026-10-24). The page edits the
 * name, the description and the done window through `space_write`, the same
 * op an agent uses, so the board read has to hand the description back, or
 * the page would show an empty box over a space that has one.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { spaceGet } from '../src/services/reads'
import type { ICtx } from '../src/core/ctx'

let db: BunSqliteDriver
let ctx: ICtx

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
    { op: 'create', op_id: 's', key: 'ST', name: 'Studio', template: 'none' },
  ] as never)
})

const read = async () =>
  (
    await spaceGet(ctx, {
      space: 'ST',
      state: 'open',
      detail: 'compact',
      limit: 1,
    })
  ).space

describe('the space read behind Settings', () => {
  it('says nothing about a description the space does not have', async () => {
    const space = await read()
    expect(space.name).toBe('Studio')
    expect('description' in space && space.description).toBeFalsy()
    expect(space.archived).toBeUndefined()
  })

  it('hands back what an update wrote', async () => {
    await spaceWrite(ctx, [
      {
        op: 'update',
        op_id: 'u',
        key: 'ST',
        name: 'Studio work',
        description: 'Everything the studio ships.',
        done_window_days: 30,
      },
    ] as never)
    const space = await read()
    expect(space.name).toBe('Studio work')
    expect(space.description).toBe('Everything the studio ships.')
    expect(space.done_window_days).toBe(30)
  })

  it('says when the space is archived', async () => {
    await spaceWrite(ctx, [{ op: 'archive', op_id: 'a', key: 'ST' }] as never)
    expect((await read()).archived).toBe(true)
  })
})
